// Real GPU tile test for Anime4K CNN x2. Runs against synthetic art only.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const source=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
(async()=>{
  const browser=await chromium.launch({headless:true,
    executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',
    args:['--no-sandbox','--enable-webgl','--use-gl=angle','--use-angle=swiftshader',
      '--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage();
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
    await page.goto('https://www.pixiv.net/artworks/999');
    await page.addScriptTag({content:source});
    await page.locator('#pts-only-launch').click();
    const data=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=810;c.height=810;
      const ctx=c.getContext('2d');
      ctx.fillStyle='rgb(40,80,120)';ctx.fillRect(0,0,810,810);
      ctx.fillStyle='rgb(190,120,60)';ctx.fillRect(100,100,600,600);
      ctx.strokeStyle='rgb(20,10,20)';ctx.lineWidth=10;
      ctx.strokeRect(170,200,500,300);
      return c.toDataURL('image/png').split(',')[1];
    });
    const picker=page.waitForEvent('filechooser');
    await page.locator('#pts-only-file').click();
    await (await picker).setFiles({
      name:'large.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
    await page.waitForSelector('#pts-only-stage img.pts-only-image');
    await page.locator('#pts-only-upscale').click();
    await page.waitForFunction(()=>{
      const c=document.querySelector('#pts-only-stage canvas.pts-only-enhanced');
      return c && c.width===1620 && c.height===1620;
    },null,{timeout:120000});
    const pixels=await page.locator('#pts-only-stage canvas.pts-only-enhanced').evaluate(c=>{
      const ctx=c.getContext('2d');
      const get=(x,y)=>[...ctx.getImageData(x,y,1,1).data].slice(0,3);
      return {left:get(1022,600),right:get(1025,600),
        upper:get(600,1022),lower:get(600,1025),
        center:get(800,800),first:get(1,1)};
    });
    const brightness=px=>px.reduce((a,b)=>a+b,0);
    assert(brightness(pixels.center)>25,'nonblank center after tiled GPU inference');
    assert(brightness(pixels.first)>25,'nonblank outer tile');
    const distance=(a,b)=>a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0);
    assert(distance(pixels.left,pixels.right)<100,'horizontal seam has no large discontinuity');
    assert(distance(pixels.upper,pixels.lower)<100,'vertical seam has no large discontinuity');
    console.log('PASS trained Anime4K CNN 2x tiled GPU output: 810x810 -> 1620x1620, no obvious tile seams');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
