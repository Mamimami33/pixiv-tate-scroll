// Run: node tests/content-filter.cjs (requires Playwright and Chromium).
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
const base = require('node:child_process').execFileSync('git',['show','4d04d45:pixiv-tate-scroll.user.js'],{encoding:'utf8'});
function functionText(s,name) {
 const start=s.indexOf('  function '+name+'(');
 assert(start>=0,name); const next=s.indexOf('\n  function ',start+1);
 return s.slice(start,next);
}
for(const name of ['compareSearchRank','orderSearchRankRows','searchTiePenalty','searchRankRow','tasteScore']) assert.equal(functionText(source,name),functionText(base,name),name+' unchanged');
// Bookshelf routing is covered by bookshelf.cjs; retain feed-path filter regression coverage here.
const feedSource=source.replace("if (contentFilter.type === 'manga') {", "if (false) {");
const instrumented=feedSource.replace(/\}\)\(\);\s*$/,`window.__test = {
 state:()=>({filter:{...contentFilter},epoch:contentFilterEpoch,viewMode,slides:slides.map(s=>({id:s.id,type:s.rawType,age:s.xRestrict})),grid:searchGrid.items.map(s=>({id:s.id,type:s.illustType,age:s.xRestrict})),busy:customBusy||searchBusy}),
 matches:contentMatches, prepare:filterContentCandidates, normalize:normalizeCandidate,
 set:f=>{contentFilter=f;contentFilterEpoch++;}, invalidate:()=>{contentFilterEpoch++;},
 openGrid:openSearchGrid, openFirstGrid:()=>openGridArtwork(searchGrid.items[0]), openGridArtwork, related:insertRecommendationsAfterBookmark,
 series:seriesOpenEpisode, seriesUI, seriesCacheFor, seriesFetchPage, insertSeriesAfter,
 getSlide:(id)=>id?slides.find(s=>s.id===id):slides[0],
 openEpisode:item=>{slides[currentIndex()].series={id:'1',order:1,title:'test'};seriesUI.sheetOpen=true;return seriesOpenEpisode(item);},
 closeSeries:seriesCloseLayer, closeGrid:closeSearchGrid, history:showSessionHistory, profile:()=>JSON.stringify(profile),
 key:contentFilterKey, source:()=>({discovery:contentDiscoveryUrl(),search:searchApiUrl({word:'test'},1)}),
};})();`);
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:390,height:844}}); const errors=[],requests=[];
 page.setDefaultTimeout(8000); page.on('pageerror',e=>{errors.push(e.message);console.error('pageerror:',e.message);});
 const works=[]; for(let type=0;type<3;type++)for(let age=0;age<3;age++)works.push({id:String(100+type*10+age),illustType:type,xRestrict:age,title:'test',tags:['test'],userId:'20',userName:'author',url:'https://www.pixiv.net/image.png',urls:{regular:'https://www.pixiv.net/image.png',original:'https://www.pixiv.net/image.png'},pageCount:1,bookmarkData:null});
 let delay=false,empty=false,related=false,delayAll=false,homeDelay=false,noIdentity=false;
 const extras=[{...works[4],id:'311'},{...works[5],id:'312'},{...works[4],id:'411',seriesNavData:{seriesType:'manga',seriesId:'1',order:2}},{...works[5],id:'412',seriesNavData:{seriesType:'manga',seriesId:'1',order:3}}];
 await page.route('**/*',async r=>{
  const u=new URL(r.request().url()); requests.push(u.pathname+u.search);
  if(u.pathname==='/image.png')return r.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64')});
  if(homeDelay&&u.pathname==='/')await new Promise(resolve=>setTimeout(resolve,300));
  if(!u.pathname.startsWith('/ajax/')&&noIdentity&&u.pathname!=='/')return r.fulfill({contentType:'text/html',body:'<html><body></body></html>'});
  if(!u.pathname.startsWith('/ajax/')) return r.fulfill({contentType:'text/html',body:'<html><head><meta name="global-data" content=\'{"userData":{"id":"42"}}\'></head><body></body></html>'});
  if(delayAll)await new Promise(resolve=>setTimeout(resolve,180));
  let body={works:[],total:0};
  if(u.pathname.includes('/ajax/search/'))body={illustManga:{data:empty?[]:works.map(w=>({...w,id:String(Number(w.id)+(decodeURIComponent(u.pathname).endsWith('/test')?100:0))})),total:works.length}};
  else if(u.pathname.includes('/discovery/')||u.pathname.includes('/recommend/'))body={thumbnails:{illust:empty?[]:(related?extras:works)},nextIds:[]};
  else if(/^\/ajax\/illust\/\d+$/.test(u.pathname)){
   const id=u.pathname.split('/').pop(); if(delay)await new Promise(r=>setTimeout(r,150));
   body=[...works,...extras,...works.map(w=>({...w,id:String(Number(w.id)+100)}))].find(w=>w.id===id)||{id};
  }
  else if(u.pathname.startsWith('/ajax/series/')) body={page:{total:works.length,series:[...works].reverse().map((w,i)=>({workId:w.id,order:works.length-i}))},thumbnails:{illust:works}};
  return r.fulfill({contentType:'application/json',body:JSON.stringify({error:false,body})});
 });
 await page.goto('https://www.pixiv.net/'); await page.addScriptTag({content:instrumented});
 await page.waitForSelector('#pts-content-filter[open]');
 assert.equal(await page.locator('#pts-overlay').count(),0,'no feed before confirmation');
 const rect=await page.locator('#pts-content-filter').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=390&&rect.y+rect.height<=844,'mobile sheet fits viewport');
 assert((await page.getByRole('button',{name:'この条件で開始'}).boundingBox()).height>=44);
 assert.equal(await page.evaluate(()=>__test.key()),'PTS_CONTENT_FILTER_V1:42');
 // Exhaustive 3x3 choices x known and invalid metadata.
 const matrix=await page.evaluate(()=>{
  let count=0;
  for(const type of ['all','manga','illust'])for(const age of ['all','safe','r18'])for(const t of [0,1,2,null,undefined,'',false,3])for(const a of [0,1,2,null,undefined,'',false,3]){
   const expected=[0,1,2].includes(t)&&[0,1,2].includes(a)&&(type==='all'||(type==='manga'?t===1:t===0||t===2))&&(age==='all'||a===(age==='safe'?0:1));
   if(__test.matches({illustType:t,xRestrict:a},{type,age})!==expected)throw Error(JSON.stringify({type,age,t,a}));count++;
  } return count;
 }); assert.equal(matrix,576);
 await page.check('input[name=type][value=manga]'); await page.check('input[name=age][value=r18]'); await page.getByRole('button',{name:'この条件で開始'}).click();
 await page.waitForFunction(()=>window.__test.state().slides.length===1);
 assert.deepEqual((await page.evaluate(()=>__test.state())).slides,[{id:'111',type:1,age:1}]);
 assert.equal(await page.locator('.pts-content-filter').textContent(),'マンガ・R-18');
 assert(requests.some(u=>u.includes('/discovery/')&&u.includes('mode=r18')&&u.includes('type=manga')));
 assert(requests.some(u=>u.includes('/ajax/search/')&&u.includes('mode=r18')&&u.includes('type=manga')&&u.includes('p=1')));
 await page.evaluate(()=>__test.openGrid('test')); await page.waitForFunction(()=>__test.state().grid.length===1);
 assert.deepEqual((await page.evaluate(()=>__test.state())).grid,[{id:'211',type:1,age:1}]);
 await page.evaluate(()=>__test.openFirstGrid());
 await page.waitForFunction(()=>__test.state().slides.some(s=>s.id==='211'));
 await page.locator('.pts-return-grid').click();
 assert.equal(await page.locator('.pts-grid-open').count()>0,true,'preserved grid restored');
 // Reset remains a draft until confirmed; cancel does not persist.
 await page.evaluate(()=>document.querySelector('.pts-content-filter').click());
 await page.getByRole('button',{name:'すべてに戻す',exact:true}).click();
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#pts-content-filter').count(),0,'Escape cancels filter, not viewer');
 assert.deepEqual((await page.evaluate(()=>__test.state())).filter,{type:'manga',age:'r18'});
 await page.evaluate(()=>document.querySelector('.pts-content-filter').click());
 await page.getByRole('button',{name:'すべてに戻す',exact:true}).click();
 const profileBefore=await page.evaluate(()=>__test.profile());
 await page.getByRole('button',{name:'確定して先頭から開始'}).click();
 assert.equal(await page.evaluate(()=>__test.profile()),profileBefore,'regeneration does not train');
 await page.waitForFunction(()=>__test.state().grid.length===9);
 // Restore account setting on every full load, still requiring one tap.
 await page.reload(); await page.addScriptTag({content:instrumented}); await page.waitForSelector('#pts-content-filter[open]');
 assert.equal(await page.locator('input[name=type][value=all]').isChecked(),true);
 await page.getByRole('button',{name:'この条件で開始'}).click(); await page.waitForFunction(()=>__test.state().slides.length===9);
 // Metadata lookups bounded, unknowns blocked, stale completion ignored.
 const before=requests.filter(u=>/^\/ajax\/illust\/10\d\d$/.test(u)).length;
 const unknown=await page.evaluate(()=>__test.prepare(Array.from({length:80},(_,i)=>({id:String(1000+i)}))));
 assert.equal(unknown.length,0);
 assert(requests.filter(u=>/^\/ajax\/illust\/10\d\d$/.test(u)).length-before<=24);
 delay=true;
 const stale=await page.evaluate(async()=>{const p=__test.prepare([{id:'101'}]);__test.invalidate();return p;}); assert.deepEqual(stale,[]);delay=false;
 const recovered=await page.evaluate(()=>__test.prepare([{id:'110'}]));
 assert.equal(recovered[0].illustType,1);assert.equal(recovered[0].xRestrict,0);
 assert.equal(await page.evaluate(()=>__test.normalize({id:'9',illustType:null,xRestrict:false}).illustType),null);
 // Series list blocks mismatches and unknowns before thumbnail rendering.
 await page.evaluate(async()=>{__test.set({type:'manga',age:'r18'});const c=__test.seriesCacheFor('1');await __test.seriesFetchPage(c,1);window.seriesAllowed=[...c.rows.values()].filter(r=>r.allowed).map(r=>r.id);});
 assert.deepEqual(await page.evaluate(()=>seriesAllowed),['111']);

 // All direct insertion paths must also reject R-18G under R-18-only.
 related=true;
 await page.evaluate(async()=>{const s=__test.getSlide('111');await __test.related(s);});
 let added=(await page.evaluate(()=>__test.state())).slides.filter(s=>Number(s.id)>=300);
 assert.deepEqual(added,[{id:'311',type:1,age:1},{id:'411',type:1,age:1}]);
 // Next-episode insertion independently validates detail metadata.
 await page.evaluate(async()=>{const s=__test.getSlide('111');s.seriesInfoChecked=true;s.seriesNextId='412';await __test.insertSeriesAfter(s);});
 assert(!(await page.evaluate(()=>__test.state())).slides.some(s=>s.id==='412'));
 // Independent series reader checks body before requesting/displaying pages.
 await page.evaluate(()=>__test.openEpisode({id:'412',index:1,order:3}));
 assert.equal(await page.evaluate(()=>__test.seriesUI.episode),null);
 assert.match(await page.locator('.pts-series-error').textContent(),/表示条件/);
 await page.evaluate(()=>__test.openEpisode({id:'411',index:1,order:2}));
 assert.equal(await page.evaluate(()=>__test.seriesUI.episode?.id),'411');
 await page.evaluate(()=>__test.closeSeries());
 // A filter change while requests are pending discards old custom and grid work.
 related=false;delayAll=true;
 async function change(type,age){
  await page.evaluate(()=>document.querySelector('.pts-content-filter').click());
  await page.check('input[name=type][value='+type+']');await page.check('input[name=age][value='+age+']');
  await page.getByRole('button',{name:'確定して先頭から開始'}).click();
 }
 await change('all','safe');
 await page.evaluate(()=>__test.openGrid('test'));
 await change('manga','r18');
 await page.waitForTimeout(900);delayAll=false;
 const current=await page.evaluate(()=>__test.state());
 assert(current.slides.every(s=>s.type===1&&s.age===1));assert(current.grid.every(s=>s.type===1&&s.age===1));
 await page.evaluate(()=>__test.history());
 const historyLabels=await page.locator('.pts-history-list button').allTextContents();
 assert(!historyLabels.some(label=>label.includes('(100)')));
 // Empty source has a finite initial retry budget and a visible recovery UI.
 empty=true;
 await change('illust','safe');await page.waitForFunction(()=>!__test.state().busy);
 assert.equal(await page.locator('.pts-content-empty').count(),1);
 const countAtEmpty=requests.length;await page.waitForTimeout(900);
 assert.equal(requests.length,countAtEmpty,'empty feed does not poll candidate APIs');
 // Search-feed path uses the same filtering, independently of the grid.
 empty=false;
 await page.goto('https://www.pixiv.net/tags/test/artworks');await page.addScriptTag({content:instrumented});
 await page.waitForSelector('#pts-content-filter[open]');
 await page.check('input[name=type][value=manga]');await page.check('input[name=age][value=r18]');
 await page.getByRole('button',{name:'この条件で開始'}).click();
 await page.waitForFunction(()=>__test.state().slides.length===1);
 assert.deepEqual((await page.evaluate(()=>__test.state())).slides,[{id:'211',type:1,age:1}]);

 // Account lookup must finish before showing or persisting the guest selection.
 homeDelay=true;noIdentity=true;
 await page.goto('https://www.pixiv.net/users/20');
 await page.evaluate(()=>{localStorage.removeItem('PTS_LOGIN_USER_ID');localStorage.setItem('PTS_CONTENT_FILTER_V1:guest',JSON.stringify({type:'illust',age:'safe'}));});
 await page.addScriptTag({content:instrumented});await page.waitForTimeout(80);
 assert.equal(await page.locator('#pts-content-filter').count(),0);
 await page.waitForSelector('#pts-content-filter[open]');
 assert.equal(await page.evaluate(()=>__test.key()),'PTS_CONTENT_FILTER_V1:42');
 assert.equal(await page.locator('input[name=type][value=manga]').isChecked(),true);
 assert.equal(await page.locator('input[name=age][value=r18]').isChecked(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: 576 strict predicates; delayed account detection and account storage; startup/restore/reset/cancel; custom/search feed/grid; bookmark/series insertions and reader/list; request-generation isolation; bounded details and empty retries; source parameters; no filter learning; unchanged search ranking.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
