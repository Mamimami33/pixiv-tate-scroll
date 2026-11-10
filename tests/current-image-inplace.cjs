// The existing pixiv <img> stays on-screen while trained CNN enhances it.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const source=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
assert.match(source, /@grant\s+GM\.xmlHttpRequest/);
assert.match(source, /@inject-into\s+content/);
assert(!/function (?:startCustomFeed|startSearchFeed)\s*\(/.test(source));
(async()=>{
  const browser=await chromium.launch({
    executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',
    headless:true,args:['--no-sandbox','--enable-webgl','--use-gl=angle',
      '--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto('about:blank');
    const png=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=100;c.height=100;
      const ctx=c.getContext('2d');
      ctx.fillStyle='#456';ctx.fillRect(0,0,100,100);
      ctx.fillStyle='#f9c';ctx.fillRect(18,20,60,56);
      ctx.strokeStyle='#223';ctx.lineWidth=3;ctx.strokeRect(25,25,50,50);
      return c.toDataURL('image/png').split(',')[1];
    });
    const bytes=Buffer.from(png,'base64');
    const url='https://i.pximg.net/img-original/img/2026/11/11/00/00/00/123_p0.png';
    const network=[];
    await page.route('**/*',route=>{
      network.push(route.request().url());
      if(route.request().url()===url)
        return route.fulfill({contentType:'image/png',body:bytes});
      if(route.request().url().includes('/artworks/123'))
        return route.fulfill({contentType:'text/html',body:
          '<html><body style="margin:0;height:2200px"><img id="original" src="'+url+
          '" style="position:absolute;top:200px;left:20px;width:350px;height:350px;object-fit:contain"></body></html>'});
      return route.abort();
    });
    await page.goto('https://www.pixiv.net/artworks/123');
    await page.waitForFunction(()=>document.querySelector('#original')?.complete &&
      document.querySelector('#original').naturalWidth===100);
    await page.evaluate(bytes=>{
      window.__gmFetchCount=0;
      window.__gmLastOptions=null;
      window.GM={xmlHttpRequest(opts){
        window.__gmFetchCount++;
        window.__gmLastOptions=opts;
        const p=Promise.resolve({status:200,response:new Uint8Array(bytes).buffer});
        p.abort=()=>{};
        return p;
      }};
    },[...bytes]);
    await page.addScriptTag({content:source});
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),0,'zero privileged GET on load');
    assert.equal(network.filter(x=>x.includes('/ajax/')).length,0,'zero API GET on load');
    await page.locator('#pts-only-launch').click();
    const canvas=page.locator('#pts-only-inplace-canvas');
    await canvas.waitFor({state:'attached',timeout:30000});
    assert.deepEqual(await canvas.evaluate(c=>[c.width,c.height]),[200,200],
      'trained CNN generates 2x source');
    assert(await page.locator('#original').isVisible(),'original pixiv image remains in page');
    assert(await page.locator('#pts-only-overlay').evaluate(c=>c.classList.contains('pts-only-compact')),
      'controls are compact, not a replacement viewer');
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),1,'one explicit CDN GET');
    const opts=await page.evaluate(()=>({
      url:window.__gmLastOptions.url,
      referer:window.__gmLastOptions.headers.Referer,
      type:window.__gmLastOptions.responseType
    }));
    assert.equal(opts.url,url,'only active artwork CDN URL is requested');
    assert.equal(opts.type,'arraybuffer');
    assert.equal(opts.referer,'https://www.pixiv.net/');
    assert.equal(network.filter(x=>x.includes('/ajax/')).length,0,'no metadata call');
    const before=await canvas.evaluate(c=>parseInt(c.style.top,10));
    await page.locator('#pts-only-current-compare').click();
    assert.equal(await canvas.evaluate(c=>c.style.display),'none','original is shown');
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),1,'comparison does not refetch');
    await page.locator('#pts-only-current-compare').click();
    assert.equal(await canvas.evaluate(c=>c.style.display),'block','AI result is restored');
    await page.evaluate(()=>window.scrollBy(0,80));
    await page.waitForFunction(previous=>{
      const c=document.querySelector('#pts-only-inplace-canvas');
      return c && parseInt(c.style.top,10)<previous;
    },before);
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),1,'scroll never refetches');
    await page.locator('#pts-only-close').click();
    assert.equal(await canvas.count(),0,'closing removes GPU canvas');
    console.log('PASS current pixiv in-place trained AI: one explicit CDN GET, zero metadata, original preserved, compare, scroll, cleanup');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
