// Run: node tests/local-upscale.cjs
// No network access or image pixels are needed for these geometry checks.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../pixiv-tate-scroll.user.js'),'utf8');
const start=source.indexOf('  function upscalePlan(');
const end=source.indexOf('\n  function clearUpscale()',start);
assert(start>0&&end>start,'upscalePlan found');
const fn=source.slice(start,end);
const upscalePlan=new Function('UPSCALE_MAX_PIXELS', fn+'\nreturn upscalePlan;')(2500000);
assert.equal(upscalePlan(2000,3000,390,844,3),null,'skip source already sharp enough');
const small=upscalePlan(450,900,390,844,3);
assert(small && small.width>390,'low-resolution image gets interpolated');
assert(small.width*small.height<=2500000,'screen pixel budget respected');
assert(small.width<=780,'device pixel ratio capped at 2');
assert(small.x>=0&&small.y>=0&&small.drawWidth<=small.width+1&&small.drawHeight<=small.height+1);
const manga=upscalePlan(150,650,390,844,3);
assert(manga && manga.drawWidth<manga.width,'portrait content has letterbox');
const capped=upscalePlan(200,200,800,1000,3,1600000);
assert(capped && capped.width*capped.height<=1600000,'large viewport uses lower resolution');
assert.equal(upscalePlan(0,900,390,844,3),null,'invalid dimensions rejected');
assert.equal(upscalePlan(NaN,900,390,844,3),null,'non-finite dimensions rejected');
assert.equal(upscalePlan(250,300,390,844,1),null,'no redundant 1x canvas');
assert(source.includes("let upscaleEnabled = false;"),'opt-in default OFF');
const feature=source.slice(source.indexOf('  /* ---------- 現在表示中だけのローカル拡大補間'),source.indexOf('  /* ---------- うごイラ（ZIP',start));
for(const forbidden of ['fetch(', 'getImageData(', 'toDataURL(', 'toBlob(', 'WebSocket(']) {
  // Comments can describe forbidden APIs; match actual invocation only on non-comment lines.
  const lines=feature.split('\n').filter(s=>!/^\s*\/\//.test(s));
  assert(!lines.some(line=>line.includes(forbidden)),'no data access / network call: '+forbidden);
}
assert(source.includes('if (upscaleOwner === s) clearUpscale();'),'offscreen cleanup installed');
console.log('PASS local upscaling geometry, pixel limits, opt-in, no network, cleanup');
