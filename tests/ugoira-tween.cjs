// Run: npm install && node tests/ugoira-tween.cjs (requires Playwright and Chromium).
// うごイラのコマ補間が最後まで通ることを、2通りの入れ方で確認する。
//   userscript: 本体だけをページに入れ、AIのファイルは配信サーバーから取得する
//               （通信は node_modules の同じファイルで代用。jsdelivrのモデル取得を失敗させ、
//                 unpkgへの切り替えも確認する）
//   extension:  ビルドした拡張機能をChromiumに読み込み、同梱のファイルを使う
// 赤い玉が横に動く6コマのうごイラを用意し、再生中のcanvasに映る玉の位置の種類を数える。
// 補間ONなら元の6か所の間が約60fps相当の細かさで埋まり、OFFなら6か所に戻る。
// Chromiumの自動テストではGPUが使えないため、検証用の設定でWASM(CPU)実行に切り替える。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const ext = path.join(root, 'dist/safari-extension');
const SIZE = 128, FRAMES = 6, DELAY = 100;
// テスト環境の画面は60Hzなので目標は60fpsになり、100ms間隔(10fps)は1コマ間を6分割する。つまり中間コマは5枚ずつ。
const STEPS = 6;

function zipStored(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const source = fs.readFileSync(path.join(root, 'pixiv-tate-scroll.user.js'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=', 'base64');
const works = [200, 201, 202].map(id => ({
  id: String(id), illustType: 2, xRestrict: 0, title: 'ugoira', tags: ['test'], userId: '20', userName: 'author',
  url: 'https://www.pixiv.net/image.png', pageCount: 1, bookmarkData: null,
  urls: { regular: 'https://www.pixiv.net/image.png', original: 'https://www.pixiv.net/image.png' },
}));

async function mockPixiv(context, getZip, getFullZip) {
  await context.route('https://www.pixiv.net/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/image.png') return route.fulfill({ contentType: 'image/png', body: PNG });
    if (url.pathname === '/ugoira.zip') return route.fulfill({ contentType: 'application/zip', body: getZip() });
    if (url.pathname === '/ugoira-full.zip') {
      // 高画質版は遅れて届く。補間の途中で差し替わる状況を作る。
      await new Promise(resolve => setTimeout(resolve, 900));
      return route.fulfill({ contentType: 'application/zip', body: getFullZip() });
    }
    if (!url.pathname.startsWith('/ajax/')) {
      return route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="global-data" content=\'{"userData":{"id":"42"}}\'></head><body></body></html>' });
    }
    let body = { works: [], total: 0 };
    if (url.pathname.endsWith('/ugoira_meta')) {
      body = { src: 'https://www.pixiv.net/ugoira.zip', originalSrc: `https://www.pixiv.net/${getFullZip ? 'ugoira-full' : 'ugoira'}.zip`,
        frames: Array.from({ length: FRAMES }, (_, i) => ({ file: `00000${i}.jpg`, delay: DELAY })) };
    } else if (url.pathname.includes('/discovery/') || url.pathname.includes('/recommend/')) {
      body = { thumbnails: { illust: works }, nextIds: [] };
    } else if (/^\/ajax\/illust\/\d+$/.test(url.pathname)) {
      body = works.find(w => w.id === url.pathname.split('/').pop()) || works[0];
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: false, body }) });
  });
}

// 素材: 模様つきの背景の上を赤い玉が左から右へ動く。
async function makeZip(context, SIZE = 128) {
  const maker = await context.newPage();
  await maker.goto('https://www.pixiv.net/blank-for-frames');
  const jpegs = await maker.evaluate(async ({ SIZE, FRAMES }) => {
    const out = [];
    for (let f = 0; f < FRAMES; f++) {
      const c = document.createElement('canvas'); c.width = c.height = SIZE;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, SIZE, SIZE);
      for (let i = 0; i < 30; i++) { g.fillStyle = `hsl(${i * 37},40%,85%)`; g.fillRect((i * 53) % SIZE, (i * 97) % SIZE, SIZE / 8, SIZE / 8); }
      g.fillStyle = '#d00'; g.beginPath(); g.arc(SIZE * (0.2 + 0.12 * f), SIZE / 2, SIZE / 8, 0, 7); g.fill();
      out.push(c.toDataURL('image/jpeg', 0.95).split(',')[1]);
    }
    return out;
  }, { SIZE, FRAMES });
  await maker.close();
  return zipStored(jpegs.map((b64, i) => ({ name: `00000${i}.jpg`, data: Buffer.from(b64, 'base64') })));
}

