// No real Pixiv requests. Covers multi-page manga selection and Safari-like touch event.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const useWebKit=process.env.BROWSER_ENGINE==='webkit';
const source=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
(async()=>{
 const browser=await (useWebKit?webkit:chromium).launch({
   headless:true,
   ...(useWebKit?{}:{
     executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',
     args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader']
   })
 });
 try{
   const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
   // about:blank is available without any network. Build a tiny fake PNG locally.
   const img=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64');
   const requests=[];
   await page.route('**/*',route=>{
      const u=route.request().url();requests.push(u);
      if(u.endsWith('/artworks/123'))return route.fulfill({contentType:'text/html',body:
        '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>'+
        '<body style="margin:0;height:1700px;background:#333">'+
        '<img id="page0" src="https://i.pximg.net/img-master/img/2026/11/11/123_p0_master1200.jpg" '+
          'style="position:absolute;top:100px;left:10px;width:370px;height:570px">'+
        '<img id="page1" src="https://i.pximg.net/img-master/img/2026/11/11/123_p1_master1200.jpg" '+
          'style="position:absolute;top:700px;left:10px;width:370px;height:570px">'+
        '</body></html>'});
      if(u.includes('i.pximg.net'))return route.fulfill({contentType:'image/png',body:img});
      return route.abort();
   });
   await page.goto('https://www.pixiv.net/artworks/123');
   await page.waitForFunction(()=>[...document.images].every(x=>x.complete&&x.naturalWidth));
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.addScriptTag({content:source});
   const button=page.locator('#pts-only-launch');
   assert.match(await button.innerText(),/alpha\.5|α5/);
   // Safari-like pointerup must open panel without any image CDN API fetch.
   await button.evaluate(el=>el.dispatchEvent(new PointerEvent('pointerup',{
      bubbles:true,cancelable:true,pointerType:'touch'
   })));
   assert(await page.locator('#pts-only-overlay').isVisible(),'touch opens controls immediately');
   assert.match(await button.innerText(),/操作受付済/);
   assert.match(await page.locator('#pts-only-status').innerText(),/画面中央の枠で囲んだ画像/);
   assert.equal(await page.locator('#pts-only-inplace-canvas').count(),0,'no AI before explicit action');
   assert.equal(requests.filter(x=>x.includes('/ajax/')).length,0,'no metadata requests on touch');
   const first=await page.locator('#pts-only-target-outline').boundingBox();
   const firstImg=await page.locator('#page0').boundingBox();
   assert(Math.abs(first.y-firstImg.y)<2,'first page selected');
   // Scroll to the next manga page; selection tracks the image on screen.
   await page.evaluate(()=>window.scrollTo(0,600));
   await page.locator('#pts-only-diagnose').click();
   const second=await page.locator('#pts-only-target-outline').boundingBox();
   const secondImg=await page.locator('#page1').boundingBox();
   assert(Math.abs(second.y-secondImg.y)<2,'next page selected after scroll');
   assert.equal(requests.filter(x=>x.includes('/ajax/')).length,0);
   await page.locator('#pts-only-close').click();
   assert.equal(await page.locator('#pts-only-target-outline').count(),0,'outline cleanup');
   assert.deepEqual(errors,[],'zero browser JS exceptions');
   console.log('PASS '+(useWebKit?'WebKit':'Chromium')+' manga current-page selection: mobile touch, immediate panel, proper image target, scroll follows, no extra requests');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
