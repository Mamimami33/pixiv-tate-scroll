// Run: node tests/bookshelf.cjs (Playwright + Chromium).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const script=fs.readFileSync(path.join(__dirname,'../pixiv-tate-scroll.user.js'),'utf8');
const base=require('node:child_process').execFileSync('git',['show','045506a:pixiv-tate-scroll.user.js'],{encoding:'utf8'});
function fn(s,name){const a=s.indexOf('  function '+name+'(');assert(a>=0);return s.slice(a,s.indexOf('\n  function ',a+1));}
for(const name of ['compareSearchRank','searchRankRow','searchTiePenalty','orderSearchRankRows','tasteScore'])assert.equal(fn(script,name),fn(base,name),name+' unchanged');
const injected=script.replace(/\}\)\(\);\s*$/,`window.__shelfTest={
 state:()=>({viewMode,mode,source:bookshelf.source,reading:bookshelf.reading,busy:bookshelf.busy,top:bookshelf.scroll?.scrollTop,entries:[...bookshelf.entries.values()].map(e=>({id:e.id,state:e.state,rank:e.rank})),groups:bookshelfGroups().filter(g=>g.entry.state==='ready').map(g=>({key:g.key,rank:g.rank,ids:g.items.map(e=>e.id),cover:g.entry.cover})),page:seriesUI.pageIndex,episode:seriesUI.episode?.id,slides:slides.map(s=>s.id),activeRequests:bookshelf.activeRequests}),
 source:bookshelfSelectSource,load:bookshelfLoadMore,groups:bookshelfGroups,profile:()=>JSON.stringify(profile),
 seriesUI, showList:seriesShowList,openEpisode:seriesOpenEpisode,closeSeries:seriesCloseLayer,
 advance:bookshelfAdvanceSeries,return:bookshelfReturn,
 groupingTrap:()=>{const saved=bookshelf.entries;bookshelf.entries=new Map([
 ['a',{id:'a',rank:0,state:'ready',series:{id:'A'}}],
 ['b',{id:'b',rank:1,state:'ready',series:{id:'B'}}],
 ['c',{id:'c',rank:4,state:'ready',series:{id:'A'}}],
 ['d',{id:'d',rank:5,state:'ready',series:{id:'A'}}]]);
 const keys=bookshelfGroups().map(g=>g.key);bookshelf.entries=saved;return keys;},
 open:key=>bookshelfOpen(bookshelfGroups().find(g=>g.key===key)),
 ranks:()=>bookshelf.context?searchRankCandidates(bookshelf.context,[...bookshelf.context.records.values()].filter(w=>contentMatches(w))).map(w=>w.id):[],
 };})();`);
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
 const errors=[],requests=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 const works=new Map();
 function work(id,series=null,age=0,pages=1){const w={id:String(id),illustType:1,xRestrict:age,pageCount:pages,title:'Manga '+id,tags:['query'],userId:'20',userName:'Artist',url:'https://www.pixiv.net/img/'+id+'.png',urls:{regular:'https://www.pixiv.net/img/'+id+'.png',original:'https://www.pixiv.net/img/'+id+'.png'},bookmarkData:null,seriesNavData:series?{seriesType:'manga',seriesId:String(series),order:id%100,title:'Series '+series}:null};works.set(String(id),w);return w;}
 for(let n=101;n<=113;n++)work(n,1,n===103?1:0,n===101?2:1);
 work(201,2);work(202,2);for(let n=301;n<=335;n++)work(n,null,0,n===301?3:1);
 work(401,null,1);work(402,null,0);work(601,null,0);work(602,null,0);delete works.get('402').xRestrict;
 const listWork=id=>{const w=works.get(String(id));return {id:w.id,illustType:w.illustType,xRestrict:w.xRestrict,title:w.title,url:w.url,tags:w.tags,userId:w.userId,pageCount:w.pageCount,bookmarkData:{id:'saved'}};};
 const bookmarked=[listWork(102),listWork(103),listWork(104),listWork(201),...Array.from({length:35},(_,i)=>listWork(301+i))];
 let detailActive=0,maxDetailActive=0,slow=false,coldPopular=false,failDetail=false;
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());requests.push(u.pathname+u.search);
  const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify({error:false,body})});
  if(u.pathname.startsWith('/img/'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64')});
  if(u.pathname==='/ranking.php'){
   const contents=[102,201,301,401,402,...(coldPopular?[601,602]:[])].map(id=>{const w=works.get(String(id));return {illust_id:w.id,illust_type:1,title:w.title,url:w.url,illust_series:w.seriesNavData?{illustSeriesId:w.seriesNavData.seriesId,illustSeriesTitle:w.seriesNavData.title}:null};});
   return route.fulfill({contentType:'application/json',body:JSON.stringify({contents:u.searchParams.get('p')==='1'?contents:[]})});
  }
  if(/\/bookmarks(?:\/artworks)?$/.test(u.pathname)){
   const offset=Number(u.searchParams.get('offset')),rest=u.searchParams.get('rest');
   const filler=Array.from({length:100},(_,i)=>({id:String(5000+offset+i),illustType:0,xRestrict:0}));
   return json({works:rest==='hide'?[]:offset===0?filler:offset===100?[...bookmarked,...filler.slice(bookmarked.length)]:[],total:7263});
  }
  if(u.pathname.endsWith('/missing'))return json({illustManga:{data:[],total:0}});
  if(u.pathname.startsWith('/ajax/search/'))return json({illustManga:{data:[{...works.get('102'),tags:['query-extra']},works.get('201'),works.get('104'),works.get('301')],total:4}});
  if(u.pathname.startsWith('/ajax/series/')){
   const id=u.pathname.split('/').pop(),p=Number(u.searchParams.get('p')||1);
   const episodes=[...works.values()].filter(w=>w.seriesNavData?.seriesId===id);
   const rows=[...episodes].reverse().slice((p-1)*12,p*12);
   return json({illustSeries:[{id,title:'Series '+id,firstIllustId:episodes[0].id,contentCount:episodes.length}],page:{total:episodes.length,series:rows.map(w=>({workId:w.id,order:w.seriesNavData.order}))},thumbnails:{illust:[works.get('335'),...rows]}});
  }
  const match=u.pathname.match(/^\/ajax\/illust\/(\d+)(\/pages)?$/);
  if(match){const w=works.get(match[1]);if(failDetail&&match[1]==='602')return route.fulfill({status:503,body:'temporary'});if(match[2])return json(Array.from({length:w.pageCount},()=>({urls:w.urls})));
   detailActive++;maxDetailActive=Math.max(maxDetailActive,detailActive);await new Promise(r=>setTimeout(r,slow?180:15));detailActive--;return json(w||{id:match[1]});}
  if(u.pathname.startsWith('/ajax/'))return json({works:[],total:0});
  return route.fulfill({contentType:'text/html',body:'<html><head><meta name="global-data" content=\'{"userData":{"id":"42"}}\'></head><body></body></html>'});
 });
 await page.goto('https://www.pixiv.net/');
 await page.evaluate(()=>{localStorage.setItem('PTS_PROFILE_V2:user:42',JSON.stringify({version:2,history:{userId:'42',works:[],initialized:true,updatedAt:Date.now(),dateMigrationChecked:true}}));});
 await page.addScriptTag({content:injected});await page.waitForSelector('#pts-content-filter[open]');
 await page.check('input[name=type][value=manga]');await page.check('input[name=age][value=safe]');
 await page.getByRole('button',{name:'この条件で開始'}).click();
 await page.waitForFunction(()=>__shelfTest.state().groups.some(g=>g.key==='series:1'&&g.cover?.url));
 let state=await page.evaluate(()=>__shelfTest.state());assert.equal(state.viewMode,'bookshelf');assert.equal(state.source,'bookmarks');assert.equal(state.slides.length,0);
 assert.equal(state.groups.filter(g=>g.key==='series:1').length,1);
 assert.deepEqual(state.groups.find(g=>g.key==='series:1').ids,['102','104']);
 assert.equal(state.groups.find(g=>g.key==='series:1').cover.firstId,'101');
 assert.match(state.groups.find(g=>g.key==='series:1').cover.url,/101\.png$/);
 assert(requests.includes('/ajax/series/1?p=2'),'first cover located on final page');
 assert(maxDetailActive<=3,'at most 3 simultaneous metadata requests');
 assert(requests.filter(u=>/\/ajax\/illust\/\d+$/.test(u)).length<bookmarked.length,'visible-first, not all bookmark details');
 assert(!requests.some(u=>u.includes('/discovery/')),'no feed recommendation fetch for bookshelf');
 assert.match(await page.locator('[data-tile-key="series:1"]').textContent(),/ブックマーク2話.*全13話/);
 assert.deepEqual(await page.evaluate(()=>__shelfTest.groupingTrap()),['series:A','series:B'],'mean rank / episode counts cannot reverse top-member order');
 if(process.env.BOOKSHELF_SCREENSHOT)await page.screenshot({path:process.env.BOOKSHELF_SCREENSHOT});
 // Preserve the shelf DOM and exact scroll offset across standalone reading.
 await page.locator('.pts-bookshelf-scroll').evaluate(el=>{el.scrollTop=200;});
 const top=await page.locator('.pts-bookshelf-scroll').evaluate(el=>el.scrollTop);
 await page.evaluate(()=>__shelfTest.open('work:301'));
 await page.waitForSelector('.pts-pager[dir=rtl]');
 assert.equal((await page.evaluate(()=>__shelfTest.state())).reading,'single');
 await page.locator('.pts-pager').click({position:{x:190,y:300}});await page.keyboard.press('ArrowLeft');
 await page.waitForTimeout(400);assert((await page.locator('.pts-pager').evaluate(el=>el.scrollLeft))<0,'left arrow advances RTL standalone page');
 await page.locator('.pts-close').click();
 assert.equal((await page.evaluate(()=>__shelfTest.state())).reading,null);
 assert.equal(await page.locator('.pts-bookshelf-scroll').evaluate(el=>el.scrollTop),top);
 // Explicit series origin works with zero slides; list-only close also restores shelf.
 await page.evaluate(()=>__shelfTest.open('series:1'));await page.waitForSelector('.pts-series-sheet:not([hidden])');
 await page.locator('.pts-series-close').click();assert.equal((await page.evaluate(()=>__shelfTest.state())).reading,null);
 await page.evaluate(()=>__shelfTest.open('series:1'));
 await page.evaluate(()=>__shelfTest.openEpisode({id:'101',index:0,order:1},{id:'1',order:1,title:'Series 1'}));
 await page.waitForFunction(()=>__shelfTest.state().episode==='101'&&__shelfTest.seriesUI.reading?.imageReady);
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>__shelfTest.state().page===1);
 await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>__shelfTest.state().page===0);
 await page.locator('.pts-series-layer').dispatchEvent('touchstart',{touches:[{identifier:1,clientX:100,clientY:250}]});
 await page.locator('.pts-series-layer').dispatchEvent('touchend',{changedTouches:[{identifier:1,clientX:200,clientY:250}]});
 await page.waitForFunction(()=>__shelfTest.state().page===1);
 await page.waitForTimeout(550);
 await page.locator('.pts-series-image').dispatchEvent('wheel',{deltaY:100});
 await page.waitForFunction(()=>__shelfTest.state().episode==='102');
 assert.equal((await page.evaluate(()=>__shelfTest.state())).page,0,'last page continues to next episode');
 await page.locator('.pts-series-layer').dispatchEvent('touchstart',{touches:[{identifier:1,clientX:100,clientY:400}]});
 await page.locator('.pts-series-layer').dispatchEvent('touchend',{changedTouches:[{identifier:1,clientX:100,clientY:250}]});
 await page.waitForFunction(()=>!__shelfTest.state().episode);
 await page.waitForFunction(()=>document.querySelector('.pts-series-error').textContent.includes('表示条件'));
 assert.equal(await page.locator('.pts-series-artwork').count(),0,'next episode cannot bypass age filter');
 await page.getByRole('button',{name:'本棚へ',exact:true}).click();
 assert.equal(await page.locator('.pts-bookshelf-scroll').evaluate(el=>el.scrollTop),top);
 // Popular is a separate provider; absent xRestrict must be verified before admission.
 await page.getByRole('button',{name:'おすすめ・人気',exact:true}).click();
 await page.waitForFunction(()=>!__shelfTest.state().busy&&__shelfTest.state().entries.every(e=>['ready','excluded'].includes(e.state)));
 state=await page.evaluate(()=>__shelfTest.state());assert.equal(state.source,'popular');
 assert(state.entries.filter(e=>['401','402'].includes(e.id)).every(e=>e.state==='excluded'));
 assert(requests.some(u=>u==='/ranking.php?mode=daily&content=manga&p=1&format=json'));
 // Search uses original ranking, grouping takes the minimum member rank, not an average.
 await page.locator('.pts-bookshelf-tabs [data-source=search]').click();
 await page.locator('.pts-bookshelf-search input').fill('query');
 await page.locator('.pts-bookshelf-search button').click();
 await page.waitForFunction(()=>!__shelfTest.state().busy&&__shelfTest.state().entries.every(e=>e.state==='ready'));
 state=await page.evaluate(()=>__shelfTest.state());const ranked=await page.evaluate(()=>__shelfTest.ranks());
 for(const g of state.groups)assert.equal(g.rank,Math.min(...g.ids.map(id=>ranked.indexOf(id))));
 assert(!state.entries.some(e=>e.id==='101'),'nonmatching first episode is cover/reading only');
 const beforeIds=state.entries.map(e=>e.id);
 await page.evaluate(()=>__shelfTest.open('series:1'));
 await page.evaluate(()=>__shelfTest.openEpisode({id:'101',index:0,order:1},{id:'1',order:1,title:'Series 1'}));
 await page.waitForFunction(()=>__shelfTest.state().episode==='101');
 await page.evaluate(()=>__shelfTest.closeSeries());
 assert.deepEqual((await page.evaluate(()=>__shelfTest.state())).entries.map(e=>e.id),beforeIds,'reading never expands search candidates');
 // Pending popular work cannot appear after switching providers.
 coldPopular=true;failDetail=true;slow=true;await page.evaluate(()=>__shelfTest.source('popular'));await page.waitForTimeout(40);await page.evaluate(()=>__shelfTest.source('search','query'));await page.waitForTimeout(700);slow=false;
 assert.equal((await page.evaluate(()=>__shelfTest.state())).source,'search');
 assert((await page.evaluate(()=>__shelfTest.state())).entries.every(e=>beforeIds.includes(e.id)));
 assert(requests.some(u=>u==='/ajax/illust/601'),'stale source test includes a cold delayed detail');
 // Failed metadata has no automatic retry loop; only the explicit tile retry retries it.
 failDetail=true;await page.evaluate(()=>__shelfTest.source('popular'));
 await page.waitForFunction(()=>__shelfTest.state().entries.some(e=>e.id==='602'&&e.state==='error'));
 const retriesBefore=requests.filter(u=>u==='/ajax/illust/602').length;await page.waitForTimeout(350);
 assert.equal(requests.filter(u=>u==='/ajax/illust/602').length,retriesBefore);
 failDetail=false;await page.locator('[data-tile-key="work:602"]').click();
 await page.waitForFunction(()=>__shelfTest.state().entries.some(e=>e.id==='602'&&e.state==='ready'));
 await page.evaluate(()=>__shelfTest.source('search','missing'));
 await page.waitForFunction(()=>!__shelfTest.state().busy);
 assert.match(await page.locator('.pts-bookshelf-status').textContent(),/表示できる作品がありません/);
 const emptyCount=requests.length;await page.waitForTimeout(350);assert.equal(requests.length,emptyCount,'empty source does not loop');
 const profile=await page.evaluate(()=>__shelfTest.profile());await page.evaluate(()=>__shelfTest.source('bookmarks'));await page.waitForTimeout(350);
 assert.equal(await page.evaluate(()=>__shelfTest.profile()),profile,'source/aggregation/filter exclusion does not train');

 // Filter changes re-route and revalidate a cached first-episode thumbnail.
 await page.locator('.pts-content-filter').click();await page.check('input[name=age][value=r18]');
 await page.getByRole('button',{name:'確定して先頭から開始'}).click();
 await page.waitForFunction(()=>__shelfTest.state().groups.some(g=>g.key==='series:1'&&g.cover));
 state=await page.evaluate(()=>__shelfTest.state());
 assert.equal(state.groups.find(g=>g.key==='series:1').cover.url,'','cached safe first cover cannot bypass R-18-only filter');
 assert.deepEqual(state.groups.find(g=>g.key==='series:1').ids,['103']);
 await page.locator('.pts-content-filter').click();await page.check('input[name=type][value=illust]');
 await page.getByRole('button',{name:'確定して先頭から開始'}).click();
 assert.equal((await page.evaluate(()=>__shelfTest.state())).viewMode,'feed','filter change leaves bookshelf routing');

 // A tag URL starts directly in the search shelf; leaving a standalone reader restores search routing.
 await page.goto('https://www.pixiv.net/tags/query/artworks');await page.addScriptTag({content:injected});
 await page.waitForSelector('#pts-content-filter[open]');await page.check('input[name=type][value=manga]');await page.check('input[name=age][value=safe]');
 await page.getByRole('button',{name:'この条件で開始'}).click();
 await page.waitForFunction(()=>__shelfTest.state().groups.some(g=>g.key==='work:301'));
 assert.equal((await page.evaluate(()=>__shelfTest.state())).source,'search');
 await page.evaluate(()=>__shelfTest.open('work:301'));await page.waitForSelector('.pts-pager[dir=rtl]');
 await page.locator('.pts-content-filter').click();await page.check('input[name=type][value=illust]');
 await page.getByRole('button',{name:'確定して先頭から開始'}).click();
 state=await page.evaluate(()=>__shelfTest.state());assert.equal(state.viewMode,'feed');assert.equal(state.mode,'search');
 assert.deepEqual(errors,[]);
 console.log('PASS: manga routing, staged sparse bookmarks, 3-request cap, series aggregation/first-cover ID matching/counts, standalone RTL, reader/list return offsets, explicit series origin, left-arrow/last-page wheel continuation, popular age verification, original search ranking and minimum-member grouping, search eligibility isolation, stale source results, no acquisition learning.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