// 再生中のcanvasを一定時間見て、赤い玉の位置(横方向の重心)を集める。
const positions = (page, SIZE = 128) => page.evaluate(async ({ SIZE }) => {
  const seen = new Set();
  const end = performance.now() + 3200;
  while (performance.now() < end) {
    const canvas = document.querySelector('.pts-current .pts-ugoira-canvas');
    if (canvas?.width === SIZE) {
      const d = canvas.getContext('2d').getImageData(0, 0, SIZE, SIZE).data;
      let sum = 0, n = 0;
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
        const p = (y * SIZE + x) * 4;
        if (d[p] > 150 && d[p + 1] < 80 && d[p + 2] < 80) { sum += x; n++; }
      }
      if (n > 50) seen.add(Math.round(sum / n / SIZE * 200) / 200);
    }
    await new Promise(r => requestAnimationFrame(r));
  }
  return [...seen].sort((a, b) => a - b);
}, { SIZE });

const label = page => page.locator('.pts-current .pts-tween-btn').textContent();
const waitOn = page => page.waitForFunction(
  () => ['コマ補間 ON', 'コマ補間 不可'].includes(document.querySelector('.pts-current .pts-tween-btn')?.textContent),
  null, { timeout: 90000 });

async function checkTween(page, name, size = SIZE) {
  const button = page.locator('.pts-current .pts-tween-btn');
  await waitOn(page);
  assert.equal(await label(page), 'コマ補間 ON', `${name}: ${await button.getAttribute('title')}`);
  const on = await positions(page, size);
  if (process.env.PTS_SHOT) await page.screenshot({ path: process.env.PTS_SHOT });
  // 最後→最初の継ぎ目は場面転換扱いで補間しないので、対象は FRAMES-1 個のコマ間。
  const expected = FRAMES + (FRAMES - 1) * (STEPS - 1);
  assert(on.length >= expected - 4, `${name}: 60fps相当まで中間位置が増える(${expected}か所前後): ${on}`);
  const gaps = on.slice(1).map((v, i) => v - on[i]);
  // 元のコマ同士は0.12離れている。6分割なら隣との差は約0.02。
  assert(Math.max(...gaps) <= 0.045, `${name}: 玉がコマ間に均等に描かれている: ${on}`);
  await button.click();
  assert.equal(await label(page), 'コマ補間 OFF');
  await page.waitForTimeout(300);
  const off = await positions(page, size);
  assert.equal(off.length, FRAMES, `${name}: 補間OFFで元のコマだけに戻る: ${off}`);
  await button.click();
  assert.equal(await label(page), 'コマ補間 ON', `${name}: 作成済みの中間コマを再利用する`);
  console.log(`ugoira-tween ${name}: ok (ON ${on.length}か所 / OFF ${off.length}か所)`);
}

const forceWasm = () => { try { localStorage.setItem('PTS_UGOIRA_TWEEN_BACKEND', 'wasm'); } catch {} };

// 目標fpsと分割数の決め方。100fpsを目標に、画面の更新回数を上限にする。
async function factorUnit() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await mockPixiv(context, () => Buffer.alloc(0));
    const page = await context.newPage();
    await page.goto('https://www.pixiv.net/blank-for-unit');
    await page.addScriptTag({ content: source.replace(/\}\)\(\);\s*$/, 'window.__tween = { tweenFactor, tweenTasks, tweenTargetFps, hz: () => displayHz };})();') });
    await page.waitForTimeout(1200);
    const got = await page.evaluate(() => ({
      hz: __tween.hz(), target: __tween.tweenTargetFps(),
      at100: [100, 50, 20, 12, 200].map(d => __tween.tweenFactor(d, 100)),
      at60: [100, 50, 20, 12, 200].map(d => __tween.tweenFactor(d, 60)),
      order: __tween.tweenTasks([10, 1, 4]).map(t => `${t.i}:${t.k}/${t.n}`),
    }));
    assert.equal(got.hz, 60, 'テスト環境の画面は60Hz');
    assert.equal(got.target, 60, '60Hzの画面では60fpsを上限にする');
    assert.deepEqual(got.at100, [10, 5, 2, 1, 12], '100fps目標: 100msは10分割、遅い作品は12分割まで');
    assert.deepEqual(got.at60, [6, 3, 1, 1, 12], '60fps目標: 100msは6分割');
    assert.deepEqual(got.order.slice(0, 2), ['0:5/10', '2:2/4'], 'まず各コマ間の真ん中から作る');
    assert.equal(got.order.length, 9 + 3, '10分割は9枚、4分割は3枚、1分割は0枚');
    console.log('ugoira-tween factor: ok');
  } finally {
    await browser.close();
  }
}

