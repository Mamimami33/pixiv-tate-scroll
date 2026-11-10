// Run: node tests/enhance-only.cjs
// Entirely synthetic images/ZIP. No requests to the live pixiv service.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {chromium}=require('playwright');
const source=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
assert.match(source, /@version\s+4\.0\.0-alpha\.2/);
assert.match(source, /const AI_CNN_MODEL_PASSES/);
assert.match(source, /function estimateUgoiraMotion/);
assert(!/function (?:startCustomFeed|startSearchFeed|fetchBookmarkRelatedCandidates|tasteScore)\s*\(/.test(source),
  'feed/search/bookmark/recommendation engines removed');
assert.equal((source.match(/fetchPixivJson\(/g)||[]).length,3,
  'metadata endpoint only used for explicit artwork and ugoira lookups');

const pngData=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64');
function zipStored(names,files,deflate=false) {
  const local=[],central=[];let cursor=0;
  for(let i=0;i<names.length;i++){
    const name=Buffer.from(names[i],'utf8'),uncompressed=files[i];
    const data=deflate?zlib.deflateRawSync(uncompressed):uncompressed;
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);
    h.writeUInt16LE(20,4);h.writeUInt16LE(deflate?8:0,8);h.writeUInt32LE(data.length,18);
    h.writeUInt32LE(uncompressed.length,22);h.writeUInt16LE(name.length,26);
    local.push(h,name,data);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);
    c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);
    c.writeUInt16LE(deflate?8:0,10);c.writeUInt32LE(data.length,20);
    c.writeUInt32LE(uncompressed.length,24);c.writeUInt16LE(name.length,28);
    c.writeUInt32LE(cursor,42);central.push(c,name);
    cursor+=h.length+name.length+data.length;
  }
  const centralBytes=Buffer.concat(central),eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(names.length,8);eocd.writeUInt16LE(names.length,10);
  eocd.writeUInt32LE(centralBytes.length,12);eocd.writeUInt32LE(cursor,16);
  return Buffer.concat([...local,centralBytes,eocd]);
}
(async()=>{
  const browser=await chromium.launch({
    executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',
    headless:true,args:['--no-sandbox','--enable-webgl',
      '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const requests=[],errors=[];
    let motionPNGs=[pngData,pngData];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>{
      requests.push(r.request().url());
      const pathname=new URL(r.request().url()).pathname;
      if(pathname==='/ajax/illust/123')
        return r.fulfill({contentType:'application/json',
          body:JSON.stringify({error:false,body:{
            id:'123',illustType:2,urls:{},pageCount:1
          }})});
      if(pathname==='/ajax/illust/123/ugoira_meta')
        return r.fulfill({contentType:'application/json',
          body:JSON.stringify({error:false,body:{
            frames:[{file:'000000.png',delay:100},{file:'000001.png',delay:100}],
            originalSrc:'https://i.pximg.net/test/ugoira.zip'
          }})});
      if(pathname==='/test/ugoira.zip')
        return r.fulfill({status:200,headers:{'access-control-allow-origin':'*',
            'content-type':'application/zip'},body:zipStored(
              ['000000.png','000001.png'],motionPNGs,true)});
      return r.fulfill({contentType:'text/html',body:'<html><body>mock pixiv</body></html>'});
    });
    await page.goto('https://www.pixiv.net/artworks/123');
    await page.addScriptTag({content:source});
    assert.equal(await page.locator('#pts-only-launch').count(),1);
    assert.equal(requests.filter(x=>x.includes('/ajax/')).length,0,'no automatic pixiv API calls');
    await page.locator('#pts-only-launch').click();
    assert(await page.locator('#pts-only-overlay').isVisible());
    assert.equal(await page.locator('#pts-only-overlay .pts-feed').count(),0,'no scrolling feed');
    // Local still image -> genuine trained CNN x2 (WebGL2). Create PNG in the browser.
    const pngPair=await page.evaluate(()=>[0,3].map(shift=>{
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#122';ctx.fillRect(0,0,64,64);
      ctx.fillStyle='#fcb';ctx.fillRect(8+shift,8,48,48);
      ctx.fillStyle='#123';ctx.fillRect(15+shift,15,32,32);
      return canvas.toDataURL('image/png').split(',')[1];
    }));
    const png=pngPair[0];
    motionPNGs=pngPair.map(t=>Buffer.from(t,'base64'));
    const fc1=page.waitForEvent('filechooser');
    await page.locator('#pts-only-file').click();
    await (await fc1).setFiles({name:'test.png',mimeType:'image/png',
      buffer:Buffer.from(png,'base64')});
    await page.waitForSelector('#pts-only-stage img.pts-only-image');
    await page.locator('#pts-only-upscale').click();
    await page.waitForSelector('#pts-only-stage canvas.pts-only-enhanced');
    const size=await page.locator('#pts-only-stage canvas.pts-only-enhanced').evaluate(
      el=>[el.width,el.height]);
    assert.deepEqual(size,[128,128],'trained CNN output is 2x');
    await page.locator('#pts-only-compare').click();
    assert(await page.locator('#pts-only-stage canvas.pts-only-enhanced').evaluate(el=>el.hidden),
      'compare action restores original image');
    assert.equal(requests.filter(x=>x.includes('/ajax/')).length,0,'local upscale requires zero pixiv API requests');

    // Select a local ugoira ZIP; decoding and animation must work without pixiv.
    const fc2=page.waitForEvent('filechooser');
    await page.locator('#pts-only-zip').click();
    await (await fc2).setFiles({name:'frames.zip',mimeType:'application/zip',
      buffer:zipStored(['000000.png','000001.png'],motionPNGs)});
    await page.waitForFunction(()=>!!document.querySelector('#pts-only-stage .pts-ugoira-canvas'));
    await page.locator('#pts-only-motion').click();
    assert.equal(await page.locator('#pts-only-motion').textContent(),'動き補間: ON');
    await page.waitForFunction(()=>!!document.querySelector('#pts-only-stage .pts-ugoira-motion-canvas'),null,{timeout:5000});
    assert((await page.locator('#pts-only-stage .pts-ugoira-motion-canvas').evaluate(c=>c.width))>=64,
      'motion WebGL canvas created from local PNGs');
    await page.waitForTimeout(250);
    await page.locator('#pts-only-play').click();
    assert.equal(await page.locator('#pts-only-play').textContent(),'再生');
    assert.equal(requests.filter(x=>x.includes('/ajax/')).length,0,
      'ZIP decoder uses no pixiv API');

    // A specific user request may fetch metadata + ZIP once; no discovery.
    await page.locator('#pts-only-artwork').click();
    await page.waitForFunction(()=>document.querySelector('#pts-only-status')?.textContent?.includes('うごイラを再生中'));
    assert.equal(requests.filter(x=>x.includes('/ajax/')).length,2,'metadata only: artwork and ugoira_meta');
    assert.equal(requests.filter(x=>x.includes('/test/ugoira.zip')).length,1,'one ZIP only');

    await page.locator('#pts-only-close').click();
    assert.equal(await page.locator('#pts-only-stage').evaluate(el=>el.childElementCount),0);
    assert.deepEqual(errors,[],'no JS page errors');
    console.log('PASS enhance-only: no feed, no automatic requests, trained CNN x2, comparison, real WebGL motion canvas, stored/deflate ZIP, 2 metadata GET + one ZIP');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
