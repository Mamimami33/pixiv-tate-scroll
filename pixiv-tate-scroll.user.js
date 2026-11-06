// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      3.8.0
// @description  今開いているpixivのページに並んでいる作品を、元画像で1枚ずつTikTok風に縦スクロールして眺めるビューアです。複数枚は横スライド、うごイラはアニメーション再生。
// @match        https://www.pixiv.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__ptsLoaded) {
    const existing = document.getElementById('pts-launch');
    if (existing) existing.click();
    return;
  }
  window.__ptsLoaded = true;

  let overlay = null;
  let feedEl = null;
  let slides = [];
  let pageLoadBusy = false;
  let pageLoadMisses = 0;
  let mode = 'page'; // 'page' | 'related'
  let nearObs = null;
  // 画像サーバーへの接続を先に温めておく（初回表示の高速化）
  const pc = document.createElement('link');
  pc.rel = 'preconnect';
  pc.href = 'https://i.pximg.net';
  pc.crossOrigin = 'anonymous';
  document.head.appendChild(pc);

  let quality = 'orig'; // 表示中の1枚は元画像、近くの先読みは1200px。'fast' にすると全体1200px止まり

  function pickPair(urls) {
    if (!urls) return { r: '', o: '' };
    return { r: urls.regular || urls.original || '', o: urls.original || urls.regular || '' };
  }

  /* ---------- ページ内スキャン（3段構え） ---------- */

  function idFromImgUrl(u) {
    if (!u) return null;
    const m = u.match(/\/(\d{5,})_(?:p\d+_|square1200|custom1200|master1200|ugoira)/);
    return m ? m[1] : null;
  }

  function pickBestSrc(img) {
    const candidates = [];
    const ds = img.getAttribute('data-src');
    if (ds) candidates.push(ds);
    const ss = img.getAttribute('srcset');
    if (ss) {
      const parts = ss.split(',').map((p) => p.trim().split(/\s+/)).filter((p) => p[0]);
      parts.sort((x, y) => (parseInt(y[1]) || 0) - (parseInt(x[1]) || 0));
      if (parts.length) candidates.push(parts[0][0]);
    }
    if (img.currentSrc) candidates.push(img.currentSrc);
    if (img.src) candidates.push(img.src);
    for (const c of candidates) {
      if (c && c.includes('i.pximg.net')) return c;
    }
    return '';
  }

  function newSlide(id, thumb, title, author) {
    return {
      id, thumb: thumb || '', title: title || '', author: author || '',
      page: `https://www.pixiv.net/artworks/${id}`,
      resolved: false, resolving: false, kind: 'single', // 'single' | 'multi' | 'ugoira'
      pairs: null, // [{r: 1200px, o: 元画像}]
      frames: null, zipUrl: null, frameBase: null, frameExt: null,
      sectionEl: null, mainImg: null, titleEl: null, authorEl: null, pageChip: null,
      animTimer: null, animIdx: 0, frameUrls: null, isCurrent: false,
      tags: null, userId: null, bookmarked: false, bookmarkBtn: null,
    };
  }

  function scanPage() {
    const seen = new Set(slides.map((s) => s.id));
    const items = [];
    const push = (id, thumb, title) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      items.push(newSlide(id, thumb, title, ''));
    };

    document.querySelectorAll('img').forEach((img) => {
      if (overlay && overlay.contains(img)) return;
      const src = pickBestSrc(img);
      const id = idFromImgUrl(src);
      if (id) push(id, src, (img.alt || '').trim());
    });

    document.querySelectorAll('a[href*="/artworks/"]').forEach((a) => {
      if (overlay && overlay.contains(a)) return;
      const m = (a.getAttribute('href') || '').match(/\/artworks\/(\d+)/);
      if (!m) return;
      let img = a.querySelector('img');
      if (!img) {
        let node = a;
        for (let i = 0; i < 4 && node && !img; i++) {
          node = node.parentElement;
          if (node) img = node.querySelector('img');
        }
      }
      push(m[1], img ? pickBestSrc(img) : '', img ? (img.alt || '').trim() : '');
    });

    if (items.length < 3) {
      const html = document.documentElement.innerHTML;
      const re = /artworks\/(\d{5,})/g;
      let mm;
      while ((mm = re.exec(html)) !== null && items.length < 60) {
        push(mm[1], '', '');
      }
    }
    return items;
  }

  /* ---------- 作品情報の解決（元画像・複数枚・うごイラ） ---------- */

  function upgradeUrl(url) {
    if (!url) return '';
    let u = url.replace(/^https:\/\/i\.pximg\.net\/c\/[^/]+\//, 'https://i.pximg.net/');
    u = u.replace(/_(square1200|custom1200)\.(\w+)$/, '_p0_master1200.jpg');
    return u;
  }

  async function fetchJson(url, signal) {
    const res = await fetch(url, { credentials: 'same-origin', signal });
    const json = await res.json();
    if (json.error) throw new Error(json.message || 'api error');
    return json.body;
  }

  // 解決処理はPromiseを共有する（同じ作品に二重で走らせない。ChatGPTレビュー反映）
  function resolveSlide(s) {
    if (s.resolved) return Promise.resolve();
    if (s.resolvePromise) return s.resolvePromise;
    s.resolving = true;
    const ctrl = new AbortController();
    s.resolveAbort = ctrl;
    s.resolvePromise = resolveSlideImpl(s, ctrl.signal)
      .catch(() => {})
      .finally(() => {
        s.resolving = false;
        s.resolvePromise = null;
        s.resolveAbort = null;
      });
    return s.resolvePromise;
  }

  async function resolveSlideImpl(s, signal) {
    try {
      const body = await fetchJson(`/ajax/illust/${s.id}`, signal);
      s.rawType = body.illustType;
      s.tags = normTags(body.tags);
      s.userId = body.userId ? String(body.userId) : null;
      s.bookmarked = !!body.bookmarkData;
      if (s.bookmarked) {
        knownBookmarkedIds.add(String(s.id));
        if (!s.tasteLearned) {
          learnFromWork(s.tags, s.userId, body.illustType, 3);
          s.tasteLearned = true;
        }
      }
      paintBookmarkBtn(s);
      if (body.title && !s.title) { s.title = body.title; if (s.titleEl) s.titleEl.textContent = s.title; }
      if (body.userName) { s.author = body.userName; if (s.authorEl) s.authorEl.textContent = s.author; }
      const pageCount = body.pageCount || 1;
      if (body.illustType === 2) {
        // pixivの種別コード: 0=イラスト / 1=マンガ / 2=うごイラ
        s.kind = 'ugoira';
        try {
          let meta = s.metaPromise ? await s.metaPromise : null;
          if (!meta) meta = await fetchJson(`/ajax/illust/${s.id}/ugoira_meta`);
          s.zipSmall = meta.src || null;
          s.zipFull = meta.originalSrc || null;
          s.zipUrl = s.zipSmall || s.zipFull;
          s.frames = meta.frames || null;
          if (!s.zipUrl) s.ugoiraError = 'メタにZIPなし';
          else if (!s.frames || s.frames.length === 0) s.ugoiraError = 'フレーム情報なし';
        } catch (e) {
          s.ugoiraError = 'メタ取得失敗: ' + (e && e.message ? e.message : e);
        }
        const pair = pickPair(body.urls);
        s.pairs = [pair];
        // 個別フレームURLの型（_ugoira0.jpg → 連番に差し替え可能なら使う）
        const m = (pair.o || '').match(/^(.*_ugoira)0(\.\w+)$/);
        if (m) { s.frameBase = m[1]; s.frameExt = m[2]; }
      } else if (pageCount > 1) {
        s.kind = 'multi';
        try {
          const pages = await fetchJson(`/ajax/illust/${s.id}/pages`);
          s.pairs = pages.map((p) => pickPair(p.urls));
        } catch (e) {
          s.pairs = [pickPair(body.urls)];
          s.kind = 'single';
        }
      } else {
        s.kind = 'single';
        s.pairs = [pickPair(body.urls)];
      }
    } catch (e) {
      if (signal && signal.aborted) return; // 中断された場合は状態を書かない（再試行側に任せる）
      s.kind = 'single';
      s.resolveError = (e && e.message) ? e.message : String(e);
      const u = upgradeUrl(s.thumb) || s.thumb;
      s.pairs = [{ r: u, o: u }];
    }
    s.resolved = true;
    applyResolved(s);
    upgradeSlide(s);
  }

  // 表示レベルに応じて画像を差し替える：表示中は元画像（quality=orig時）、近くは1200px
  function levelUrl(s, pair) {
    if (!pair) return s.thumb;
    if (s.isCurrent && quality === 'orig') return pair.o || pair.r;
    return pair.r || pair.o;
  }

  // 複数枚作品：表示中ページの前後だけ画像を読み込む
  function loadHorizontalNeighbors(s, idx) {
    if (!s.sectionEl) return;
    const imgs = s.sectionEl.querySelectorAll('.pts-page img');
    for (let i = Math.max(0, idx - 1); i <= Math.min(imgs.length - 1, idx + 1); i++) {
      const im = imgs[i];
      if (im && im.dataset && im.dataset.src && !im.getAttribute('src')) {
        im.src = im.dataset.src;
        delete im.dataset.src;
      }
    }
  }

  // 元画像への差し替えは「裏で読み切ってから」行い、表示中の画像は絶対に格下げしない（消える・遅くなる元）
  function swapToOriginal(s, img, pair) {
    if (!pair || !pair.o || s.origLoading) return;
    const cur = img.getAttribute('src') || '';
    if (cur.includes(pair.o)) return;
    s.origLoading = true;
    const pre = new Image();
    pre.decoding = 'async';
    try { pre.fetchPriority = 'high'; } catch (e) {}
    pre.src = pair.o;
    const done = () => {
      s.origLoading = false;
      if ((img.getAttribute('src') || '').includes(pair.o)) return;
      if (img.isConnected) img.src = pair.o;
    };
    // 読み込みだけでなくデコードまで終わってから差し替える（差し替え直後の白飛び・引っかかり防止）
    if (pre.decode) pre.decode().then(done).catch(() => { s.origLoading = false; });
    else { pre.onload = done; pre.onerror = () => { s.origLoading = false; }; }
  }

  function upgradeSlide(s, force) {
    if (!s.resolved || !s.pairs) return;
    const holder = s.sectionEl && s.sectionEl.querySelector('.pts-holder');
    if (!holder) return;
    if (s.kind === 'multi') {
      const imgs = holder.querySelectorAll('.pts-page img');
      imgs.forEach((im, i) => {
        const pair = s.pairs[i];
        if (!pair) return;
        if (force) {
          const target = levelUrl(s, pair);
          if (target && !(im.getAttribute('src') || '').includes(target)) im.src = target;
        } else if (s.isCurrent && quality === 'orig' && i === (s.pageIdx || 0)) {
          swapToOriginal(s, im, pair);
        }
      });
      s.mainImg = imgs[s.pageIdx || 0] || imgs[0] || s.mainImg;
    } else {
      const pair = s.pairs[0];
      if (s.mainImg && pair) {
        if (force) {
          const target = levelUrl(s, pair);
          if (target && !(s.mainImg.getAttribute('src') || '').includes(target)) s.mainImg.src = target;
        } else if (s.isCurrent && quality === 'orig') {
          swapToOriginal(s, s.mainImg, pair);
        }
      }
      if (s.kind === 'ugoira') prepareUgoira(s);
    }
  }


  /* ---------- うごイラ（ZIP展開してアニメーション） ---------- */

  // raw deflate 解凍（SafariのDecompressionStreamがdeflate-raw非対応のため自前実装。検証済み）
  function inflateRaw(bytes) {
    let pos = 0;
    const bit = () => {
      if (pos >= bytes.length * 8) throw new Error('deflate: unexpected end');
      const b = (bytes[pos >> 3] >> (pos & 7)) & 1; pos++; return b;
    };
    const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v; };
    const buildHuff = (lengths) => {
      const maxBits = Math.max(...lengths, 0);
      const blCount = new Array(maxBits + 1).fill(0);
      lengths.forEach((l) => { if (l) blCount[l]++; });
      const nextCode = new Array(maxBits + 1).fill(0);
      let code = 0;
      for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
      const map = new Map();
      lengths.forEach((l, sym) => { if (l) { map.set(nextCode[l], { len: l, sym }); nextCode[l]++; } });
      return { map, maxBits };
    };
    const decode = (huff) => {
      let code = 0;
      for (let len = 1; len <= huff.maxBits; len++) {
        code = (code << 1) | bit();
        const hit = huff.map.get(code);
        if (hit && hit.len === len) return hit.sym;
      }
      throw new Error('bad huffman code');
    };
    const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const LEN_EXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const DIST_EXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    const out = [];
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        pos = (pos + 7) & ~7;
        const len = bytes[pos >> 3] | (bytes[(pos >> 3) + 1] << 8);
        pos += 32;
        const start = pos >> 3;
        for (let i = 0; i < len; i++) out.push(bytes[start + i]);
        pos += len * 8;
      } else {
        let litHuff, distHuff;
        if (type === 1) {
          const lit = [];
          for (let i = 0; i < 288; i++) lit.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
          litHuff = buildHuff(lit);
          distHuff = buildHuff(new Array(30).fill(5));
        } else if (type === 2) {
          const hlit = bits(5) + 257;
          const hdist = bits(5) + 1;
          const hclen = bits(4) + 4;
          const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
          const clen = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) clen[order[i]] = bits(3);
          const clHuff = buildHuff(clen);
          const lens = [];
          while (lens.length < hlit + hdist) {
            const sym = decode(clHuff);
            if (sym < 16) lens.push(sym);
            else if (sym === 16) { const rep = bits(2) + 3; const prev = lens[lens.length - 1]; for (let i = 0; i < rep; i++) lens.push(prev); }
            else if (sym === 17) { const rep = bits(3) + 3; for (let i = 0; i < rep; i++) lens.push(0); }
            else { const rep = bits(7) + 11; for (let i = 0; i < rep; i++) lens.push(0); }
          }
          litHuff = buildHuff(lens.slice(0, hlit));
          distHuff = buildHuff(lens.slice(hlit));
        } else {
          throw new Error('bad block type');
        }
        for (;;) {
          const sym = decode(litHuff);
          if (sym < 256) out.push(sym);
          else if (sym === 256) break;
          else {
            const li = sym - 257;
            if (li < 0 || li >= LEN_BASE.length) throw new Error('deflate: bad length symbol');
            const len = LEN_BASE[li] + bits(LEN_EXT[li]);
            const dsym = decode(distHuff);
            if (dsym < 0 || dsym >= DIST_BASE.length) throw new Error('deflate: bad distance symbol');
            const dist = DIST_BASE[dsym] + bits(DIST_EXT[dsym]);
            if (dist < 1 || dist > out.length) throw new Error('deflate: bad back-reference');
            const start = out.length - dist;
            for (let i = 0; i < len; i++) out.push(out[start + i]);
          }
        }
      }
    }
    return new Uint8Array(out);
  }

  async function unzipFrames(zipUrl, frames, signal) {
    let res;
    try {
      res = await fetch(zipUrl, { signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('ZIP取得失敗(通信/CORS): ' + (e && e.message ? e.message : e));
    }
    if (!res.ok) throw new Error('ZIP取得失敗: HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const view = new DataView(buf);
    // End of Central Directory を後ろから探す
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 22 - 65536; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no eocd');
    const count = view.getUint16(eocd + 10, true);
    let off = view.getUint32(eocd + 16, true);
    const byName = new Map();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const compSize = view.getUint32(off + 20, true);
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      byName.set(name, { method, compSize, dataOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    const urls = [];
    for (let fi = 0; fi < frames.length; fi++) {
      const f = frames[fi];
      const ent = byName.get(f.file);
      if (!ent) { urls.push(null); continue; }
      const raw = new Uint8Array(buf, ent.dataOff, ent.compSize);
      let bytes = raw;
      if (ent.method === 8) {
        bytes = inflateRaw(raw);
      }
      const mime = /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg';
      urls.push(URL.createObjectURL(new Blob([bytes], { type: mime })));
      // 同期解凍が続くとSafariが固まるので、数フレームごとに描画の機会を返す
      if (fi % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    return urls;
  }

  function startUgoira(s) {
    if (s.animTimer || !s.frameUrls) return;
    upgradeUgoiraHiRes(s);
    if (s.pageChip) {
      s.pageChip.style.display = 'block';
      s.pageChip.textContent = 'うごイラ再生中';
    }
    // シークバー（再生位置）を出す
    const total = s.frames.reduce((a, f) => a + (f.delay || 100), 0);
    s.animTotal = total;
    if (s.seekEl) s.seekEl.style.display = 'block';
    const step = () => {
      if (!s.frameUrls) return;
      const i = s.animIdx % s.frameUrls.length;
      const url = s.frameUrls[i];
      if (url && s.mainImg) s.mainImg.src = url;
      // 現在フレーム開始時点までの累計時間でバーを進める
      let elapsed = 0;
      for (let k = 0; k < i; k++) elapsed += (s.frames[k].delay || 100);
      const pct = total > 0 ? (elapsed / total) * 100 : 0;
      if (s.seekFill) s.seekFill.style.width = pct + '%';
      if (s.seekKnob) s.seekKnob.style.left = pct + '%';
      const delay = (s.frames[i].delay) || 100;
      s.animIdx++;
      s.animTimer = setTimeout(step, delay);
    };
    step();
  }

  // シークバーの位置に合わせてフレームを表示する（ドラッグ中のプレビュー）
  function dragUgoira(s, ratio) {
    if (!s.frameUrls || !s.frames) return;
    const total = s.animTotal || s.frames.reduce((a, f) => a + (f.delay || 100), 0);
    s.animTotal = total;
    let target = ratio * total;
    let idx = 0;
    let elapsed = 0;
    while (idx < s.frames.length - 1 && target >= (s.frames[idx].delay || 100)) {
      target -= (s.frames[idx].delay || 100);
      elapsed += (s.frames[idx].delay || 100);
      idx++;
    }
    // 表示したフレームの次から再生を再開する（animIdxは「次に表示するフレーム」の意味で統一）
    s.animIdx = idx + 1;
    const url = s.frameUrls[idx % s.frameUrls.length];
    if (url && s.mainImg) s.mainImg.src = url;
    const pct = total > 0 ? (elapsed / total) * 100 : 0;
    if (s.seekFill) s.seekFill.style.width = pct + '%';
    if (s.seekKnob) s.seekKnob.style.left = pct + '%';
  }

  function stopUgoira(s) {
    if (s.animTimer) { clearTimeout(s.animTimer); s.animTimer = null; }
  }

  function setChip(s, text) {
    if (!s.pageChip) return;
    s.pageChip.style.display = 'block';
    s.pageChip.textContent = text;
  }

  async function prepareUgoira(s) {
    if (s.frameUrls || s.preparingUgoira) return;
    if (s.ugoiraError) { if (s.isCurrent) setChip(s, 'うごイラ: ' + s.ugoiraError); return; }
    if (!s.frames) { if (s.isCurrent) setChip(s, 'うごイラ: フレーム情報なし'); return; }
    s.preparingUgoira = true;
    s.ugoiraAbort = new AbortController();
    if (s.isCurrent) setChip(s, 'うごイラ準備中…');
    try {
      // 第1候補：ZIPを自前で展開する（pixiv公式と同じ方式）
      if (s.zipUrl) {
        try {
          s.frameUrls = await unzipFrames(s.zipUrl, s.frames, s.ugoiraAbort.signal);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          throw new Error('ZIP展開失敗: ' + (e && e.message ? e.message : e));
        }
        const valid = s.frameUrls.filter(Boolean).length;
        if (valid === 0) throw new Error('フレーム0枚');
        if (s.isCurrent) startUgoira(s);
        upgradeUgoiraHiRes(s);
        return;
      }
      // 第2候補：個別フレームURL（_ugoira0, _ugoira1, ...）
      if (s.frameBase && s.frameExt) {
        const urls = s.frames.map((f, i) => `${s.frameBase}${i}${s.frameExt}`);
        const ok = await new Promise((done) => {
          const probe = new Image();
          probe.onload = () => done(true);
          probe.onerror = () => done(false);
          probe.src = urls[Math.min(1, urls.length - 1)];
        });
        if (ok) {
          s.frameUrls = urls;
          urls.forEach((u) => { const im = new Image(); im.src = u; });
          if (s.isCurrent) startUgoira(s);
          return;
        }
        throw new Error('個別フレーム不可');
      }
      throw new Error('再生手段なし');
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // 優先度付け替えで中断されただけ。エラー扱いしない
      } else {
        if (s.isCurrent) setChip(s, 'うごイラ: ' + (e && e.message ? e.message : e));
        s.ugoiraError = (e && e.message) ? e.message : String(e);
      }
    } finally {
      s.preparingUgoira = false;
      s.ugoiraAbort = null;
    }
  }

  // うごイラ：小さいZIPで先に再生を始め、裏で元サイズのZIPに差し替えて綺麗にする
  async function upgradeUgoiraHiRes(s) {
    // 高画質化は表示中の作品だけ（画面外まで展開するとiPhoneのメモリを圧迫する）
    if (!s.isCurrent) return;
    if (!s.zipFull || s.zipFull === s.zipUrl || s.hiDone || s.hiRunning) return;
    s.hiRunning = true;
    try {
      const urls = await unzipFrames(s.zipFull, s.frames, undefined);
      if (urls.filter(Boolean).length > 0) {
        const old = s.frameUrls;
        s.frameUrls = urls;
        s.hiDone = true;
        // 旧フレームは表示中imgがまだ参照していることがある。即解放すると画像が消えるので遅らせて解放
        if (old) setTimeout(() => {
          old.forEach((u) => { if (u && u.indexOf('blob:') === 0) URL.revokeObjectURL(u); });
        }, 5000);
      }
    } catch (e) { /* 小さいまま続行 */ }
    s.hiRunning = false;
  }

  /* ---------- 閲覧中の読み込み優先（滞り検知つき） ---------- */

  // 表示中のスライドを最優先にする：他のうごイラ準備を止め、未解決なら即解決し、画像の優先度を上げる
  function prioritize(s) {
    slides.forEach((o) => {
      if (o !== s && o.ugoiraAbort) o.ugoiraAbort.abort();
      if (o.mainImg) { try { o.mainImg.fetchPriority = (o === s) ? 'high' : 'low'; } catch (e) {} }
    });
    if (!s.resolved) resolveSlide(s);
    if (s.kind === 'ugoira' && !s.frameUrls && s.resolved) prepareUgoira(s);
  }

  // 画像の読み込みを強制的にやり直す（壊れて終わっているときだけ。読み込み途中では呼ばない）
  function forceReloadImage(s) {
    const img = s.mainImg;
    if (!img || !s.pairs || !s.pairs[0]) return;
    const url = (quality === 'orig' && s.pairs[0].o) ? s.pairs[0].o : (s.pairs[0].r || s.pairs[0].o);
    if (!url) return;
    img.src = '';
    img.src = url;
  }

  // 表示中になってから一定時間たっても読み込めていなければ、優先化→強制再読み込みの順で助ける
  function armWatchdog(s) {
    if (s.loadWatch) clearTimeout(s.loadWatch);
    s.loadWatch = setTimeout(() => {
      if (!s.isCurrent) return;
      const img = s.mainImg;
      const imgOk = s.kind === 'ugoira' ? !!s.frameUrls : (img && img.complete && img.naturalWidth > 0);
      if (s.resolved && imgOk) return;
      prioritize(s);
      s.loadWatch = setTimeout(() => {
        if (!s.isCurrent) return;
        const im2 = s.mainImg;
        const ok2 = s.kind === 'ugoira' ? !!s.frameUrls : (im2 && im2.complete && im2.naturalWidth > 0);
        if (!ok2) {
          if (!s.resolved && s.resolvePromise && s.resolveAbort) {
            // 本当に固まった取得だけを中断して、終わってから1回だけやり直す（二重実行はしない）
            const p = s.resolvePromise;
            s.resolveAbort.abort();
            p.then(() => { if (s.isCurrent && !s.resolved) resolveSlide(s); });
          }
          else if (!s.resolved) resolveSlide(s);
          else if (s.kind === 'ugoira') prepareUgoira(s);
          else if (im2 && im2.complete && im2.naturalWidth === 0) forceReloadImage(s);
          // 読み込みが続いているだけなら、やり直すとかえって遅くなるので触らない
        }
      }, 4000);
    }, 2600);
  }

  /* ---------- 表示 ---------- */

  function applyResolved(s) {
    if (!s.sectionEl) return;
    const holder = s.sectionEl.querySelector('.pts-holder');
    if (!holder) return;
    if (s.kind === 'multi' && s.pairs && s.pairs.length > 1) {
      holder.innerHTML = '';
      const pager = document.createElement('div');
      pager.className = 'pts-pager';
      s.pairs.forEach((pair, i) => {
        const pg = document.createElement('div');
        pg.className = 'pts-page';
        const im = document.createElement('img');
        im.className = 'pts-img';
        im.decoding = 'async';
        // 3ページ目以降は近づくまで読み込まない（大量ページ作品の初期負荷を抑える）
        if (i <= 1) im.src = pair.r || pair.o;
        else im.dataset.src = pair.r || pair.o;
        im.loading = i === 0 ? 'eager' : 'lazy';
        im.alt = s.title || '';
        pg.appendChild(im);
        pager.appendChild(pg);
      });
      pager.addEventListener('scroll', () => {
        const idx = Math.round(pager.scrollLeft / pager.clientWidth);
        s.pageIdx = idx;
        if (s.pageChip) s.pageChip.textContent = `${idx + 1} / ${s.pairs.length}`;
        loadHorizontalNeighbors(s, idx);
        upgradeSlide(s);
      }, { passive: true });
      holder.appendChild(pager);
      if (s.pageChip) {
        s.pageChip.style.display = 'block';
        s.pageChip.textContent = `1 / ${s.pairs.length}`;
      }
      s.mainImg = pager.querySelector('img');
    } else {
      // 仮表示のimg要素を使い回す（作り直すと一瞬消える。URLが同じなら読み直しも起きない）
      const pair = s.pairs && s.pairs[0];
      const target = (pair && (pair.r || pair.o)) || s.thumb;
      const im = s.mainImg;
      if (im && holder.contains(im)) {
        if (im.dataset) delete im.dataset.ptsPh;
        if (target && !(im.getAttribute('src') || '').includes(target)) im.src = target;
        im.alt = s.title || im.alt || '';
      } else {
        holder.innerHTML = '';
        const nim = document.createElement('img');
        nim.className = 'pts-img';
        nim.decoding = 'async';
        nim.src = target;
        nim.alt = s.title || '';
        nim.addEventListener('error', () => {
          if (s.thumb && !nim.src.includes(s.thumb)) nim.src = s.thumb;
        });
        holder.appendChild(nim);
        s.mainImg = nim;
      }
    }
  }

  function renderSlide(s, idx) {
    const sec = document.createElement('section');
    sec.className = 'pts-slide';
    s.sectionEl = sec;

    const holder = document.createElement('div');
    holder.className = 'pts-holder';
    const ph = document.createElement('img');
    ph.className = 'pts-img';
    ph.decoding = 'async';
    // 先頭の数枚は、サムネイルURLから変換した1200px画像を即表示する（API応答を待たない）
    // それ以外は近づくまで読み込まない（帯域を先頭と表示中に譲る）
    if (idx < 3) {
      ph.src = upgradeUrl(s.thumb) || s.thumb;
      ph.onerror = () => { if (s.thumb && ph.src !== s.thumb) ph.src = s.thumb; };
    } else {
      ph.dataset.ptsPh = '1';
    }
    ph.alt = s.title || '';
    ph.loading = idx < 2 ? 'eager' : 'lazy';
    holder.appendChild(ph);
    s.mainImg = ph;
    sec.appendChild(holder);

    const chip = document.createElement('div');
    chip.className = 'pts-pagechip';
    chip.style.display = 'none';
    sec.appendChild(chip);
    s.pageChip = chip;

    // うごイラ用シークバー（上部バー直下・ドラッグで操作できる）
    const seek = document.createElement('div');
    seek.className = 'pts-seek';
    seek.style.display = 'none';
    const seekFill = document.createElement('div');
    seekFill.className = 'pts-seek-fill';
    seek.appendChild(seekFill);
    const knob = document.createElement('div');
    knob.className = 'pts-seek-knob';
    seek.appendChild(knob);
    s.seekKnob = knob;
    const dragTo = (clientX) => {
      const r = seek.getBoundingClientRect();
      dragUgoira(s, Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
    };
    seek.addEventListener('pointerdown', (e) => {
      seek.setPointerCapture(e.pointerId);
      s.seekDragging = true;
      stopUgoira(s);
      dragTo(e.clientX);
      e.stopPropagation();
      e.preventDefault();
    });
    seek.addEventListener('pointermove', (e) => {
      if (s.seekDragging) dragTo(e.clientX);
    });
    const dragEnd = () => {
      if (!s.seekDragging) return;
      s.seekDragging = false;
      if (s.isCurrent && s.frameUrls) startUgoira(s);
    };
    seek.addEventListener('pointerup', dragEnd);
    seek.addEventListener('pointercancel', dragEnd);
    sec.appendChild(seek);
    s.seekEl = seek;
    s.seekFill = seekFill;

    const meta = document.createElement('div');
    meta.className = 'pts-meta';
    const t = document.createElement('div');
    t.className = 'pts-title';
    t.textContent = s.title || '';
    const au = document.createElement('div');
    au.className = 'pts-author';
    au.textContent = s.author || '';
    meta.appendChild(t);
    meta.appendChild(au);
    s.titleEl = t;
    s.authorEl = au;
    sec.appendChild(meta);

    const link = document.createElement('a');
    link.className = 'pts-open';
    link.href = s.page;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'pixivで開く';
    sec.appendChild(link);

    const rel = document.createElement('button');
    rel.className = 'pts-related';
    rel.textContent = 'この作品の関連へ';
    rel.addEventListener('click', () => switchToRelated(s, rel));
    sec.appendChild(rel);

    const bm = document.createElement('button');
    bm.className = 'pts-bookmark';
    bm.textContent = '🔖 保存';
    bm.addEventListener('click', () => toggleBookmark(s, bm));
    sec.appendChild(bm);
    s.bookmarkBtn = bm;

    // タップ送り（単一・うごイラのみ。左1/3=前、右=次）。スクロールや横スライドと誤認しないよう移動量で判定
    let tapDown = null;
    holder.addEventListener('pointerdown', (e) => {
      tapDown = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    holder.addEventListener('pointerup', (e) => {
      if (!tapDown) return;
      const dx = e.clientX - tapDown.x;
      const dy = e.clientY - tapDown.y;
      const dt = Date.now() - tapDown.t;
      tapDown = null;
      if (s.kind === 'multi' || s.seekDragging) return;
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || dt > 350) return;
      const r = holder.getBoundingClientRect();
      const ratio = (e.clientX - r.left) / r.width;
      gotoSlide(currentIndex() + (ratio < 0.33 ? -1 : 1));
    });

    feedEl.appendChild(sec);
    if (nearObs) nearObs.observe(sec);
  }

  /* ---------- 関連作品への切り替え ---------- */

  let relatedNextIds = [];
  let relatedLoading = false;

  async function switchToRelated(slide, btn) {
    if (relatedSwitchBusy) return;
    relatedSwitchBusy = true;
    const generation = feedGeneration;
    if (btn) { btn.textContent = '読み込み中…'; btn.disabled = true; }
    try {
      // pixivのおすすめ（作品の関連）と、本人の行動ベースのおすすめ（ディスカバリー）を並列取得して統合
      const [recResult, discResult] = await Promise.allSettled([
        fetchJson(`/ajax/illust/${slide.id}/recommend/init?limit=60&lang=ja`),
        fetchJson('/ajax/discovery/artworks?mode=all&limit=60'),
      ]);
      if (generation !== feedGeneration || !slides.includes(slide)) return;
      if (recResult.status === 'rejected' && discResult.status === 'rejected') {
        throw new Error('候補取得に失敗');
      }
      const rec = recResult.status === 'fulfilled' ? recResult.value : {};
      const disc = discResult.status === 'fulfilled' ? discResult.value : {};
      let recItems = Array.isArray(rec.illusts) ? rec.illusts : [];
      const discItems = Array.isArray(disc.illusts) ? disc.illusts : [];
      let nextIds = Array.isArray(rec.nextIds) ? rec.nextIds.map(String) : [];
      if (recItems.length === 0 && nextIds.length > 0) {
        const batch = nextIds.slice(0, 60);
        const more = await fetchJson(`/ajax/illust/recommend/illusts?illustIds=${batch.join(',')}&lang=ja`);
        recItems = more.illusts || [];
        nextIds = nextIds.slice(batch.length);
        if (Array.isArray(more.nextIds)) {
          const queued = new Set(nextIds);
          more.nextIds.map(String).forEach((id) => { if (!queued.has(id)) { nextIds.push(id); queued.add(id); } });
        }
      }
      const ranked = await prepareCandidates([...recItems, ...discItems], { excludeIds: [slide.id] });
      if (generation !== feedGeneration || !slides.includes(slide)) return;
      if (ranked.length === 0) throw new Error('関連候補0件');
      const idx = slides.indexOf(slide);
      // 後続スライドは後片付けしてから外す（タイマーやBlobを残さない）
      slides.slice(idx + 1).forEach((s) => {
        cleanupSlide(s);
        if (nearObs && s.sectionEl) nearObs.unobserve(s.sectionEl);
        if (s.sectionEl) s.sectionEl.remove();
      });
      slides = slides.slice(0, idx + 1);
      mode = 'related';
      relatedNextIds = [];
      mergeNextIds(nextIds);
      addItems(candidatesToSlides(ranked));
      markCurrentFromScroll();
      if (btn) btn.textContent = '関連に切替済み';
    } catch (e) {
      if (btn) { btn.textContent = '失敗: ' + ((e && e.message) || e); btn.disabled = false; }
    } finally {
      relatedSwitchBusy = false;
    }
  }

  // 関連モードの続き読み込み（候補IDが残っている間は末尾に足していく）
  async function relatedLoadMore() {
    if (mode !== 'related' || relatedLoading || relatedSwitchBusy || relatedNextIds.length === 0) return;
    relatedLoading = true;
    const generation = feedGeneration;
    try {
      // IDは成功してから消費する（失敗時に候補が消えないように）
      const batch = relatedNextIds.slice(0, 60);
      const body = await fetchJson(`/ajax/illust/recommend/illusts?illustIds=${batch.join(',')}&lang=ja`);
      if (generation !== feedGeneration || mode !== 'related') return;
      const ranked = await prepareCandidates(body.illusts || []);
      if (generation !== feedGeneration || mode !== 'related') return;
      relatedNextIds.splice(0, batch.length);
      addItems(candidatesToSlides(ranked));
      mergeNextIds(body.nextIds || []);
    } catch (e) { /* 次のスクロールで再試行 */ }
    relatedLoading = false;
  }

  /* ---------- フィード管理 ---------- */

  function updateCounter() {
    const c = overlay.querySelector('.pts-counter');
    if (slides.length === 0) {
      c.textContent = 'このページに作品が見つかりませんでした';
    } else {
      c.textContent = mode === 'related' ? `${slides.length} 件（関連モード）` : `${slides.length} 件`;
    }
  }

  function addItems(items) {
    if (items.length === 0) { updateCounter(); return; }
    items.forEach((s) => {
      slides.push(s);
      renderSlide(s, slides.length - 1);
    });
    updateCounter();
  }

  // スクロール位置から「表示中スライド」を決める（IntersectionObserverが効かない環境向けの本命判定）
  let curTimer = null;
  function markCurrentFromScroll() {
    if (!feedEl || slides.length === 0) return;
    const idx = Math.round(feedEl.scrollTop / Math.max(1, feedEl.clientHeight));
    slides.forEach((s, i) => {
      if (i === idx) {
        if (!s.isCurrent) {
          s.isCurrent = true;
          if (s.resolved) upgradeSlide(s);
          else resolveSlide(s);
          if (s.kind === 'ugoira') {
            if (s.frameUrls) startUgoira(s);
            else if (s.resolved) prepareUgoira(s);
          }
          armWatchdog(s);
        }
      } else if (s.isCurrent) {
        s.isCurrent = false;
        stopUgoira(s);
        if (s.resolved) upgradeSlide(s);
      }
    });
    // 近く（前後3枚）の仮表示サムネイルは、監視を待たずスクロール位置から直接読み込む
    slides.forEach((s, i) => {
      if (Math.abs(i - idx) <= 3 && s.mainImg && s.mainImg.dataset && s.mainImg.dataset.ptsPh
        && !s.mainImg.getAttribute('src') && s.thumb) {
        s.mainImg.src = s.thumb;
      }
    });
    // 先読みは「表示中が読み終わってから」。表示中より先に帯域を食うと全部遅くなる
    const cur = slides[idx];
    const curOk = cur && (cur.kind === 'ugoira' ? !!cur.frameUrls
      : (cur.mainImg && cur.mainImg.complete && cur.mainImg.naturalWidth > 0));
    if (quality === 'orig' && curOk) {
      const n1 = slides[idx + 1];
      if (n1 && n1.resolved && n1.kind !== 'ugoira' && n1.pairs && n1.pairs[0] && n1.pairs[0].o && !n1.preloadedO) {
        n1.preloadedO = true;
        const pre = new Image();
        pre.decoding = 'async';
        pre.src = n1.pairs[0].o;
      }
      const n2 = slides[idx + 2];
      if (n2 && n2.resolved && n2.kind !== 'ugoira' && n2.pairs && n2.pairs[0] && n2.pairs[0].r && !n2.preloadedR) {
        n2.preloadedR = true;
        const pre2 = new Image();
        pre2.decoding = 'async';
        pre2.src = n2.pairs[0].r;
      }
    }
    scheduleAutoAdvance(idx);
  }

  /* ---------- 自前レコメンド（本人のブックマークから好みを学習して並べ替える） ---------- */

  const profile = { tags: {}, authors: {}, ugoira: 0 };
  try {
    const saved = JSON.parse(sessionStorage.getItem('pts-profile') || 'null');
    if (saved && saved.tags) { profile.tags = saved.tags; profile.authors = saved.authors || {}; profile.ugoira = saved.ugoira || 0; }
  } catch (e) {}

  function saveProfile() {
    try { sessionStorage.setItem('pts-profile', JSON.stringify(profile)); } catch (e) {}
  }

  function normTags(tags) {
    if (!tags) return [];
    const arr = Array.isArray(tags) ? tags : (tags.tags || []);
    return arr.map((t) => (typeof t === 'string' ? t : (t && t.tag) || '')).filter(Boolean);
  }

  // ブックマーク済み作品から好みを学習する（重みつき）
  function learnFromWork(tags, userId, illustType, weight) {
    (tags || []).forEach((t) => { profile.tags[t] = (profile.tags[t] || 0) + weight; });
    if (userId) profile.authors[String(userId)] = (profile.authors[String(userId)] || 0) + weight;
    if (illustType === 2) profile.ugoira += weight;
    saveProfile();
  }

  // 候補作品の「好み一致度」。pixivの並び順は同点のときの tiebreak として残る
  function tasteScore(it) {
    let sc = 0;
    normTags(it.tags).forEach((t) => { sc += Math.min(profile.tags[t] || 0, 10); });
    if (it.userId && profile.authors[String(it.userId)]) sc += 8;
    if (it.illustType === 2 && profile.ugoira >= 3) sc += 3;
    return sc;
  }

  function sortByTaste(items) {
    return items
      .map((it, i) => ({ it, i, sc: tasteScore(it) }))
      .sort((a, b) => (b.sc - a.sc) || (a.i - b.i))
      .map((x) => x.it);
  }

  /* ---------- 候補の共通処理（ChatGPT実装案を検証・調整して採用） ---------- */

  const knownBookmarkedIds = new Set();
  let feedGeneration = 0;
  let relatedSwitchBusy = false;

  function candidateId(it) {
    const id = it && (it.id != null ? it.id : it.illustId);
    return id == null ? '' : String(id);
  }

  function normalizeCandidate(it) {
    return {
      ...it,
      id: candidateId(it),
      tags: normTags(it.tags),
      userId: it.userId == null ? null : String(it.userId),
      illustType: Number(it.illustType),
      bookmarked: !!(it.bookmarkData || it.bookmarked || it.isBookmarked),
      bookmarkStateKnown:
        Object.prototype.hasOwnProperty.call(it, 'bookmarkData') ||
        Object.prototype.hasOwnProperty.call(it, 'bookmarked') ||
        Object.prototype.hasOwnProperty.call(it, 'isBookmarked'),
    };
  }

  async function mapLimited(items, limit, fn) {
    const result = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
          const i = cursor++;
          result[i] = await fn(items[i], i);
        }
      })
    );
    return result;
  }

  // リスト側に無い情報（タグ・作者・保存状態）だけを個別取得で補う
  async function enrichCandidate(it) {
    if (!it.id) return null;
    if (it.tags.length > 0 && it.userId && it.bookmarkStateKnown) return it;
    try {
      const body = await fetchJson(`/ajax/illust/${encodeURIComponent(it.id)}`);
      return {
        ...it,
        tags: normTags(body.tags),
        userId: body.userId == null ? it.userId : String(body.userId),
        illustType: Number(body.illustType),
        bookmarked: !!body.bookmarkData,
        bookmarkData: body.bookmarkData,
      };
    } catch (e) {
      return null; // 保存状態が不明な候補は安全側で除外
    }
  }

  // 候補を「重複・表示済み・保存済み」を除いて好み順に並べる。
  // 個別取得での補完は上位 enrichTop 件だけに絞る（全件補完は遅すぎるため。ChatGPT案からの調整点）
  async function prepareCandidates(rawItems, options = {}) {
    const excludeIds = new Set((options.excludeIds || []).map(String));
    slides.forEach((s) => excludeIds.add(String(s.id)));
    knownBookmarkedIds.forEach((id) => excludeIds.add(id));
    const seen = new Set();
    const unique = [];
    for (const raw of rawItems || []) {
      const it = normalizeCandidate(raw);
      if (!it.id || excludeIds.has(it.id) || seen.has(it.id)) continue;
      if (it.bookmarked) { knownBookmarkedIds.add(it.id); continue; }
      seen.add(it.id);
      unique.push(it);
    }
    const prelim = sortByTaste(unique);
    const enrichTop = options.enrichTop != null ? options.enrichTop : 24;
    const head = prelim.slice(0, enrichTop);
    const tail = prelim.slice(enrichTop);
    const enriched = await mapLimited(head, 4, enrichCandidate);
    const headOk = enriched.filter((it) => {
      if (!it) return false;
      if (it.bookmarked) { knownBookmarkedIds.add(it.id); return false; }
      return true;
    });
    return [...sortByTaste(headOk), ...tail];
  }

  function candidatesToSlides(items) {
    return items.map((it) => {
      const s = newSlide(it.id, it.url || '', it.title || '', it.userName || '');
      s.tags = it.tags;
      s.userId = it.userId;
      if (!Number.isNaN(it.illustType)) s.rawType = it.illustType;
      s.bookmarked = false;
      return s;
    });
  }

  function mergeNextIds(ids) {
    const queued = new Set(relatedNextIds);
    const displayed = new Set(slides.map((s) => String(s.id)));
    for (const value of ids || []) {
      const id = String(value);
      if (!id || queued.has(id) || displayed.has(id) || knownBookmarkedIds.has(id)) continue;
      relatedNextIds.push(id);
      queued.add(id);
    }
  }

  // スライド群を指定位置の直後に差し込む（ブックマーク時のおすすめ差し込み用）
  function insertSlidesAfter(posIdx, newSlides) {
    if (newSlides.length === 0) return;
    newSlides.forEach((s) => renderSlide(s, 99));
    slides.splice(posIdx + 1, 0, ...newSlides);
    let anchor = slides[posIdx] ? slides[posIdx].sectionEl : null;
    newSlides.forEach((s) => {
      if (anchor && anchor.nextSibling) feedEl.insertBefore(s.sectionEl, anchor.nextSibling);
      else if (anchor) feedEl.appendChild(s.sectionEl);
      anchor = s.sectionEl;
    });
    updateCounter();
  }

  /* ---------- 片手・ハンズフリー向け機能 ---------- */

  let autoSec = 0;
  let autoTimer = null;
  let wakeLock = null;
  let csrfToken = null;

  function gotoSlide(i) {
    if (!feedEl || i < 0 || i >= slides.length) return;
    feedEl.scrollTo({ top: i * feedEl.clientHeight, behavior: 'smooth' });
  }

  function currentIndex() {
    if (!feedEl) return 0;
    return Math.round(feedEl.scrollTop / Math.max(1, feedEl.clientHeight));
  }

  // 自動送り：表示が落ち着いたらタイマーを張り直す。うごイラは1ループ分は最低待つ
  function scheduleAutoAdvance(idx) {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (!autoSec || !overlay || overlay.style.display === 'none') return;
    const s = slides[idx];
    let delay = autoSec * 1000;
    if (s && s.kind === 'ugoira' && s.animTotal) delay = Math.max(delay, Math.min(s.animTotal, 60000));
    autoTimer = setTimeout(() => {
      if (idx + 1 < slides.length) gotoSlide(idx + 1);
    }, delay);
  }

  // 画面が消えないようにする（対応ブラウザのみ）
  async function keepAwake(on) {
    try {
      if (on && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
      } else if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* 非対応なら何もしない */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && overlay && overlay.style.display !== 'none') keepAwake(true);
  });

  async function getCsrfToken() {
    if (csrfToken) return csrfToken;
    const find = (html) => {
      const m = html.match(/"token":"([0-9a-zA-Z]{10,})"/);
      return m ? m[1] : null;
    };
    let t = null;
    try { t = find(document.documentElement.innerHTML); } catch (e) {}
    if (!t) {
      const res = await fetch('https://www.pixiv.net/', { credentials: 'same-origin' });
      t = find(await res.text());
    }
    csrfToken = t;
    return t;
  }

  function paintBookmarkBtn(s) {
    if (!s.bookmarkBtn) return;
    if (s.bookmarked) {
      s.bookmarkBtn.textContent = '✓ 保存済み';
      s.bookmarkBtn.classList.add('pts-bookmarked');
      s.bookmarkBtn.disabled = false;
    }
  }

  // ブックマークした作品のおすすめを、その作品の直後に最大12件差し込む
  async function insertRecommendationsAfterBookmark(s) {
    if (s.recommendInsertStarted) return;
    s.recommendInsertStarted = true;
    const generation = feedGeneration;
    if (!slides.includes(s)) return;
    try {
      const body = await fetchJson(`/ajax/illust/${s.id}/recommend/init?limit=60&lang=ja`);
      let candidates = Array.isArray(body.illusts) ? body.illusts : [];
      if (candidates.length === 0 && Array.isArray(body.nextIds) && body.nextIds.length > 0) {
        const batch = body.nextIds.slice(0, 60).map(String);
        const more = await fetchJson(`/ajax/illust/recommend/illusts?illustIds=${batch.join(',')}&lang=ja`);
        candidates = more.illusts || [];
      }
      const ranked = await prepareCandidates(candidates, { excludeIds: [s.id], enrichTop: 16 });
      if (generation !== feedGeneration || !feedEl || !slides.includes(s)) return;
      const seen = new Set(slides.map((x) => String(x.id)));
      const selected = ranked.filter((it) => {
        if (seen.has(it.id) || knownBookmarkedIds.has(it.id)) return false;
        seen.add(it.id);
        return true;
      }).slice(0, 12);
      if (selected.length === 0) return;
      const posIdx = slides.indexOf(s);
      // 差し込みで表示中の作品がずれる場合は、表示位置を維持する
      const currentSlide = slides[currentIndex()];
      const oldScrollTop = feedEl.scrollTop;
      const oldHeight = Math.max(1, feedEl.clientHeight);
      insertSlidesAfter(posIdx, candidatesToSlides(selected));
      if (currentSlide && currentSlide !== s) {
        const newIndex = slides.indexOf(currentSlide);
        if (newIndex >= 0) {
          feedEl.scrollTop = newIndex * oldHeight + (oldScrollTop % oldHeight);
        }
      }
      markCurrentFromScroll();
    } catch (e) {
      s.recommendInsertStarted = false;
    }
  }

  async function toggleBookmark(s, btn) {
    if (s.bookmarked) { paintBookmarkBtn(s); return; }
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const token = await getCsrfToken();
      if (!token) throw new Error('token取得失敗');
      const res = await fetch('/ajax/illusts/bookmarks/add', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ illust_id: String(s.id), restrict: 0, comment: '', tags: [] }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.message || 'api error');
      s.bookmarked = true;
      knownBookmarkedIds.add(String(s.id));
      paintBookmarkBtn(s);
      if (s.tags && s.tags.length) {
        learnFromWork(s.tags, s.userId, s.rawType, 3);
        s.tasteLearned = true;
      }
      // 保存は完了済み。おすすめ差し込みは裏で進める（完了は待たない）
      insertRecommendationsAfterBookmark(s);
    } catch (e) {
      btn.textContent = '保存失敗 もう一度タップ';
      btn.disabled = false;
    }
  }

  // スライドの後片付け（タイマー・通信・Blobを残さない。長時間閲覧でのメモリ圧迫対策）
  function cleanupSlide(s) {
    stopUgoira(s);
    if (s.loadWatch) { clearTimeout(s.loadWatch); s.loadWatch = null; }
    if (s.ugoiraAbort) { try { s.ugoiraAbort.abort(); } catch (e) {} s.ugoiraAbort = null; }
    if (s.resolveAbort) { try { s.resolveAbort.abort(); } catch (e) {} }
    if (s.frameUrls) {
      s.frameUrls.forEach((u) => { if (u && u.indexOf('blob:') === 0) URL.revokeObjectURL(u); });
      s.frameUrls = null;
    }
  }

  function buildFeed() {
    feedGeneration++;
    relatedNextIds = [];
    relatedLoading = false;
    relatedSwitchBusy = false;
    slides.forEach(cleanupSlide);
    slides = [];
    mode = 'page';
    pageLoadMisses = 0;
    feedEl.innerHTML = '';
    addItems(scanPage());
    // 最初の1枚を最優先で即解決し、次は間隔を空けて続ける（一斉に始めると最初の1枚が遅くなる）
    if (slides[0]) {
      slides[0].isCurrent = true;
      resolveSlide(slides[0]);
      armWatchdog(slides[0]);
    }
    slides.slice(1, 4).forEach((s, i) => setTimeout(() => { if (slides.includes(s)) resolveSlide(s); }, 350 * (i + 1)));
    setTimeout(markCurrentFromScroll, 400);
  }

  function appendNew() {
    if (!overlay || overlay.style.display === 'none') return;
    addItems(scanPage());
  }

  /* ---------- 背後ページの無限読み込みと連動 ---------- */

  function pageLoadMore() {
    if (mode !== 'page') return;
    if (pageLoadBusy || pageLoadMisses >= 4) return;
    pageLoadBusy = true;
    const before = slides.length;
    window.scrollBy(0, Math.max(2000, window.innerHeight * 3));
    setTimeout(() => {
      appendNew();
      pageLoadMisses = (slides.length === before) ? pageLoadMisses + 1 : 0;
      pageLoadBusy = false;
    }, 1300);
  }

  /* ---------- オーバーレイ ---------- */

  function setupObservers() {
    // 近づいたら解決する（先読み範囲だけ。全部は処理しないので軽い）
    nearObs = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        const s = slides.find((x) => x.sectionEl === en.target);
        if (!s) return;
        // 遅らせていた仮表示サムネイルをここで読み込む
        if (s.mainImg && s.mainImg.dataset && s.mainImg.dataset.ptsPh && !s.mainImg.getAttribute('src') && s.thumb) {
          s.mainImg.src = s.thumb;
        }
        if (!s.resolved) resolveSlide(s);
        else upgradeSlide(s);
      });
    }, { root: null, rootMargin: '300% 0px 300% 0px', threshold: 0 });
    // 「表示中」の決定は markCurrentFromScroll（スクロール位置ベース）に一本化した。
    // 以前はIntersectionObserverと二重に書き換えて競合していた（ChatGPTレビュー反映）
  }

  function openViewer() {
    buildOverlay();
    overlay.style.display = 'block';
    keepAwake(true);
    buildFeed();
    setTimeout(() => pageLoadMore(), 800);
    setTimeout(() => pageLoadMore(), 2500);
  }

  function closeViewer() {
    feedGeneration++;
    overlay.style.display = 'none';
    keepAwake(false);
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    slides.forEach(cleanupSlide);
    slides = [];
    if (feedEl) feedEl.innerHTML = '';
  }

  function buildOverlay() {
    if (overlay) return;
    setupObservers();
    overlay = document.createElement('div');
    overlay.id = 'pts-overlay';
    overlay.innerHTML = `
      <div class="pts-bar">
        <span class="pts-counter">…</span>
        <select class="pts-quality">
          <option value="fast">速い</option>
          <option value="orig" selected>元画像</option>
        </select>
        <select class="pts-auto">
          <option value="0" selected>自動なし</option>
          <option value="5">自動5秒</option>
          <option value="10">自動10秒</option>
          <option value="15">自動15秒</option>
          <option value="30">自動30秒</option>
        </select>
        <button class="pts-rescan">再スキャン</button>
        <button class="pts-close" title="閉じる">✕</button>
      </div>
      <div class="pts-feed"></div>
    `;
    feedEl = overlay.querySelector('.pts-feed');
    overlay.querySelector('.pts-close').addEventListener('click', closeViewer);
    overlay.querySelector('.pts-rescan').addEventListener('click', buildFeed);
    overlay.querySelector('.pts-quality').addEventListener('change', (e) => {
      quality = e.target.value;
      // 画質を変えたら、解決済みスライドの表示レベルだけ付け替える（取り直しはしない）
      slides.forEach((s) => { if (s.resolved) upgradeSlide(s, true); });
    });
    overlay.querySelector('.pts-auto').addEventListener('change', (e) => {
      autoSec = parseInt(e.target.value, 10) || 0;
      markCurrentFromScroll();
    });
    feedEl.addEventListener('scroll', () => {
      const remain = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
      if (remain < feedEl.clientHeight * 2) {
        if (mode === 'related') relatedLoadMore();
        else pageLoadMore();
      }
      clearTimeout(curTimer);
      curTimer = setTimeout(markCurrentFromScroll, 130);
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (!overlay || overlay.style.display === 'none') return;
      if (e.key === 'Escape') closeViewer();
    });

    const style = document.createElement('style');
    style.textContent = `
      #pts-overlay{position:fixed;inset:0;background:#000;z-index:99999;display:none;}
      .pts-bar{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:center;gap:10px;
        padding:10px 14px;color:#fff;background:linear-gradient(rgba(0,0,0,.65),transparent);font-size:13px;}
      .pts-counter{opacity:.9}
      .pts-rescan{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:999px;
        padding:7px 12px;cursor:pointer;font-size:12px;}
      .pts-quality{margin-left:auto;background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:8px;padding:6px 8px;font-size:12px;}
      .pts-quality option{color:#000;}
      .pts-auto{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:8px;padding:6px 8px;font-size:12px;}
      .pts-auto option{color:#000;}
      .pts-bookmark{position:absolute;right:14px;bottom:160px;z-index:2;background:rgba(255,255,255,.16);color:#fff;border:0;
        border-radius:999px;padding:10px 14px;font-size:13px;}
      .pts-bookmark.pts-bookmarked{background:#1e9e6a;}
      .pts-close{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:999px;width:32px;height:32px;cursor:pointer;font-size:15px;}
      .pts-feed{height:100%;overflow-y:auto;scroll-snap-type:y mandatory;scrollbar-width:none;overscroll-behavior:contain;}
      .pts-feed::-webkit-scrollbar{display:none;}
      .pts-slide{position:relative;height:100%;scroll-snap-align:start;scroll-snap-stop:always;background:#000;}
      .pts-holder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
      .pts-img{max-width:100%;max-height:100%;object-fit:contain;}
      .pts-pager{display:flex;height:100%;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;width:100%;overscroll-behavior:contain;}
      .pts-pager::-webkit-scrollbar{display:none;}
      .pts-page{min-width:100%;height:100%;scroll-snap-align:start;scroll-snap-stop:always;
        display:flex;align-items:center;justify-content:center;}
      .pts-pagechip{position:absolute;top:52px;right:14px;z-index:2;background:rgba(0,0,0,.55);color:#fff;
        font-size:12px;padding:4px 9px;border-radius:999px;}
      .pts-meta{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:28px 16px 18px;color:#fff;pointer-events:none;
        background:linear-gradient(transparent,rgba(0,0,0,.7));}
      .pts-title{font-size:15px;font-weight:700;line-height:1.4;}
      .pts-author{font-size:13px;opacity:.85;margin-top:2px;}
      .pts-seek{position:absolute;left:0;right:0;top:48px;height:26px;z-index:6;background:linear-gradient(to bottom, rgba(255,255,255,.25) 0 4px, transparent 4px);touch-action:none;}
      .pts-seek-fill{height:4px;width:0%;background:#0096fa;}
      .pts-seek-knob{position:absolute;top:2px;left:0%;width:16px;height:16px;margin-left:-8px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.5);}
      .pts-open{position:absolute;right:14px;bottom:64px;z-index:2;background:rgba(255,255,255,.16);color:#fff;
        text-decoration:none;font-size:12px;padding:8px 12px;border-radius:999px;}
      .pts-related{position:absolute;right:14px;bottom:112px;z-index:2;background:#0096fa;color:#fff;border:0;
        font-size:12px;font-weight:700;padding:9px 13px;border-radius:999px;cursor:pointer;}
      .pts-related:disabled{opacity:.6;}
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }

  const btn = document.createElement('button');
  btn.id = 'pts-launch';
  btn.textContent = '縦スクロール';
  btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99998;background:#0096fa;color:#fff;border:0;' +
    'border-radius:999px;padding:12px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);';
  btn.addEventListener('click', openViewer);
  document.body.appendChild(btn);
})();
