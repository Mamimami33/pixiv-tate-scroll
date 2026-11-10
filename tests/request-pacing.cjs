// Run: node tests/request-pacing.cjs
// No real pixiv requests: tests only the request queue extracted from the shipped userscript.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'pixiv-tate-scroll.user.js'), 'utf8');
const start = source.indexOf('  const PIXIV_GET_GAP_MS = ');
const end = source.indexOf('\n  async function fetchJson(', start);
assert(start !== -1 && end > start, 'pacing implementation found');
const section = source.slice(start, end)
  .replace('const PIXIV_GET_GAP_MS = 1500;', 'const PIXIV_GET_GAP_MS = 5;')
  .replace('const PIXIV_GET_LIMIT_PAUSE_MS = 60 * 60 * 1000;', 'const PIXIV_GET_LIMIT_PAUSE_MS = 1000;');

function harness() {
  const requests = [];
  const storage = new Map();
  let concurrent = 0, peak = 0;
  let responseFor = () => ({status:200, headers:{get:()=>null}});
  const fetchMock = (url, options) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException('aborted','AbortError')); return; }
    concurrent++; peak = Math.max(concurrent, peak);
    requests.push({url, at:Date.now()});
    setTimeout(() => { concurrent--; resolve(responseFor(url)); }, 10);
  });
  const code = new Function('fetch', 'localStorage', 'console', 'DOMException',
    'setTimeout', 'clearTimeout', section +
    '\nreturn {pacedPixivGet, state:()=>({pause:pixivGetPauseUntil, queued:pixivGetQueue.length})};');
  const api = code(fetchMock,
    {getItem:key=>storage.get(key)||null, setItem:(key,value)=>storage.set(key,value)},
    {warn(){}}, DOMException, setTimeout, clearTimeout);
  return {
    ...api, requests, storage,
    getPeak:()=>peak, setResponse:fn=>{ responseFor=fn; }
  };
}

(async () => {
  const h = harness();
  const get = h.pacedPixivGet;
  const results = await Promise.all([get('one'),get('two'),get('three')]);
  assert(results.every(response=>response.status===200));
  assert.equal(h.getPeak(),1,'no overlapping GETs');

  // Background tasks may already be queued; the active slide becomes urgent.
  const blocker = get('blocker');
  let visible = false;
  const bg = get('background', {}, undefined, -2);
  const dynamic = get('became-visible', {}, undefined, ()=>visible ? 10 : -2);
  visible = true;
  await Promise.all([blocker,bg,dynamic]);
  assert(h.requests.findIndex(r=>r.url==='became-visible') <
    h.requests.findIndex(r=>r.url==='background'), 'active slide prioritized');

  const busy = get('busy');
  const controller = new AbortController();
  const cancelled = get('cancelled', {signal:controller.signal});
  controller.abort();
  await assert.rejects(cancelled, {name:'AbortError'});
  await busy;
  assert(!h.requests.some(r=>r.url==='cancelled'),'aborted queue entry not sent');

  const oneMore = get('one-more');
  let stillRelevant = true;
  const obsolete = get('obsolete', {}, ()=>stillRelevant,-2);
  stillRelevant = false;
  await assert.rejects(obsolete, {name:'AbortError'});
  await oneMore;
  assert(!h.requests.some(r=>r.url==='obsolete'),'stale queue entry not sent');

  h.setResponse(url => ({status:url==='429'?429:200, headers:{get:()=>null}}));
  const paused = await Promise.allSettled([get('429'), get('after-429')]);
  assert.equal(paused[0].status,'fulfilled');
  assert.equal(paused[0].value.status,429);
  assert.equal(paused[1].status,'rejected');
  assert(h.state().pause>Date.now(),'429 pauses further GETs');
  await assert.rejects(get('another'));
  assert(!h.requests.some(r=>r.url==='after-429'||r.url==='another'));
  console.log('PASS request queue: serialization, current-slide priority, aborted and stale requests, 429 stop');
})().catch(error=>{console.error(error);process.exitCode=1;});
