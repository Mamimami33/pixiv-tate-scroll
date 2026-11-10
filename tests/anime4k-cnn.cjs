// Run: node tests/anime4k-cnn.cjs (requires playwright-core and headless Chromium).
// No pixiv network requests. Compiles every trained Anime4K CNN shader in WebGL2.
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
const begin=source.indexOf('  const AI_CNN_MODEL_PASSES = ');
const end=source.indexOf('  /* ---------- うごイラ（ZIP',begin);
assert(begin>=0&&end>begin,'trained CNN is embedded in single-file userscript');
const fragment=source.slice(begin,end);
assert(!fragment.includes('https://i.pximg.net/'),'CNN does not fetch image server');
assert(!/^\s*fetch\s*\(/m.test(fragment),'CNN has no API fetch');
assert(source.includes('aiCnnChooseLocalImage(where)'),'CORS-safe local-file fallback');
assert(source.includes("const AI_CNN_MAX_OUTPUT_PIXELS = 2_560_000;"),'device pixel cap');

function chromePath(){
  if(process.env.CHROMIUM_PATH)return process.env.CHROMIUM_PATH;
  for(const candidate of ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser']){
    if(fs.existsSync(candidate))return candidate;
  }
  throw new Error('Install Chromium or set CHROMIUM_PATH');
}

(async()=>{
  const {chromium}=require('playwright-core');
  const browser=await chromium.launch({
    executablePath:chromePath(),headless:true,
    args:['--no-sandbox','--enable-webgl','--use-gl=angle',
      '--use-angle=swiftshader','--enable-unsafe-swiftshader']
  });
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',error=>{console.error('browser exception:',error.message);});
    await page.goto('about:blank');
    await page.addScriptTag({content:fragment+
      '\nwindow.__aiCNN={process:anime4kCnnProcessImage,allows:aiCnnCanUseSource};'});
    const outcome=await page.evaluate(async()=>{
      const c=document.createElement('canvas');
      c.width=64;c.height=64;
      const ctx=c.getContext('2d');
      ctx.fillStyle='rgb(40,55,70)';ctx.fillRect(0,0,64,64);
      ctx.fillStyle='rgb(240,210,190)';ctx.fillRect(14,12,40,41);
      ctx.strokeStyle='rgb(0,0,0)';ctx.lineWidth=3;
      ctx.beginPath();ctx.moveTo(8,7);ctx.lineTo(50,59);ctx.stroke();
      const img=new Image();
      img.src=c.toDataURL('image/png');
      await img.decode();
      const output=window.__aiCNN.process(img);
      const pixels=output.getContext('2d').getImageData(0,0,128,128).data;
      let min=255,max=0,nonblank=0;
      for(let i=0;i<pixels.length;i+=4){
        min=Math.min(min,pixels[i]);max=Math.max(max,pixels[i]);
        if(pixels[i]>10)nonblank++;
      }
      const corsBlocked=!window.__aiCNN.allows({
        currentSrc:'https://i.pximg.net/sample.png',complete:true,
        naturalWidth:64,naturalHeight:64,crossOrigin:null
      });
      const dimensions=[output.width,output.height];
      output.width=0;output.height=0;
      return {dimensions,min,max,nonblank,corsBlocked};
    });
    assert.deepEqual(outcome.dimensions,[128,128],'CNN x2 output dimensions');
    assert(outcome.max-outcome.min>100 && outcome.nonblank>1000,
      'trained shader produced nonblank detail');
    assert(outcome.corsBlocked,'CORS-blocked pixiv CDN requires local selection');
    console.log('PASS Anime4K trained CNN WebGL2: compile/link, x2 render, output data, CORS guard');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
