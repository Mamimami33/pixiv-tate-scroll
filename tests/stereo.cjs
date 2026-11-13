// Run: npm install && node tests/stereo.cjs (requires Playwright and Chromium).
// 裸眼立体視（平行法・交差法）の確認。
//   1. 左右の絵を作る計算(stereoWarp)を、奥行きが分かっている合成データで確かめる
//   2. ユーザースクリプト版: 画像を許可つきで1回だけ読み、AIで奥行きを推定して左右の絵を並べる
//   3. 配信サーバーが画素の読み取りを許可しない場合は「不可」で止まり、取り直さない
//   4. 拡張機能版: 同梱のファイルだけで動く
// 通信は node_modules の同じファイルと、テスト用に描いた絵で代用する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const ext = path.join(root, 'dist/safari-extension');
const source = fs.readFileSync(path.join(root, 'pixiv-tate-scroll.user.js'), 'utf8');
const modules = path.join(root, 'node_modules');
execFileSync('node', [path.join(root, 'scripts/build-safari.cjs')], { stdio: 'inherit' });
const depthModel = path.join(ext, 'engine/depth-anything-v2-small.onnx');

const works = [300, 301].map(id => ({
  id: String(id), illustType: 0, xRestrict: 0, title: 'still', tags: ['test'], userId: '20', userName: 'author',
  url: `https://i.pximg.net/img/${id}.png`, pageCount: 1, bookmarkData: null,
  urls: { regular: `https://i.pximg.net/img/${id}.png`, original: `https://i.pximg.net/img/${id}.png` },
}));

// allowPixels=false は、配信サーバーが画素の読み取りを許可しない状態。
async function mock(context, { allowPixels, picture }) {
  const seen = { pixelLoads: 0, cdn: [] };
  await context.route('https://www.pixiv.net/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/ajax/')) {
      return route.fulfill({ contentType: 'text/html', body: '<html><head><meta name="global-data" content=\'{"userData":{"id":"42"}}\'></head><body></body></html>' });
    }
    let body = { works: [], total: 0 };
    if (url.pathname.includes('/discovery/') || url.pathname.includes('/recommend/')) body = { thumbnails: { illust: works }, nextIds: [] };
    else if (/^\/ajax\/illust\/\d+$/.test(url.pathname)) body = works.find(w => w.id === url.pathname.split('/').pop()) || works[0];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: false, body }) });
  });
  await context.route('https://i.pximg.net/**', async route => {
    const headers = await route.request().allHeaders();
    // 画素を読むための読み込み(CORS)は Origin ヘッダーが付く。通常の表示用の読み込みには付かない。
    if (headers['origin']) {
      seen.pixelLoads++;
      // 実機で報告された状態の再現: 画素を読むための読み込みには403が返る。
      if (!allowPixels) return route.fulfill({ status: 403, body: '' });
    }
    return route.fulfill({ contentType: 'image/png', body: picture(), headers: { 'access-control-allow-origin': 'https://www.pixiv.net' } });
  });
  await context.route(/^https:\/\/(cdn\.jsdelivr\.net|unpkg\.com)\//, route => {
    const url = new URL(route.request().url());
    seen.cdn.push(url.host + url.pathname);
    const ort = url.pathname.match(/onnxruntime-web@1\.30\.0\/dist\/([\w.-]+)$/);
    const file = ort ? path.join(modules, 'onnxruntime-web/dist', ort[1])
      : url.pathname.endsWith('/@richardmcquiston01/ai-tools@0.5.1/models/depth-anything-v2-small.onnx') ? depthModel : null;
    if (!file || url.host !== 'cdn.jsdelivr.net') return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' },
      contentType: file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
  });
  return seen;
}

// 絵: 奥へ続く床と空の手前に、赤い玉が1つある。
async function makePicture(context) {
  const page = await context.newPage();
  await page.goto('https://www.pixiv.net/blank-for-picture');
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 360; c.height = 480;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 260); sky.addColorStop(0, '#6aa5e8'); sky.addColorStop(1, '#dfeeff');
    g.fillStyle = sky; g.fillRect(0, 0, 360, 260);
    const floor = g.createLinearGradient(0, 260, 0, 480); floor.addColorStop(0, '#b9c7a0'); floor.addColorStop(1, '#5f7a45');
    g.fillStyle = floor; g.fillRect(0, 260, 360, 220);
    for (let i = 0; i < 9; i++) { g.strokeStyle = '#4c6338'; g.beginPath(); g.moveTo(180, 260); g.lineTo(-360 + i * 135, 480); g.stroke(); }
    const ball = g.createRadialGradient(165, 300, 10, 180, 320, 80); ball.addColorStop(0, '#ff8a80'); ball.addColorStop(1, '#b00010');
    g.fillStyle = ball; g.beginPath(); g.arc(180, 320, 80, 0, 7); g.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.close();
  return Buffer.from(b64, 'base64');
}

