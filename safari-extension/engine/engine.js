// うごイラの中間コマを作る補間エンジン。
// 拡張機能のページとしてpixivのページ内のiframeで動き、コンテンツスクリプトと
// postMessageでやり取りする。AIモデル(RIFE 4.25)はonnxruntime-webで実行する。
import * as ort from './ort/ort.min.mjs';

const ALLOWED_ORIGIN = 'https://www.pixiv.net';
const ALIGN = 64;            // モデルが要求する辺の倍数
const CUT_THRESHOLD = 0.16;  // これより差が大きい2コマは場面転換とみなして補間しない
const SAME_THRESHOLD = 0.0005;
const JPEG_QUALITY = 0.92;

ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? 0 : 1;

let sessionPromise = null;
let backend = '';
const packed = new Map(); // key -> {key, width, height, pw, ph, data, luma}
let chain = Promise.resolve();

async function hasWebGpu() {
  try {
    return !!(navigator.gpu && await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function openSession(force) {
  const model = new Uint8Array(await (await fetch(new URL('./rife-4.25-fp32.onnx', import.meta.url))).arrayBuffer());
  const order = force ? [force] : (await hasWebGpu() ? ['webgpu', 'wasm'] : ['wasm']);
  let lastError;
  for (const name of order) {
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: [name], graphOptimizationLevel: 'all',
      });
      backend = name;
      return session;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('モデルを開けません');
}

function getSession(force) {
  if (!sessionPromise) {
    sessionPromise = openSession(force).catch(e => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

function workSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const up = v => Math.ceil(v / ALIGN) * ALIGN;
  return { w, h, pw: up(w), ph: up(h) };
}

// 画像を作業サイズに縮め、モデル入力(R,G,Bの面を並べた0..1の値)にする。
// 余白は端の画素を繰り返して埋める。
async function pack(key, blob, maxSide) {
  const hit = packed.get(key);
  if (hit && hit.maxSide === maxSide) return hit;
  const bitmap = await createImageBitmap(blob);
  try {
    const { w, h, pw, ph } = workSize(bitmap.width, bitmap.height, maxSide);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const plane = pw * ph;
    const data = new Float32Array(plane * 3);
    let lumaStep = Math.max(1, Math.floor(Math.max(w, h) / 64));
    const luma = [];
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(y, h - 1);
      for (let x = 0; x < pw; x++) {
        const sx = Math.min(x, w - 1);
        const src = (sy * w + sx) * 4, at = y * pw + x;
        const r = rgba[src] / 255, g = rgba[src + 1] / 255, b = rgba[src + 2] / 255;
        data[at] = r; data[plane + at] = g; data[2 * plane + at] = b;
        if (y < h && x < w && y % lumaStep === 0 && x % lumaStep === 0) {
          luma.push(0.299 * r + 0.587 * g + 0.114 * b);
        }
      }
    }
    const entry = { key, maxSide, width: bitmap.width, height: bitmap.height, w, h, pw, ph, data, luma };
    packed.set(key, entry);
    while (packed.size > 3) packed.delete(packed.keys().next().value);
    return entry;
  } finally {
    bitmap.close();
  }
}

function difference(a, b) {
  const n = Math.min(a.luma.length, b.luma.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.luma[i] - b.luma[i]);
  return sum / n;
}

async function unpack(out, a) {
  const { w, h, pw, ph } = a;
  const plane = pw * ph;
  const image = new ImageData(w, h);
  const px = image.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = y * pw + x, to = (y * w + x) * 4;
      px[to] = out[at] * 255 + 0.5;
      px[to + 1] = out[plane + at] * 255 + 0.5;
      px[to + 2] = out[2 * plane + at] * 255 + 0.5;
      px[to + 3] = 255;
    }
  }
  const small = new OffscreenCanvas(w, h);
  small.getContext('2d').putImageData(image, 0, 0);
  // 再生側のcanvasは元コマの大きさなので、同じ大きさに戻して返す。
  let canvas = small;
  if (w !== a.width || h !== a.height) {
    canvas = new OffscreenCanvas(a.width, a.height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, a.width, a.height);
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}

async function tween(msg) {
  const started = performance.now();
  const maxSide = Math.max(64, Math.min(2048, Number(msg.maxSide) || 640));
  const a = await pack(msg.aKey, msg.a, maxSide);
  const b = await pack(msg.bKey, msg.b, maxSide);
  if (a.width !== b.width || a.height !== b.height) return { skip: 'size' };
  const diff = difference(a, b);
  if (diff < SAME_THRESHOLD) return { skip: 'same', diff };
  if (diff > CUT_THRESHOLD) return { skip: 'cut', diff };
  const session = await getSession(msg.backend);
  const dims = [1, 3, a.ph, a.pw];
  const t = Math.min(0.999, Math.max(0.001, Number(msg.t) || 0.5));
  const result = await session.run({
    img0: new ort.Tensor('float32', a.data, dims),
    img1: new ort.Tensor('float32', b.data, dims),
    timestep: new ort.Tensor('float32', new Float32Array([t]), [1]),
  });
  const output = result.output;
  const data = await output.getData();
  const blob = await unpack(data, a);
  output.dispose?.();
  return { blob, diff, backend, ms: Math.round(performance.now() - started), work: `${a.w}x${a.h}` };
}

async function handle(msg) {
  if (msg.cmd === 'init') {
    await getSession(msg.backend);
    return { backend };
  }
  if (msg.cmd === 'tween') return tween(msg);
  if (msg.cmd === 'reset') {
    packed.clear();
    return {};
  }
  throw new Error('unknown command');
}

addEventListener('message', event => {
  if (event.source !== parent || event.origin !== ALLOWED_ORIGIN) return;
  const msg = event.data;
  if (!msg || msg.type !== 'pts-interp' || typeof msg.id !== 'number') return;
  // モデルの実行は重ねられないので、依頼は1件ずつ順に処理する。
  chain = chain.then(async () => {
    let reply;
    try {
      reply = { ...(await handle(msg)), ok: true };
    } catch (e) {
      reply = { ok: false, error: String(e?.message || e) };
    }
    parent.postMessage({ type: 'pts-interp-reply', id: msg.id, ...reply }, ALLOWED_ORIGIN);
  });
});

parent.postMessage({ type: 'pts-interp-ready' }, ALLOWED_ORIGIN);
