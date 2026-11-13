// Run: node scripts/build-safari.cjs
// ユーザースクリプト本体を Safari Web Extension の形に組み立てて
// dist/safari-extension/ に出力する。依存パッケージなし。
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'safari-extension');
const out = path.join(root, 'dist', 'safari-extension');
const script = fs.readFileSync(path.join(root, 'pixiv-tate-scroll.user.js'), 'utf8');

const header = script.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
if (!header) throw new Error('UserScriptヘッダーが見つかりません');
const meta = key => {
  const m = header[1].match(new RegExp(`^// @${key}\\s+(.+)$`, 'm'));
  if (!m) throw new Error(`@${key} が見つかりません`);
  return m[1].trim();
};
const version = meta('version');
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`拡張機能で使えないバージョン表記: ${version}`);
if (meta('grant') !== 'none') throw new Error('@grant none 以外は拡張機能側の対応が必要です');

const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
manifest.version = version;
manifest.content_scripts[0].matches = [meta('match')];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(src, 'icons'), path.join(out, 'icons'), { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'content.js'), script);
console.log(`dist/safari-extension を作成しました (v${version})`);