// 立体視のcanvasから、左右それぞれの絵の中での赤い玉の位置(横方向の重心、0..1)を読む。
const readHalves = page => page.evaluate(() => {
  const canvas = document.querySelector('.pts-current .pts-stereo-canvas');
  if (!canvas) return null;
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const half = Math.round(canvas.width / 2.04), gap = canvas.width - half * 2;
  const centroid = from => {
    let sum = 0, n = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < half; x++) {
      const p = (y * canvas.width + from + x) * 4;
      if (d[p] > 150 && d[p + 1] < 110 && d[p + 2] < 110) { sum += x; n++; }
    }
    return n > 200 ? sum / n / half : null;
  };
  let empty = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) empty++;
  return { mode: canvas.dataset.mode, width: canvas.width, height: canvas.height, left: centroid(0), right: centroid(half + gap), empty };
});

const label = page => page.locator('.pts-current .pts-stereo-btn').textContent();
const settled = (page, texts) => page.waitForFunction(
  texts => texts.includes(document.querySelector('.pts-current .pts-stereo-btn')?.textContent), texts, { timeout: 90000 });

async function warpUnit(browser) {
  const context = await browser.newContext();
  await mock(context, { allowPixels: true, picture: () => Buffer.alloc(0) });
  const page = await context.newPage();
  await page.goto('https://www.pixiv.net/blank-for-unit');
  await page.addScriptTag({ content: source.replace(/\}\)\(\);\s*$/, 'window.__stereo = { stereoWarp };})();') });
  const result = await page.evaluate(() => {
    // 幅100の1行。背景(奥行き0)は場所ごとに違う色、x=40..59が手前(奥行き1)の赤い帯。
    const W = 100, H = 3, src = new Uint8ClampedArray(W * H * 4), depth = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const near = x >= 40 && x < 60, p = (y * W + x) * 4;
      src.set(near ? [255, 0, 0, 255] : [0, x * 2, 255 - x * 2, 255], p);
      depth[y * W + x] = near ? 1 : 0;
    }
    const red = out => { const xs = []; for (let x = 0; x < W; x++) if (out[(W + x) * 4] === 255 && out[(W + x) * 4 + 1] === 0) xs.push(x); return [xs[0], xs.at(-1), xs.length]; };
    const holes = out => { let n = 0; for (let i = 3; i < out.length; i += 4) if (out[i] !== 255) n++; return n; };
    const left = __stereo.stereoWarp(src, depth, W, H, 5, 0), right = __stereo.stereoWarp(src, depth, W, H, -5, 0);
    const none = __stereo.stereoWarp(src, depth, W, H, 0, 0);
    return { left: red(left), right: red(right), holes: holes(left) + holes(right),
      background: [left[(W + 10) * 4 + 1], right[(W + 90) * 4 + 1]],
      revealed: [left[(W + 42) * 4], right[(W + 57) * 4]],
      same: none.every((v, i) => v === src[i]) };
  });
  assert.deepEqual(result.left, [45, 64, 20], '左目用: 手前の帯が右へ5画素ずれる');
  assert.deepEqual(result.right, [35, 54, 20], '右目用: 手前の帯が左へ5画素ずれる');
  assert.equal(result.holes, 0, '隙間は残らない');
  assert.deepEqual(result.background, [20, 180], '奥の画素は動かない');
  assert.deepEqual(result.revealed, [0, 0], '帯がどいて現れた所は奥の絵で埋まる');
  assert(result.same, 'ずらし量0なら元の絵のまま');
  await context.close();
  console.log('stereo warp: ok');
}

async function open(context, viaExtension) {
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://www.pixiv.net/');
  if (!viaExtension) await page.addScriptTag({ content: source });
  await page.getByRole('button', { name: 'この条件で開始' }).click();
  await page.locator('.pts-current .pts-stereo-btn').waitFor({ state: 'visible', timeout: 15000 });
  return { page, errors };
}

