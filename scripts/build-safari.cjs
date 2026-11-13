// Run: npm install && node scripts/build-safari.cjs
// ユーザースクリプト本体と補間エンジンを Safari Web Extension の形に組み立てて
// dist/safari-extension/ に出力する。
const crypto = require('node:crypto');
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

const dep = name => {
  const dir = path.join(root, 'node_modules', name);
  if (!fs.existsSync(dir)) throw new Error(`${name} がありません。先に npm install を実行してください`);
  return dir;
};
const ortDist = path.join(dep('onnxruntime-web'), 'dist');
const models = path.join(dep('@bvdmitri/webtween'), 'models');
const model = JSON.parse(fs.readFileSync(path.join(models, 'manifest.json'), 'utf8')).models[0];
const modelBytes = fs.readFileSync(path.join(models, model.file));
if (crypto.createHash('sha256').update(modelBytes).digest('hex') !== model.sha256) {
  throw new Error('補間モデルのハッシュが一致しません');
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'engine', 'ort'), { recursive: true });
fs.cpSync(path.join(src, 'icons'), path.join(out, 'icons'), { recursive: true });
fs.cpSync(path.join(src, 'engine'), path.join(out, 'engine'), { recursive: true });
fs.copyFileSync(path.join(src, 'bridge.js'), path.join(out, 'bridge.js'));
// 補間エンジンが使う実行ライブラリ(WebGPU/WASM)とAIモデル。合わせて約50MB。
for (const file of ['ort.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  fs.copyFileSync(path.join(ortDist, file), path.join(out, 'engine', 'ort', file));
}
fs.writeFileSync(path.join(out, 'engine', model.file), modelBytes);
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'content.js'), script);
console.log(`dist/safari-extension を作成しました (v${version})`);