async function userscriptMode() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let zip = null;
    await mockPixiv(context, () => zip);
    const cdn = [];
    const serve = (route, file) => route.fulfill({
      body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' },
      contentType: file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
    });
    const modules = path.join(root, 'node_modules');
    for (const host of ['cdn.jsdelivr.net/npm', 'unpkg.com']) {
      await context.route(`https://${host}/**`, route => {
        const url = new URL(route.request().url());
        cdn.push(url.host + url.pathname);
        const ort = url.pathname.match(/onnxruntime-web@1\.30\.0\/dist\/([\w.-]+)$/);
        if (ort) return serve(route, path.join(modules, 'onnxruntime-web/dist', ort[1]));
        if (url.pathname.endsWith('/@bvdmitri/webtween@0.2.1/models/rife-4.25-fp32.onnx')) {
          // 1つ目の取得元ではモデルを取得できない場合を再現する。
          if (url.host === 'cdn.jsdelivr.net') return route.fulfill({ status: 403, body: 'too large' });
          return serve(route, path.join(modules, '@bvdmitri/webtween/models/rife-4.25-fp32.onnx'));
        }
        return route.fulfill({ status: 404, body: '' });
      });
    }
    zip = await makeZip(context);
    await context.addInitScript(forceWasm);
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://www.pixiv.net/');
    await page.addScriptTag({ content: source });
    await page.getByRole('button', { name: 'この条件で開始' }).click();
    const button = page.locator('.pts-current .pts-tween-btn');
    await button.waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await label(page), 'コマ補間 OFF', 'ユーザースクリプト版は初期値OFF');
    await page.waitForTimeout(500);
    assert.deepEqual(cdn, [], 'ONにするまで配信サーバーへ通信しない');
    await button.click();
    await checkTween(page, 'userscript');
    assert(cdn.some(u => u.startsWith('unpkg.com') && u.endsWith('.onnx')), '2つ目の取得元に切り替わる');
    assert.deepEqual(errors, [], 'no page errors');

    // 2回目は端末に保存したモデルを使い、モデルを取り直さない。
    cdn.length = 0;
    await page.reload();
    await page.addScriptTag({ content: source });
    await page.getByRole('button', { name: 'この条件で開始' }).click();
    await waitOn(page);
    assert.equal(await label(page), 'コマ補間 ON', '設定を覚えている');
    assert(!cdn.some(u => u.startsWith('unpkg.com') && u.endsWith('.onnx')), `保存済みモデルを使う: ${cdn}`);
    console.log('ugoira-tween userscript: 2回目は保存済みモデルを使用');
  } finally {
    await browser.close();
  }
}

// 小さいZIPで再生と補間を始め、途中で高画質ZIPに差し替わる場合。
// 作成済みの中間コマ(小さい)を捨てずに、高画質のコマと混ぜて同じcanvasに描けること。
async function hiResMode() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let zip = null, full = null;
    await mockPixiv(context, () => zip, () => full);
    const modules = path.join(root, 'node_modules');
    let modelFetches = 0;
    await context.route('https://cdn.jsdelivr.net/npm/**', route => {
      const url = new URL(route.request().url());
      const ort = url.pathname.match(/onnxruntime-web@1\.30\.0\/dist\/([\w.-]+)$/);
      const file = ort ? path.join(modules, 'onnxruntime-web/dist', ort[1])
        : path.join(modules, '@bvdmitri/webtween/models/rife-4.25-fp32.onnx');
      if (!ort) modelFetches++;
      return route.fulfill({ body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' },
        contentType: file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
    });
    zip = await makeZip(context, SIZE);
    full = await makeZip(context, SIZE * 2);
    await context.addInitScript(() => { try { localStorage.setItem('PTS_UGOIRA_TWEEN_BACKEND', 'wasm'); localStorage.setItem('PTS_UGOIRA_TWEEN_V1', 'on'); } catch {} });
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://www.pixiv.net/');
    await page.addScriptTag({ content: source });
    await page.getByRole('button', { name: 'この条件で開始' }).click();
    await page.locator('.pts-current .pts-tween-btn').waitFor({ state: 'visible', timeout: 15000 });
    // 完了前から、できた分の中間コマが再生に混ざり始める。
    await page.waitForFunction(() => /準備中 [1-9]/.test(document.querySelector('.pts-current .pts-tween-btn')?.textContent || ''), null, { timeout: 60000 });
    await checkTween(page, 'hi-res', SIZE * 2);
    assert.equal(modelFetches, 1, 'モデルの取得は1回');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
  }
}

async function extensionMode() {
  execFileSync('node', [path.join(root, 'scripts/build-safari.cjs')], { stdio: 'inherit' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-tween-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 390, height: 844 },
    args: ['--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let zip = null;
    await mockPixiv(context, () => zip);
    const outside = [];
    await context.route(/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\//, route => { outside.push(route.request().url()); return route.abort(); });
    zip = await makeZip(context);
    await context.addInitScript(forceWasm);
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://www.pixiv.net/');
    await page.getByRole('button', { name: 'この条件で開始' }).click();
    await page.locator('.pts-current .pts-tween-btn').waitFor({ state: 'visible', timeout: 15000 });
    await checkTween(page, 'extension');
    assert.deepEqual(outside, [], '拡張機能版は配信サーバーへ通信しない');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

(async () => {
  await factorUnit();
  await userscriptMode();
  await hiResMode();
  await extensionMode();
})().catch(e => { console.error(e); process.exit(1); });