async function checkStereo(page, name) {
  const button = page.locator('.pts-current .pts-stereo-btn');
  assert.equal(await label(page), '立体視 OFF', `${name}: 初期値はOFF`);
  await button.click();
  await settled(page, ['立体視 平行法', '立体視 不可']);
  assert.equal(await label(page), '立体視 平行法', `${name}: ${await button.getAttribute('title')}`);
  const parallel = await readHalves(page);
  if (process.env.PTS_SHOT) await page.locator('.pts-current .pts-stereo-canvas').evaluate((c, file) => c.toDataURL('image/png'), null).then(url => fs.writeFileSync(process.env.PTS_SHOT, Buffer.from(url.split(',')[1], 'base64')));
  assert(parallel && parallel.left != null && parallel.right != null, `${name}: 左右に絵が並ぶ: ${JSON.stringify(parallel)}`);
  assert.equal(parallel.mode, 'parallel');
  assert.equal(parallel.empty, 0, `${name}: 塗り残しがない`);
  // 平行法は左に左目用。左目から見ると手前の玉は右へずれるので、左の絵の玉のほうが右にある。
  assert(parallel.left - parallel.right > 0.004, `${name}: 平行法で玉が手前に出る向き: ${JSON.stringify(parallel)}`);
  await button.click();
  assert.equal(await label(page), '立体視 交差法');
  const cross = await readHalves(page);
  assert.equal(cross.mode, 'cross');
  assert(cross.right - cross.left > 0.004, `${name}: 交差法は左右が入れ替わる: ${JSON.stringify(cross)}`);
  assert(Math.abs(cross.left - parallel.right) < 1e-9, `${name}: 切り替えで作り直さない`);
  await button.click();
  assert.equal(await label(page), '立体視 OFF');
  assert.equal(await page.locator('.pts-current .pts-stereo-canvas').count(), 0, `${name}: OFFで元の表示に戻る`);
  return parallel;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    await warpUnit(browser);

    let picture = null;
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const seen = await mock(context, { allowPixels: true, picture: () => picture });
      picture = await makePicture(context);
      const { page, errors } = await open(context, false);
      await page.waitForTimeout(400);
      assert.deepEqual(seen.cdn, [], 'ONにするまで配信サーバーへ通信しない');
      assert.equal(seen.pixelLoads, 0, 'ONにするまで画像を読み直さない');
      const got = await checkStereo(page, 'userscript');
      assert.equal(seen.pixelLoads, 1, '画素の読み込みは1作品につき1回');
      assert.deepEqual(errors, [], 'no page errors');
      console.log(`stereo userscript: ok (玉の位置 左${got.left.toFixed(3)} / 右${got.right.toFixed(3)}、${got.width}x${got.height})`);
      await context.close();
    }
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const seen = await mock(context, { allowPixels: false, picture: () => picture });
      const { page, errors } = await open(context, false);
      const button = page.locator('.pts-current .pts-stereo-btn');
      await button.click();
      await settled(page, ['立体視 平行法', '立体視 不可']);
      assert.equal(await label(page), '立体視 不可', '画素を読めなければ不可になる');
      assert.match(await button.getAttribute('title'), /画素を読めません/);
      assert.equal(await page.locator('.pts-current .pts-stereo-canvas').count(), 0, '元の表示のまま');
      for (let i = 0; i < 3; i++) await button.click(); // 交差法 → OFF → 平行法
      await page.waitForTimeout(600);
      assert.equal(await label(page), '立体視 不可');
      assert.equal(seen.pixelLoads, 1, '断られたら取り直さない');
      assert(!seen.cdn.some(u => u.endsWith('.onnx')), '画素を読めないならAIも取得しない');
      assert.deepEqual(errors, [], 'no page errors');
      console.log('stereo blocked: ok (1回試して停止)');
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-stereo-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 390, height: 844 },
    args: ['--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let picture = null;
    const seen = await mock(context, { allowPixels: true, picture: () => picture });
    picture = await makePicture(context);
    const { page, errors } = await open(context, true);
    const got = await checkStereo(page, 'extension');
    assert.deepEqual(seen.cdn, [], '拡張機能版は配信サーバーへ通信しない');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`stereo extension: ok (玉の位置 左${got.left.toFixed(3)} / 右${got.right.toFixed(3)})`);
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
