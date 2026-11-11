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
      if(route.request().url()===url || route.request().url().includes('unusual-name-master1200.jpg'))
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
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),0,
      'launch must never cause a CDN fetch before explicit action');
    assert.equal(await page.locator('#pts-only-inplace-canvas').count(),0,
      'launch never starts GPU processing implicitly');
    assert.equal(await page.locator('#pts-only-target-outline').count(),1,
      'current selected page image has a visible frame');
    assert.match(await page.locator('#pts-only-status').innerText(),/画面中央の枠で囲んだ画像/);
    assert.match(await page.locator('#pts-only-launch').innerText(),/操作受付済 α7/);
    await page.locator('#pts-only-current').click();
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
    // Pixiv can use a CDN image URL without a visible "123_p0" filename.
    // Ensure that the current large artwork is still selected.
    await page.evaluate(()=>{
      const img=document.querySelector('#original');
      img.src='https://i.pximg.net/img-master/img/2026/11/11/00/00/00/unusual-name-master1200.jpg';
    });
    await page.waitForFunction(()=>document.querySelector('#original')?.complete&&
      document.querySelector('#original').naturalWidth===100);
    // Respect the explicit 5-second pixiv CDN cooldown between separate images.
    await page.waitForTimeout(5100);
    await page.locator('#pts-only-current').click();
    await page.waitForFunction(()=>!!document.querySelector('#pts-only-inplace-canvas'),null,{timeout:30000});
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),2,
      'the newly visible artwork CDN variant is processed by explicit request');
    // Even after the network path is forbidden, a saved file must still
    // enhance the CURRENT pixiv artwork in-place with zero new CDN GETs.
    await page.evaluate(()=>{
      window.GM.xmlHttpRequest=opts=>{
        window.__gmFetchCount++;
        const p=Promise.resolve({status:403,response:null});
        p.abort=()=>{};
        return p;
      };
      document.querySelector('#original').src=
        'https://i.pximg.net/img-master/img/2026/11/11/00/00/00/123_p2_master1200.jpg';
    });
    await page.route('**/*',route=>{
      if(route.request().url().includes('123_p2_master1200.jpg'))
        return route.fulfill({contentType:'image/png',body:bytes});
      return route.continue();
    });
    await page.waitForFunction(()=>document.querySelector('#original')?.complete&&
      document.querySelector('#original').naturalWidth===100);
    await page.waitForTimeout(5100);
    await page.locator('#pts-only-current').click();
    await page.waitForFunction(()=>document.querySelector('#pts-only-status')?.textContent.includes('HTTP 403'),
      null,{timeout:10000});
    const forbiddenCount=await page.evaluate(()=>window.__gmFetchCount);
    const fileChooser=page.waitForEvent('filechooser');
    await page.locator('#pts-only-local-overlay').click();
    const chooser=await fileChooser;
    await chooser.setFiles({name:'saved.png',mimeType:'image/png',buffer:bytes});
    await page.waitForFunction(()=>document.querySelector('#pts-only-status')?.textContent.includes('AI超解像を適用しました'),
      null,{timeout:30000});
    assert.equal(await page.evaluate(()=>window.__gmFetchCount),forbiddenCount,
      'local file must not make a CDN request even after HTTP 403');
    assert.equal(await canvas.count(),1,'file CNN is overlaid on current pixiv image');
    assert(await page.locator('#original').isVisible(),'pixiv original remains');
    await page.locator('#pts-only-close').click();
    assert.equal(await canvas.count(),0,'closing removes GPU canvas');
    console.log('PASS current pixiv in-place trained AI: one explicit CDN GET, zero metadata, original preserved, compare, scroll, cleanup');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
