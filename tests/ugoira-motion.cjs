// Run: node tests/ugoira-motion.cjs
// Synthetic grayscale frames only. No pixiv requests or live browser required.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
const start=source.indexOf('  function estimateUgoiraMotion(');
const end=source.indexOf('\n  function releaseUgoiraMotion(',start);
assert(start>0&&end>start,'motion field implementation found');
const estimate=new Function('MOTION_BLOCK_SIZE','MOTION_SEARCH_RADIUS',
  source.slice(start,end)+'\nreturn estimateUgoiraMotion;')(12,4);
const w=96,h=72,dx=2,dy=1;
const a=new Uint8Array(w*h),b=new Uint8Array(w*h);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  a[y*w+x]=(Math.floor(x/8)*31+Math.floor(y/7)*19)%230;
}
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const sx=x-dx,sy=y-dy;
  b[y*w+x]=sx>=0&&sy>=0?a[sy*w+sx]:0;
}
const flow=estimate(a,b,w,h);
assert(flow,'translation produces flow field');
assert(flow.columns*flow.rows*4===flow.pixels.length);
for(const [bx,by] of [[2,2],[3,3],[4,3],[5,4]]){
 const i=((flow.rows-1-by)*flow.columns+bx)*4;
 assert.equal((flow.pixels[i]-128)/12,dx,'detect x displacement');
 assert.equal((128-flow.pixels[i+1])/12,dy,'detect y displacement');
}
const unchanged=estimate(a,a,w,h);
assert(unchanged,'identical images permitted');
for(let i=0;i<unchanged.pixels.length;i+=4)
  assert.equal(unchanged.pixels[i],128,'static field has no x movement');
assert.equal(estimate(new Uint8Array(w*h),new Uint8Array(w*h).fill(240),w,h),null,
 'large scene cut rejects motion compensation');
assert.equal(estimate(new Uint8Array(1),new Uint8Array(1),1,1),null);
assert(source.includes('let motionInterpolationEnabled = false;'),'experimental mode defaults off');
assert(source.includes("a.src.startsWith('blob:')"),'only locally decoded ZIP frame inputs');
const moduleText=source.slice(source.indexOf('  /* ---------- うごイラ: 動き推定'),
 source.indexOf('  function startUgoira(s) {'));
assert(!/(^|\n)\s*(?!\/\/).*\bfetch\s*\(/m.test(moduleText),'no fetch calls in local motion module');
assert(source.includes('s.zipUrl = preferOriginalUgoira'),'quality mode uses single ZIP selection');
assert(source.includes("releaseUgoiraMotion(s);"),'cleanup is installed');
console.log('PASS motion estimation, scene cuts, local input, defaults, cleanup, ZIP selection');
