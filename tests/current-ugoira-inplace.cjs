// Synthetic, in-place ugoira test. No live Pixiv traffic.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const source=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
function zipStored(names,files){
  const local=[],central=[];let cursor=0;
  for(let i=0;i<names.length;i++){
    const name=Buffer.from(names[i]),data=files[i];
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);
    h.writeUInt16LE(20,4);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);
    h.writeUInt16LE(name.length,26);local.push(h,name,data);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);
    c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);
    c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);
    c.writeUInt16LE(name.length,28);c.writeUInt32LE(cursor,42);
    central.push(c,name);cursor+=h.length+name.length+data.length;
  }
  const cd=Buffer.concat(central),eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(names.length,8);eocd.writeUInt16LE(names.length,10);
  eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(cursor,16);
  return Buffer.concat([...local,cd,eocd]);
}
(async()=>{
  const browser=await chromium.launch({
    executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',headless:true,
    args:['--no-sandbox','--enable-webgl','--use-gl=angle',
      '--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto('about:blank');
    const images=await page.evaluate(()=>[0,6].map(shift=>{
      const c=document.createElement('canvas');c.width=96;c.height=96;
      const ctx=c.getContext('2d');
      ctx.fillStyle='#203040';ctx.fillRect(0,0,96,96);
      ctx.fillStyle='#ebcba3';ctx.fillRect(12+shift,17,62,62);
      ctx.strokeStyle='#050607';ctx.lineWidth=3;ctx.strokeRect(30+shift,27,34,40);
      return c.toDataURL('image/png').split(',')[1];
    }));
    const zip=zipStored(['000000.png','000001.png'],images.map(x=>Buffer.from(x,'base64')));
    const requests=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{
      const url=route.request().url();requests.push(url);
      if(url.endsWith('/artworks/123')){
        return route.fulfill({contentType:'text/html',
          body:'<html><body style="height:1800px;margin:0"><canvas id="pixiv-player" width="96" height="96" style="position:absolute;top:170px;left:30px;width:330px;height:330px"></canvas></body></html>'});
      }
      if(url.endsWith('/ajax/illust/123'))
        return route.fulfill({contentType:'application/json',
          body:JSON.stringify({error:false,body:{illustType:2,urls:{}}})});
      if(url.endsWith('/ajax/illust/123/ugoira_meta'))
        return route.fulfill({contentType:'application/json',
          body:JSON.stringify({error:false,body:{
            originalSrc:'https://i.pximg.net/ugoira/123.zip',
            frames:[{file:'000000.png',delay:100},{file:'000001.png',delay:100}]
          }})});
      if(url.endsWith('/ugoira/123.zip'))
        return route.fulfill({status:200,headers:{'access-control-allow-origin':'*',
          'content-type':'application/zip'},body:zip});
      return route.abort();
    });
    await page.goto('https://www.pixiv.net/artworks/123');
    await page.addScriptTag({content:source});
    assert.equal(requests.filter(x=>x.includes('/ajax/')).length,0,'no unrequested API');
    await page.locator('#pts-only-launch').click();
    assert(await page.locator('#pts-only-overlay').evaluate(el=>el.classList.contains('pts-only-compact')));
    await page.locator('#pts-only-artwork').click();
    const host=page.locator('#pts-only-motion-surface');
    await host.waitFor({state:'attached',timeout:20000});
    assert(await page.locator('#pixiv-player').isVisible(),'original Pixiv player remains in DOM');
    assert(await page.locator('#pts-only-overlay').evaluate(el=>el.classList.contains('pts-only-compact')),
      'the control panel remains small; no fullscreen replacement viewer');
    assert.equal(requests.filter(x=>x.endsWith('/ajax/illust/123')).length,1);
    assert.equal(requests.filter(x=>x.endsWith('/ajax/illust/123/ugoira_meta')).length,1);
    assert.equal(requests.filter(x=>x.endsWith('/ugoira/123.zip')).length,1);
    await page.locator('#pts-only-current-motion').click();
    assert.equal(await page.locator('#pts-only-current-motion').textContent(),'動き補間: ON');
    await page.waitForFunction(()=>!!document.querySelector('#pts-only-motion-surface .pts-ugoira-motion-canvas'),
      null,{timeout:15000});
    const c=page.locator('#pts-only-motion-surface .pts-ugoira-motion-canvas');
    assert((await c.evaluate(el=>el.width))>=96,'rendered WebGL interpolation canvas');
    const before=await host.evaluate(el=>parseInt(el.style.top,10));
    await page.evaluate(()=>window.scrollBy(0,70));
    await page.waitForFunction(prev=>{
      const el=document.querySelector('#pts-only-motion-surface');
      return el&&parseInt(el.style.top,10)<prev;
    },before);
    await page.locator('#pts-only-close').click();
    assert.equal(await host.count(),0,'the processed layer is released');
    assert(await page.locator('#pixiv-player').isVisible(),'native player preserved after close');
    assert.deepEqual(errors,[]);
    console.log('PASS ugoira in-place playback: original player remains, one ZIP, two JSON, working interpolation, scroll tracking, cleanup');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
