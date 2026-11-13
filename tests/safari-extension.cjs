// Run: node tests/safari-extension.cjs (requires Playwright and Chromium).
// ビルドした拡張機能をChromiumに読み込み、pixivのページでコンテンツスクリプトとして
// 起動することを確認する。Safari固有の動作はここでは検証できない。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
execFileSync('node', [path.join(root, 'scripts/build-safari.cjs')], { stdio: 'inherit' });
const ext = path.join(root, 'dist/safari-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'pixiv-tate-scroll.user.js'), 'utf8');
assert.equal(manifest.version, source.match(/@version\s+(\S+)/)[1], 'version matches userscript');
assert.equal(fs.readFileSync(path.join(ext, 'content.js'), 'utf8'), source, 'content.js is the userscript');
for (const file of Object.values(manifest.icons)) assert(fs.existsSync(path.join(ext, file)), file);

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-ext-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/ajax/')) return route.fulfill({ json: { error: false, body: {} } });
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><main>pixiv</main></body></html>' });
    });
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://www.pixiv.net/tags/test/artworks');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].length > 0, null, { timeout: 8000 });
    // 拡張機能のコンテンツスクリプトは隔離された環境で動くので、ページ側からは目印が見えない。
    assert.equal(await page.evaluate(() => window.__ptsLoaded), undefined, 'runs in isolated world');
    assert.deepEqual(errors, [], 'no page errors');
    const other = await context.newPage();
    await other.goto('https://example.com/');
    await other.waitForTimeout(500);
    assert.equal(await other.evaluate(() => document.querySelectorAll('button').length), 0, 'not injected elsewhere');
    console.log('safari-extension: ok');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
