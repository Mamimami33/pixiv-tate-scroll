// Run: npm install && node scripts/build-safari.cjs
// ユーザースクリプト本体とAIコマ補間のファイルを Safari Web Extension の形に組み立てて
// dist/safari-extension/ に出力する。
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
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

// 立体視の奥行きモデル。配布元のパッケージは依存が多いので、インストールはせず、
// パッケージの中からモデルのファイルだけを取り出す（ハッシュを確認し、2回目以降は使い回す）。
const DEPTH = {
  pkg: '@richardmcquiston01/ai-tools@0.5.1', file: 'depth-anything-v2-small.onnx',
  sha256: 'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d',
};
function depthModel() {
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const cacheDir = path.join(root, 'node_modules', '.cache', 'pts-models');
  const cached = path.join(cacheDir, DEPTH.file);
  if (!fs.existsSync(cached) || sha(cached) !== DEPTH.sha256) {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pts-model-'));
    try {
      execFileSync('npm', ['pack', DEPTH.pkg, '--silent', '--ignore-scripts', '--pack-destination', tmp], { cwd: tmp, stdio: 'ignore' });
      const tarball = fs.readdirSync(tmp).find(name => name.endsWith('.tgz'));
      execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', tmp, `package/models/${DEPTH.file}`]);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.copyFileSync(path.join(tmp, 'package', 'models', DEPTH.file), cached);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (sha(cached) !== DEPTH.sha256) throw new Error('奥行きモデルのハッシュが一致しません');
  }
  return cached;
}
const depthFile = depthModel();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'engine', 'ort'), { recursive: true });
fs.cpSync(path.join(src, 'icons'), path.join(out, 'icons'), { recursive: true });
fs.copyFileSync(path.join(src, 'bridge.js'), path.join(out, 'bridge.js'));
// コマ補間と立体視が使う実行ライブラリ(WebGPU/WASM)とAIモデル。合わせて約80MB。
for (const file of ['ort.min.mjs', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  fs.copyFileSync(path.join(ortDist, file), path.join(out, 'engine', 'ort', file));
}
fs.writeFileSync(path.join(out, 'engine', model.file), modelBytes);
fs.copyFileSync(depthFile, path.join(out, 'engine', DEPTH.file));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'content.js'), script);
console.log(`dist/safari-extension を作成しました (v${version})`);
