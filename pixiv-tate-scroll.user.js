// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      3.10.1
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
  let mode = 'page'; // 'page' | 'related' | 'custom'
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
      s.bookmarked = s.bookmarked || knownBookmarkedIds.has(String(s.id)) || !!body.bookmarkData;
      if (s.bookmarked) {
        knownBookmarkedIds.add(String(s.id));
        if (!s.tasteLearned
          && !bookmarkHistory.works.some((w) => String(w.id) === String(s.id))) {
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
    // 関連へ進む操作もブックマークとして扱う。保存は裏で実行し、関連フィードの取得を待たせない
    if (!slide.bookmarked) {
      ensureBookmarked(slide).catch((e) => {
        console.warn('[PTS] 関連切替時の自動保存失敗', e);
      });
    }
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
    if (!overlay) return;
    const c = overlay.querySelector('.pts-counter');
    if (!c) return;
    if (slides.length === 0) {
      c.textContent = mode === 'custom' ? '自前フィードを準備中…' : 'このページに作品が見つかりませんでした';
      return;
    }
    if (mode === 'related') c.textContent = `${slides.length} 件（関連）`;
    else if (mode === 'custom') c.textContent = `${slides.length} 件（自前）`;
    else c.textContent = `${slides.length} 件`;
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

  /* ---------- 自前レコメンド v2（履歴500件＋永続化） ---------- */
  const PROFILE_KEY = 'PTS_PROFILE_V2';
  const HISTORY_LIMIT = 500;
  const HISTORY_PAGE_SIZE = 48;
  const HISTORY_REFRESH_MS = 6 * 60 * 60 * 1000;
  const HISTORY_HALF_LIFE = 100;
  // 自分のpixivユーザーID（自動検出の誤認を防ぐため固定。ChatGPT案のMY_USER_ID_OVERRIDE）
  const MY_USER_ID_OVERRIDE = '50590090';

  const profile = { tags: {}, authors: {}, ugoira: 0 };
  let bookmarkHistory = { userId: '', works: [], initialized: false, updatedAt: 0 };
  let historyProfile = { tags: {}, authors: {}, ugoira: 0 };
  let historyInitPromise = null;

  function normTags(tags) {
    if (!tags) return [];
    const arr = Array.isArray(tags) ? tags : (Array.isArray(tags.tags) ? tags.tags : []);
    return [...new Set(arr.map(t => typeof t === 'string' ? t : (t && t.tag) || '').filter(Boolean))];
  }

  function readProfile() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch (e) {}
    if (!saved || saved.version !== 2) {
      try {
        const old = JSON.parse(sessionStorage.getItem('pts-profile') || 'null');
        if (old && old.tags) saved = { version: 2, live: old };
      } catch (e) {}
    }
    if (saved && saved.live) {
      const p = saved.live;
      if (p.tags && typeof p.tags === 'object') profile.tags = p.tags;
      if (p.authors && typeof p.authors === 'object') profile.authors = p.authors;
      profile.ugoira = Number(p.ugoira) || 0;
    }
    if (saved && saved.history && typeof saved.history === 'object') {
      const h = saved.history;
      if (Array.isArray(h.works)) {
        bookmarkHistory = {
          userId: String(h.userId || ''),
          works: h.works.slice(0, HISTORY_LIMIT),
          initialized: h.initialized === true,
          updatedAt: Number(h.updatedAt) || 0
        };
      }
    }
  }

  function saveProfile() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({
        version: 2,
        live: profile,
        history: bookmarkHistory
      }));
    } catch (e) { console.warn('[PTS] profile保存失敗', e); }
  }

  // ビューア内での保存操作・既存の表示解決時の学習に使う
  function learnFromWork(tags, userId, illustType, weight = 1) {
    const w = Number(weight) || 0;
    if (w <= 0) return;
    for (const tag of normTags(tags)) profile.tags[tag] = (profile.tags[tag] || 0) + w;
    if (userId != null && userId !== '') {
      const id = String(userId);
      profile.authors[id] = (profile.authors[id] || 0) + w;
    }
    if (Number(illustType) === 2) profile.ugoira += w;
    saveProfile();
  }

  function getMyUserId() {
    if (MY_USER_ID_OVERRIDE) return String(MY_USER_ID_OVERRIDE);
    // 1. 自分のブックマークページURL
    const path = location.pathname.match(/^\/users\/(\d+)\/bookmarks(?:\/|$)/);
    if (path) return path[1];
    // 2. meta[name="global-data"]
    const meta = document.querySelector('meta[name="global-data"]');
    if (meta) {
      try {
        const data = JSON.parse(meta.getAttribute('content') || '{}');
        const id = data.userData?.id ?? data.userData?.userId ??
          data.user?.id ?? data.user?.userId ??
          data.loginUser?.id ?? data.loginUser?.userId ??
          data.loginUserId;
        if (id != null && /^\d+$/.test(String(id))) return String(id);
      } catch (e) { /* 次の経路を試す */ }
    }
    // 3. ページ内の自分のブックマークへのリンク
    for (const a of document.querySelectorAll('a[href*="/bookmarks/artworks"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/users\/(\d+)\/bookmarks\/artworks(?:[/?#]|$)/);
      if (m) return m[1];
    }
    return '';
  }

  function parseBookmarkPage(body) {
    if (!body || !Array.isArray(body.works)) throw new Error('bookmarks API: body.worksがありません');
    return body.works.map(w => {
      const id = w && (w.id ?? w.illustId);
      if (id == null) return null;
      return {
        id: String(id),
        userId: w.userId == null ? '' : String(w.userId),
        tags: normTags(w.tags),
        illustType: Number(w.illustType),
        pageCount: Number(w.pageCount) || 1
      };
    }).filter(Boolean);
  }

  function learnFromBookmarks(works) {
    const next = { tags: {}, authors: {}, ugoira: 0 };
    (works || []).slice(0, HISTORY_LIMIT).forEach((work, index) => {
      const weight = Math.pow(0.5, index / HISTORY_HALF_LIFE);
      for (const tag of normTags(work.tags)) {
        next.tags[tag] = (next.tags[tag] || 0) + weight;
      }
      if (work.userId) {
        const id = String(work.userId);
        next.authors[id] = (next.authors[id] || 0) + weight;
      }
      if (Number(work.illustType) === 2) next.ugoira += weight;
    });
    historyProfile = next;
  }

  function applyBookmarkHistory() {
    learnFromBookmarks(bookmarkHistory.works);
    for (const work of bookmarkHistory.works) knownBookmarkedIds.add(String(work.id));
  }

  async function fetchBookmarkPage(userId, offset) {
    const url = `/ajax/user/${encodeURIComponent(userId)}/bookmarks/artworks` +
      `?tag=&offset=${offset}&limit=${HISTORY_PAGE_SIZE}&rest=show`;
    return parseBookmarkPage(await fetchJson(url));
  }

  async function initProfileFromBookmarks(force = false) {
    if (historyInitPromise) return historyInitPromise;
    const userId = getMyUserId();
    if (!userId) {
      console.warn('[PTS] 自分のユーザーIDを取得できず履歴学習をスキップ');
      return;
    }
    // 別アカウントの履歴を絶対に混ぜない
    if (bookmarkHistory.userId && bookmarkHistory.userId !== userId) {
      bookmarkHistory = { userId, works: [], initialized: false, updatedAt: 0 };
      historyProfile = { tags: {}, authors: {}, ugoira: 0 };
    }
    bookmarkHistory.userId = userId;
    applyBookmarkHistory();
    if (!force && bookmarkHistory.initialized &&
        Date.now() - bookmarkHistory.updatedAt < HISTORY_REFRESH_MS) return;

    historyInitPromise = (async () => {
      const previous = bookmarkHistory.initialized ? bookmarkHistory.works : [];
      const oldIds = new Set(previous.map(w => String(w.id)));
      const fresh = [];
      const seen = new Set();
      let overlap = false;
      let exhausted = false;

      for (let offset = 0; offset < HISTORY_LIMIT; offset += HISTORY_PAGE_SIZE) {
        const page = await fetchBookmarkPage(userId, offset);
        if (page.length === 0) { exhausted = true; break; }
        for (const work of page) {
          if (seen.has(work.id)) continue;
          seen.add(work.id);
          fresh.push(work);
          if (oldIds.has(work.id)) overlap = true;
        }
        if (page.length < HISTORY_PAGE_SIZE) { exhausted = true; break; }
        if (previous.length && overlap) break;
      }

      // 取得が最後まで正常に終了した時だけcommitする。
      // 初回途中失敗時はinitialized=falseのままで次回やり直せる。
      const freshIds = new Set(fresh.map(w => w.id));
      const merged = previous.length && overlap && !exhausted
        ? [...fresh, ...previous.filter(w => !freshIds.has(w.id))]
        : fresh;
      const completed = fresh.length >= HISTORY_LIMIT || exhausted ||
        (previous.length > 0 && overlap);
      if (!completed) throw new Error('履歴取得が完了していません');

      bookmarkHistory = {
        userId,
        works: merged.slice(0, HISTORY_LIMIT),
        initialized: true,
        updatedAt: Date.now()
      };
      applyBookmarkHistory();
      saveProfile();
      console.info('[PTS] 履歴学習完了', bookmarkHistory.works.length, '件');
    })().catch(e => {
      console.warn('[PTS] 履歴学習失敗（次回再試行）', e);
    }).finally(() => { historyInitPromise = null; });
    return historyInitPromise;
  }

  // 数値を返す完成版。タグ×3、作者×9、うごイラ、R-18を評価。
  function tasteScore(it) {
    let score = 0;
    let tagScore = 0;
    const tags = normTags(it.tags);
    for (const tag of tags) {
      const count = Math.max(0, (Number(historyProfile.tags[tag]) || 0) +
        (Number(profile.tags[tag]) || 0) * 1.5);
      tagScore += Math.log1p(count);
    }
    score += Math.min(30, tagScore * 3);

    const authorId = it.userId == null ? '' : String(it.userId);
    if (authorId) {
      const count = Math.max(0, (Number(historyProfile.authors[authorId]) || 0) +
        (Number(profile.authors[authorId]) || 0) * 1.5);
      score += Math.min(27, Math.log1p(count) * 9);
    }

    const hasUgoira = Number(it.illustType) === 2;
    if (hasUgoira && historyProfile.ugoira + profile.ugoira > 0) score += 4;
    if (tags.includes('R-18')) score += 3;
    return Number.isFinite(score) ? score : 0;
  }

  function sortByTaste(items) {
    return items.map((it, i) => ({ it, i, sc: tasteScore(it) }))
      .sort((a, b) => (b.sc - a.sc) || (a.i - b.i))
      .map(x => x.it);
  }

  readProfile();

  /* ---------- 候補の共通処理（ChatGPT実装案を検証・調整して採用） ---------- */

  const knownBookmarkedIds = new Set();
  applyBookmarkHistory();
  initProfileFromBookmarks();
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
      if (!raw) continue;
      const it = normalizeCandidate(raw);
      if (!it.id || excludeIds.has(it.id) || seen.has(it.id)) continue;
      if (it.bookmarked) { knownBookmarkedIds.add(it.id); continue; }
      seen.add(it.id);
      unique.push(it);
    }
    // 通常モードは従来の好みスコア。customではシード票を含むスコアを options.rank で注入できる
    const rank = typeof options.rank === 'function' ? options.rank : tasteScore;
    function ranked(items) {
      return items
        .map((it, index) => ({ it, index, score: Number(rank(it)) || 0 }))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map((x) => x.it);
    }
    const prelim = ranked(unique);
    const enrichTop = Math.max(0, Math.floor(options.enrichTop != null ? options.enrichTop : 24));
    const head = prelim.slice(0, enrichTop);
    const tail = prelim.slice(enrichTop);
    const enriched = await mapLimited(head, Math.min(4, Math.max(1, enrichTop)), enrichCandidate);
    const headOk = enriched.filter((it) => {
      if (!it) return false;
      if (it.bookmarked) { knownBookmarkedIds.add(it.id); return false; }
      return true;
    });
    // 補完後も同じランキング関数で並べ直す（票の加点が途中で消えない）
    return ranked([...headOk, ...tail]);
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

  /* ---------- 自前フィード v1（ChatGPT実装） ---------- */

  const CUSTOM_TARGET = 80;
  const CUSTOM_MAX_REQUESTS = 6;
  const CUSTOM_VOTE_BONUS = 8;
  const CUSTOM_DISCOVERY_BONUS = 2;

  let customBusy = false;
  let customSeedOffset = 0;
  let customNextIds = [];
  let customQueuedIds = new Set();
  let customSeenIds = new Set();
  let customExhausted = false;
  let customBatchNumber = 0;

  // 既存フィードの表示済み作品も記録する（同一ページ内では再表示しない）
  function rememberDisplayedSlides() {
    for (const s of slides) {
      if (s.id) customSeenIds.add(String(s.id));
    }
  }

  function customPageArtworkId() {
    const match = location.pathname.match(/^\/artworks\/(\d+)(?:\/|$)/);
    return match ? match[1] : '';
  }

  function customPickSeeds() {
    const result = [];
    const seen = new Set();
    const add = (id) => {
      const value = String(id || '');
      if (!/^\d+$/.test(value) || seen.has(value)) return;
      seen.add(value);
      result.push(value);
    };
    // 初回のみ作品ページの作品をシードにする
    if (customBatchNumber === 0) add(customPageArtworkId());
    // 履歴から3件。次バッチでは3件ずつ先へ進める
    const works = bookmarkHistory.works || [];
    let added = 0;
    while (customSeedOffset < works.length && added < 3) {
      const work = works[customSeedOffset++];
      const before = result.length;
      add(work && work.id);
      if (result.length > before) added++;
    }
    return result.slice(0, 4);
  }

  function customMergeNextIds(ids) {
    for (const value of ids || []) {
      const id = String(value);
      if (!/^\d+$/.test(id)) continue;
      if (customQueuedIds.has(id)) continue;
      if (customSeenIds.has(id)) continue;
      if (knownBookmarkedIds.has(id)) continue;
      if (slides.some((s) => String(s.id) === id)) continue;
      customQueuedIds.add(id);
      customNextIds.push(id);
    }
    if (customNextIds.length > 500) {
      customNextIds = customNextIds.slice(0, 500);
      customQueuedIds = new Set(customNextIds);
    }
  }

  // 候補をIDで統合し、複数シードから推薦された回数を票として記録する
  function customCollect(results) {
    const map = new Map();
    let order = 0;
    for (const result of results) {
      const items = Array.isArray(result.items) ? result.items : [];
      const votedInSource = new Set();
      for (const raw of items) {
        const id = candidateId(raw);
        if (!id) continue;
        let entry = map.get(id);
        if (!entry) {
          entry = { ...raw, id, _customVotes: 0, _customDiscovery: false, _customOrder: order++ };
          map.set(id, entry);
        } else {
          for (const key of ['tags', 'userId', 'illustType', 'pageCount', 'url', 'title', 'userName']) {
            const oldValue = entry[key];
            const newValue = raw[key];
            if ((oldValue == null || oldValue === '' || (Array.isArray(oldValue) && oldValue.length === 0)) && newValue != null) {
              entry[key] = newValue;
            }
          }
        }
        if (votedInSource.has(id)) continue;
        votedInSource.add(id);
        if (result.type === 'seed') entry._customVotes++;
        else if (result.type === 'discovery') entry._customDiscovery = true;
      }
    }
    return [...map.values()];
  }

  function customBaseScore(it) {
    return tasteScore(it)
      + (Number(it._customVotes) || 0) * CUSTOM_VOTE_BONUS
      + (it._customDiscovery ? CUSTOM_DISCOVERY_BONUS : 0);
  }

  // 最終順位を1件ずつ決め、作者の連続だけを緩く抑える
  function customDiversify(items) {
    const pool = items.slice();
    const output = [];
    const previousAuthors = slides.slice(-2).map((s) => (s.userId ? String(s.userId) : ''));
    while (pool.length > 0) {
      let bestIndex = 0;
      let bestScore = -Infinity;
      let bestVotes = -Infinity;
      let bestOrder = Infinity;
      const last = output.length ? output[output.length - 1] : null;
      const secondLast = output.length >= 2 ? output[output.length - 2] : null;
      const lastAuthor = last ? String(last.userId || '') : (previousAuthors.at(-1) || '');
      const secondAuthor = secondLast ? String(secondLast.userId || '')
        : (output.length === 1 ? (previousAuthors.at(-1) || '') : (previousAuthors.at(-2) || ''));
      for (let i = 0; i < pool.length; i++) {
        const it = pool[i];
        const author = String(it.userId || '');
        let score = customBaseScore(it);
        if (author && author === lastAuthor) score -= 12;
        if (author && author === secondAuthor) score -= 5;
        const votes = Number(it._customVotes) || 0;
        const ord = Number(it._customOrder) || 0;
        if (score > bestScore
          || (score === bestScore && votes > bestVotes)
          || (score === bestScore && votes === bestVotes && ord < bestOrder)) {
          bestIndex = i;
          bestScore = score;
          bestVotes = votes;
          bestOrder = ord;
        }
      }
      output.push(pool.splice(bestIndex, 1)[0]);
    }
    return output;
  }

  // 単一バッチの取得（初回：シード最大4＋discovery＋補完枠／追加：nextIds＋新シード＋discovery）
  async function customFetchBatch() {
    const first = customBatchNumber === 0;
    const seeds = customPickSeeds();
    const jobs = [];
    let nextBatch = [];
    if (!first && customNextIds.length > 0) {
      nextBatch = customNextIds.slice(0, 60);
      jobs.push({
        type: 'next',
        ids: nextBatch,
        run: () => fetchJson('/ajax/illust/recommend/illusts?illustIds=' + encodeURIComponent(nextBatch.join(',')) + '&lang=ja'),
      });
    }
    for (const id of seeds) {
      jobs.push({
        type: 'seed',
        id,
        run: () => fetchJson(`/ajax/illust/${encodeURIComponent(id)}/recommend/init?limit=60&lang=ja`),
      });
    }
    jobs.push({
      type: 'discovery',
      run: () => fetchJson('/ajax/discovery/artworks?mode=all&limit=60'),
    });
    const maxCollectionRequests = first ? CUSTOM_MAX_REQUESTS - 1 : CUSTOM_MAX_REQUESTS;
    const selectedJobs = jobs.slice(0, maxCollectionRequests);
    const settled = await Promise.allSettled(selectedJobs.map((job) => job.run()));
    const results = [];
    const nextIdsToMerge = [];
    let successful = 0;
    settled.forEach((entry, i) => {
      const job = selectedJobs[i];
      if (entry.status !== 'fulfilled') {
        console.warn('[PTS custom] 候補取得失敗', job.type, entry.reason);
        return;
      }
      successful++;
      const body = entry.value || {};
      results.push({ type: job.type, items: Array.isArray(body.illusts) ? body.illusts : [] });
      if (Array.isArray(body.nextIds)) nextIdsToMerge.push(...body.nextIds);
      if (job.type === 'next') {
        const consumed = new Set(job.ids);
        customNextIds = customNextIds.filter((id) => !consumed.has(id));
        customQueuedIds = new Set(customNextIds);
      }
    });
    if (successful === 0) throw new Error('全ての候補取得に失敗');
    customMergeNextIds(nextIdsToMerge);
    const collected = customCollect(results);
    const prepared = await prepareCandidates(collected, {
      excludeIds: [...customSeenIds],
      enrichTop: first ? 1 : 0,
      rank: customBaseScore,
    });
    const ranked = customDiversify(prepared);
    return ranked.slice(0, CUSTOM_TARGET);
  }

  function customResetState() {
    customBusy = false;
    customSeedOffset = 0;
    customNextIds = [];
    customQueuedIds = new Set();
    customExhausted = false;
    customBatchNumber = 0;
  }

  async function switchToCustom() {
    if (!overlay || !feedEl) return;
    feedGeneration++;
    const generation = feedGeneration;
    rememberDisplayedSlides();
    slides.forEach(cleanupSlide);
    slides = [];
    feedEl.innerHTML = '';
    feedEl.scrollTop = 0;
    mode = 'custom';
    relatedNextIds = [];
    relatedLoading = false;
    relatedSwitchBusy = false;
    customResetState();
    customBusy = true;
    updateCounter();
    const button = overlay.querySelector('.pts-custom');
    if (button) { button.disabled = true; button.textContent = '生成中…'; }
    try {
      const items = await customFetchBatch();
      if (generation !== feedGeneration || mode !== 'custom' || overlay.style.display === 'none') return;
      if (items.length === 0) throw new Error('表示可能な候補がありません');
      addItems(candidatesToSlides(items));
      for (const it of items) customSeenIds.add(String(it.id));
      customBatchNumber++;
      const firstSlide = slides[0];
      if (firstSlide) {
        firstSlide.isCurrent = true;
        resolveSlide(firstSlide);
        armWatchdog(firstSlide);
      }
      markCurrentFromScroll();
    } catch (e) {
      if (generation === feedGeneration && mode === 'custom') {
        console.warn('[PTS custom]', e);
        const c = overlay.querySelector('.pts-counter');
        if (c) c.textContent = '自前フィード失敗: ' + (e.message || e);
      }
    } finally {
      if (generation === feedGeneration && mode === 'custom') {
        customBusy = false;
        if (button) { button.disabled = false; button.textContent = '自前フィード'; }
      }
    }
  }

  async function customLoadMore() {
    if (mode !== 'custom' || customBusy || customExhausted || !overlay || overlay.style.display === 'none') return;
    customBusy = true;
    const generation = feedGeneration;
    try {
      const items = await customFetchBatch();
      if (generation !== feedGeneration || mode !== 'custom') return;
      const existing = new Set(slides.map((s) => String(s.id)));
      const selected = items.filter((it) => !existing.has(String(it.id))
        && !customSeenIds.has(String(it.id))
        && !knownBookmarkedIds.has(String(it.id)));
      if (selected.length > 0) {
        addItems(candidatesToSlides(selected));
        for (const it of selected) customSeenIds.add(String(it.id));
      }
      customBatchNumber++;
      const noMoreSeeds = customSeedOffset >= (bookmarkHistory.works || []).length;
      if (selected.length === 0 && noMoreSeeds && customNextIds.length === 0) {
        customExhausted = true;
      }
    } catch (e) {
      console.warn('[PTS custom] 続き取得失敗', e);
    } finally {
      if (generation === feedGeneration) customBusy = false;
    }
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

  // ブックマークの通信・状態更新・学習を共通化（ChatGPT実装）
  // おすすめ差し込みは呼び出し側の責務とする
  async function ensureBookmarked(s) {
    const id = String(s.id);
    // 同じ作品の保存処理が進行中なら、そのPromiseを共有する
    if (s.bookmarkPromise) return s.bookmarkPromise;
    // 既に保存済みなら再POSTしない
    if (s.bookmarked || knownBookmarkedIds.has(id)) {
      s.bookmarked = true;
      knownBookmarkedIds.add(id);
      paintBookmarkBtn(s);
      return false; // 新規保存ではない
    }
    const promise = (async () => {
      const token = await getCsrfToken();
      if (!token) throw new Error('token取得失敗');
      const res = await fetch('/ajax/illusts/bookmarks/add', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ illust_id: id, restrict: 0, comment: '', tags: [] }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.error) throw new Error(json.message || 'api error');
      // 保存成功後にのみ状態更新
      s.bookmarked = true;
      knownBookmarkedIds.add(id);
      paintBookmarkBtn(s);
      // 作品情報が取得済みなら、1回だけ学習
      if (!s.tasteLearned && s.tags && s.tags.length) {
        learnFromWork(s.tags, s.userId, s.rawType, 3);
        s.tasteLearned = true;
      }
      return true; // 新規保存成功
    })();
    s.bookmarkPromise = promise;
    try {
      return await promise;
    } finally {
      if (s.bookmarkPromise === promise) s.bookmarkPromise = null;
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
    if (s.bookmarked) {
      paintBookmarkBtn(s);
      return;
    }
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      // 共通処理：pixivへの保存・状態更新・学習
      const newlySaved = await ensureBookmarked(s);
      // 通常の保存操作だけ、おすすめを直後に差し込む
      if (newlySaved && mode !== 'custom') {
        insertRecommendationsAfterBookmark(s);
      }
    } catch (e) {
      // 並行して別の保存処理が成功した場合は失敗表示しない
      if (s.bookmarked) {
        paintBookmarkBtn(s);
        return;
      }
      console.warn('[PTS] ブックマーク失敗', e);
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
    customResetState();
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

  /* ---------- 診断モード v3.10.1（GETのみ・オンデマンド） ---------- */

  const ptsDiag = {
    installed: false,
    seq: 0,
    controller: null,
    lines: []
  };

  function diagText(value) {
    return String(value == null ? 'なし' : value)
      .replace(/[\r\n]/g, ' ')
      .slice(0, 180);
  }

  function diagKeys(obj) {
    if (!obj || typeof obj !== 'object') return 'なし';
    return Object.keys(obj).join(', ') || '空';
  }

  function diagTagShape(tags) {
    if (tags == null) {
      return { shape: 'なし', count: 0 };
    }

    const nested =
      !Array.isArray(tags) &&
      typeof tags === 'object' &&
      Array.isArray(tags.tags);

    const arr = nested ? tags.tags : tags;

    if (Array.isArray(arr)) {
      const first = arr.find(x => x != null);
      const kind = first == null
        ? '空'
        : typeof first === 'string'
          ? '文字列'
          : typeof first === 'object'
            ? 'オブジェクト'
            : typeof first;

      const count = arr.filter(x =>
        (typeof x === 'string' && x.length > 0) ||
        (x && typeof x === 'object' &&
          typeof x.tag === 'string' &&
          x.tag.length > 0)
      ).length;

      return {
        shape: `${nested ? 'オブジェクト内の' : ''}${kind}配列`,
        count
      };
    }

    return {
      shape: typeof tags === 'object'
        ? `オブジェクト(${diagKeys(tags)})`
        : typeof tags,
      count: typeof tags === 'string' && tags.length ? 1 : 0
    };
  }

  function diagTopKey(history, live) {
    const scores = new Map();

    for (const source of [history, live]) {
      if (!source || typeof source !== 'object') continue;

      for (const [key, raw] of Object.entries(source)) {
        const num = Number(raw);

        if (key && Number.isFinite(num) && num > 0) {
          scores.set(key, (scores.get(key) || 0) + num);
        }
      }
    }

    return [...scores]
      .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  // 既知のレスポンス形式を優先し、
  // 見つからなければ深さ3まで候補配列を探す。
  function diagFindArray(body) {
    const preferred = [
      ['body.illustManga.data', body?.illustManga?.data],
      ['body.thumbnails.illust', body?.thumbnails?.illust],
      ['body.thumbnails.manga', body?.thumbnails?.manga],
      ['body.illusts', body?.illusts],
      ['body.works', body?.works],
      ['body.items', body?.items],
      ['body.data', body?.data]
    ];

    const chosen = preferred.find(
      ([, value]) => Array.isArray(value)
    );

    if (chosen) {
      return { path: chosen[0], data: chosen[1] };
    }

    const queue = [
      { value: body, path: 'body', depth: 0 }
    ];

    let checked = 0;

    while (queue.length && checked++ < 80) {
      const { value, path, depth } = queue.shift();

      if (!value ||
          typeof value !== 'object' ||
          depth >= 3) {
        continue;
      }

      for (const [key, child] of
        Object.entries(value).slice(0, 30)) {

        const nextPath = `${path}.${key}`;

        if (
          Array.isArray(child) &&
          (
            child.length === 0 ||
            child.some(x =>
              x &&
              typeof x === 'object' &&
              (x.id != null || x.illustId != null)
            )
          )
        ) {
          return { path: nextPath, data: child };
        }

        if (
          child &&
          typeof child === 'object' &&
          !Array.isArray(child)
        ) {
          queue.push({
            value: child,
            path: nextPath,
            depth: depth + 1
          });
        }
      }
    }

    return null;
  }

  function diagError(error) {
    return diagText(
      error && error.message ? error.message : error
    );
  }

  // 診断専用GET。
  // 既存fetchJsonとは独立させてHTTPステータスを取得する。
  async function diagGet(url, signal) {
    if (signal.aborted) throw new Error('中止');

    const controller = new AbortController();
    let timedOut = false;

    const abort = () => controller.abort();

    signal.addEventListener('abort', abort, {
      once: true
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);

    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      let json;

      try {
        json = await res.json();
      } catch (e) {
        throw new Error(
          `HTTP ${res.status} / JSON解釈失敗`
        );
      }

      if (!json || typeof json !== 'object') {
        throw new Error('JSONがオブジェクトではない');
      }

      if (json.error) {
        throw new Error(
          `API error: ${diagText(json.message)}`
        );
      }

      if (!json.body ||
          typeof json.body !== 'object') {
        throw new Error(
          `HTTP ${res.status} / body形式が想定外`
        );
      }

      return json.body;

    } catch (e) {
      if (timedOut) {
        throw new Error('タイムアウト（12秒）');
      }

      if (signal.aborted) {
        throw new Error('中止');
      }

      throw e;

    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  function diagAppend(seq, line) {
    if (seq !== ptsDiag.seq) return;

    ptsDiag.lines.push(line);

    const out = overlay?.querySelector(
      '.pts-diag-output'
    );

    if (out) {
      out.value = ptsDiag.lines.join('\n');
      out.scrollTop = out.scrollHeight;
    }
  }

  // 1チェックごとに独立してエラーを処理する。
  async function diagCheck(seq, label, work) {
    try {
      const result = await work();
      diagAppend(seq, `${label}: ${result}`);
    } catch (e) {
      diagAppend(
        seq,
        `${label}: NG / ${diagError(e)}`
      );
    }
  }

  // pixiv本体の「おすすめ作品」見出しを探す。
  // ビューア自身のDOMは対象に含めない。
  function diagCarouselIds(pageId) {
    const headingSelector =
      'h1,h2,h3,h4,h5,h6,[role="heading"],' +
      'section strong,aside strong,' +
      'section span,aside span';

    const headings = document.querySelectorAll(
      headingSelector
    );

    for (const head of headings) {
      if (head.closest('#pts-overlay')) continue;

      const title = (head.textContent || '').trim();

      if (
        title.length > 45 ||
        !/おすすめ作品/.test(title)
      ) {
        continue;
      }

      let root = head.parentElement;

      for (
        let depth = 0;
        root && depth < 6;
        depth++, root = root.parentElement
      ) {
        const links = root.querySelectorAll(
          'a[href*="/artworks/"]'
        );

        if (!links.length || links.length > 80) {
          continue;
        }

        const ids = new Set();

        for (const link of links) {
          const id = (
            link.getAttribute('href') || ''
          ).match(/\/artworks\/(\d+)/)?.[1];

          if (id && id !== pageId) {
            ids.add(id);
          }
        }

        if (ids.size) {
          return [...ids];
        }
      }
    }

    return [];
  }

  function closeDiagnosticPanel() {
    if (!ptsDiag.installed) return;

    // 古い診断結果が次の実行に混ざらないようにする。
    ptsDiag.seq++;

    if (ptsDiag.controller) {
      ptsDiag.controller.abort();
    }

    ptsDiag.controller = null;

    const panel = overlay?.querySelector(
      '.pts-diag-panel'
    );

    if (panel) {
      panel.style.display = 'none';
    }

    const start = overlay?.querySelector(
      '.pts-diagnostic'
    );

    if (start) {
      start.disabled = false;
    }
  }

  async function copyDiagnosticReport() {
    const out = overlay?.querySelector(
      '.pts-diag-output'
    );

    const btn = overlay?.querySelector(
      '.pts-diag-copy'
    );

    if (!out || !btn) return;

    let copied = false;

    // 第一候補：Clipboard API
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(
          out.value
        );

        copied = true;
      }
    } catch (e) {
      // Safariで失敗したら従来方式を試す。
    }

    // 第二候補：旧来のコピー処理
    if (!copied) {
      try {
        out.focus();
        out.select();

        out.setSelectionRange(
          0,
          out.value.length
        );

        copied = !!document.execCommand('copy');
      } catch (e) {
        // 手動コピーへ
      }
    }

    btn.textContent = copied
      ? 'コピー完了'
      : '選択して手動コピー';
  }

  async function runDiagnostic() {
    if (
      !ptsDiag.installed ||
      ptsDiag.controller
    ) {
      return;
    }

    const panel = overlay.querySelector(
      '.pts-diag-panel'
    );

    panel.style.display = 'flex';

    const start = overlay.querySelector(
      '.pts-diagnostic'
    );

    const copy = overlay.querySelector(
      '.pts-diag-copy'
    );

    start.disabled = true;
    copy.textContent = 'コピー';

    const controller = new AbortController();
    ptsDiag.controller = controller;

    const seq = ++ptsDiag.seq;
    ptsDiag.lines = [];

    diagAppend(
      seq,
      `pixiv診断 v3.10.1 / ${new Date().toLocaleString('ja-JP')}`
    );

    diagAppend(
      seq,
      '通信はGETのみ。APIの返答形式は実機で確認します。'
    );

    // 診断内だけで使う一時キャッシュ。
    // 永続ストレージや既存の学習状態は変更しない。
    const recCache = new Map();

    let bookmarkWorks = [];
    let storedHistoryWorks = [];

    try {

      /* ----- 1. ブックマーク一覧 ----- */

      await diagCheck(
        seq,
        '1. ブックマーク一覧',
        async () => {
          const id = getMyUserId();

          if (!id) {
            throw new Error(
              '自分のユーザーIDが不明'
            );
          }

          const body = await diagGet(
            `/ajax/user/${encodeURIComponent(id)}/bookmarks/artworks` +
            '?tag=&offset=0&limit=48&rest=show',
            controller.signal
          );

          if (!Array.isArray(body.works)) {
            throw new Error(
              `body.worksなし（bodyキー: ${diagKeys(body)}）`
            );
          }

          bookmarkWorks = body.works;

          const first = bookmarkWorks[0];

          const tagged = bookmarkWorks.filter(
            w => diagTagShape(w?.tags).count > 0
          ).length;

          const users = bookmarkWorks.filter(
            w =>
              w?.userId != null &&
              String(w.userId) !== ''
          ).length;

          const ugoira = bookmarkWorks.filter(
            w => Number(w?.illustType) === 2
          ).length;

          return (
            `OK / ${bookmarkWorks.length}件` +
            ` / tags ${tagged}/${bookmarkWorks.length}` +
            `（先頭: ${diagTagShape(first?.tags).shape}）` +
            ` / userId ${users}/${bookmarkWorks.length}` +
            ` / うごイラ ${ugoira}` +
            ` / total ${body.total ?? 'なし'}` +
            `\n   先頭キー: ${diagKeys(first)}`
          );
        }
      );

      /* ----- 2. 履歴学習 ----- */

      await diagCheck(
        seq,
        '2. 履歴学習',
        async () => {
          const raw = localStorage.getItem(
            'PTS_PROFILE_V2'
          );

          if (raw == null) {
            throw new Error(
              'PTS_PROFILE_V2が存在しない'
            );
          }

          const saved = JSON.parse(raw);

          // v3.10.0はsaved.historyに保存している。
          const history =
            saved?.history ??
            saved?.bookmarkHistory;

          if (
            !history ||
            typeof history !== 'object'
          ) {
            throw new Error(
              `historyなし（保存キー: ${diagKeys(saved)}）`
            );
          }

          if (!Array.isArray(history.works)) {
            throw new Error(
              '保存済みhistory.worksが配列でない'
            );
          }

          storedHistoryWorks = history.works;

          const tagged = storedHistoryWorks.filter(
            w => diagTagShape(w?.tags).count > 0
          ).length;

          return (
            `OK / initialized=${history.initialized === true}` +
            ` / 保存${storedHistoryWorks.length}件` +
            ` / tags ${tagged}/${storedHistoryWorks.length}`
          );
        }
      );

      /* ----- 3. recommend/init ----- */

      await diagCheck(
        seq,
        '3. recommend/init',
        async () => {
          const first =
            bookmarkWorks.find(
              w => w &&
                (w.id != null || w.illustId != null)
            ) ||
            storedHistoryWorks.find(
              w => w &&
                (w.id != null || w.illustId != null)
            );

          const id = String(
            first?.id ?? first?.illustId ?? ''
          );

          if (!/^\d+$/.test(id)) {
            throw new Error(
              'ブックマーク先頭の作品IDがない'
            );
          }

          const body = await diagGet(
            `/ajax/illust/${encodeURIComponent(id)}` +
            '/recommend/init?limit=60&lang=ja',
            controller.signal
          );

          recCache.set(id, body);

          if (!Array.isArray(body.illusts)) {
            throw new Error(
              `body.illustsなし（bodyキー: ${diagKeys(body)}）`
            );
          }

          const a = body.illusts;

          const tagged = a.filter(
            w => diagTagShape(w?.tags).count > 0
          ).length;

          const users = a.filter(
            w =>
              w?.userId != null &&
              String(w.userId) !== ''
          ).length;

          // キーが存在するかを数える。
          // bookmarkDataがnullでもキー有りに含む。
          const bookmarks = a.filter(
            w =>
              w &&
              Object.prototype.hasOwnProperty.call(
                w,
                'bookmarkData'
              )
          ).length;

          return (
            `OK / illusts ${a.length}件` +
            ` / tags ${tagged}/${a.length}` +
            ` / userId ${users}/${a.length}` +
            ` / bookmarkDataキー ${bookmarks}/${a.length}` +
            ` / nextIds ${
              Array.isArray(body.nextIds)
                ? body.nextIds.length
                : '配列なし'
            }` +
            `\n   先頭キー: ${diagKeys(a[0])}`
          );
        }
      );

      /* ----- 4. タグ検索 ----- */

      await diagCheck(
        seq,
        '4. タグ検索（popular_d）',
        async () => {
          const tag =
            diagTopKey(
              historyProfile.tags,
              profile.tags
            ) || 'R-18';

          const url =
            `/ajax/search/artworks/${encodeURIComponent(tag)}?` +
            new URLSearchParams({
              word: tag,
              order: 'popular_d',
              mode: 'all',
              s_mode: 's_tag',
              p: '1'
            });

          const body = await diagGet(
            url,
            controller.signal
          );

          const found = diagFindArray(body);

          if (!found) {
            throw new Error(
              `候補配列なし（bodyキー: ${diagKeys(body)}）`
            );
          }

          return (
            `OK / タグ「${diagText(tag)}」` +
            ` / popular_d指定（有効性未確認）` +
            ` / ${found.path} ${found.data.length}件` +
            `\n   先頭キー: ${diagKeys(found.data[0])}` +
            ` / bodyキー: ${diagKeys(body)}`
          );
        }
      );

      /* ----- 5. 作者作品一覧 ----- */

      await diagCheck(
        seq,
        '5. 作者作品一覧',
        async () => {
          const userId =
            diagTopKey(
              historyProfile.authors,
              profile.authors
            ) ||
            String(
              (
                bookmarkWorks.find(
                  w => w?.userId
                )?.userId ??
                storedHistoryWorks.find(
                  w => w?.userId
                )?.userId
              ) || ''
            );

          if (!/^\d+$/.test(userId)) {
            throw new Error(
              '最頻作者IDがない'
            );
          }

          let reason = '';

          // 第1候補：profile/all
          try {
            const body = await diagGet(
              `/ajax/user/${encodeURIComponent(userId)}/profile/all`,
              controller.signal
            );

            const il = body.illusts;

            if (
              !il ||
              typeof il !== 'object'
            ) {
              throw new Error(
                `illusts形式不明（bodyキー: ${diagKeys(body)}）`
              );
            }

            const count = Array.isArray(il)
              ? il.length
              : Object.keys(il).length;

            const keys = Array.isArray(il)
              ? []
              : Object.keys(il);

            const kind = Array.isArray(il)
              ? '配列'
              : keys.length === 0
                ? '空オブジェクト'
                : keys.every(k => /^\d+$/.test(k))
                  ? '数字IDキーのオブジェクト'
                  : 'キー形式不明のオブジェクト';

            const manga =
              body.manga &&
              typeof body.manga === 'object'
                ? (
                    Array.isArray(body.manga)
                      ? body.manga.length
                      : Object.keys(body.manga).length
                  )
                : 'なし';

            return (
              `OK / profile/all` +
              ` / illusts: ${kind} ${count}件` +
              ` / manga ${manga}` +
              ` / bodyキー: ${diagKeys(body)}`
            );

          } catch (e) {
            reason = diagError(e);
          }

          // 第2候補：illusts
          try {
            const body = await diagGet(
              `/ajax/user/${encodeURIComponent(userId)}/illusts` +
              '?limit=30&tag=&lang=ja',
              controller.signal
            );

            const found = diagFindArray(body);

            if (!found) {
              throw new Error(
                `候補配列なし（bodyキー: ${diagKeys(body)}）`
              );
            }

            return (
              `OK / 代替illusts使用` +
              ` / ${found.path} ${found.data.length}件` +
              ` / 先頭キー: ${diagKeys(found.data[0])}` +
              ` / 第一候補NG: ${reason}`
            );

          } catch (e) {
            throw new Error(
              `profile/all: ${reason}` +
              ` / 代替illusts: ${diagError(e)}`
            );
          }
        }
      );

      /* ----- 6. フォロー新着 ----- */

      await diagCheck(
        seq,
        '6. フォロー新着',
        async () => {
          const body = await diagGet(
            '/ajax/follow_latest/illust?mode=all&p=1',
            controller.signal
          );

          const found = diagFindArray(body);

          if (!found) {
            throw new Error(
              `候補配列なし（bodyキー: ${diagKeys(body)}）`
            );
          }

          return (
            `OK / ${found.path} ${found.data.length}件` +
            `\n   先頭キー: ${diagKeys(found.data[0])}` +
            ` / bodyキー: ${diagKeys(body)}`
          );
        }
      );

      /* ----- 7. カルーセル照合 ----- */

      await diagCheck(
        seq,
        '7. カルーセル照合',
        async () => {
          const id = location.pathname.match(
            /^\/artworks\/(\d+)/
          )?.[1];

          if (!id) {
            return '対象外（作品ページ以外）';
          }

          const carousel = diagCarouselIds(id);

          if (!carousel.length) {
            return (
              '見つからず（見出し・DOMの変化は要確認）'
            );
          }

          // 3番と同じ作品なら、そのレスポンスを再利用。
          const body =
            recCache.get(id) ||
            await diagGet(
              `/ajax/illust/${encodeURIComponent(id)}` +
              '/recommend/init?limit=60&lang=ja',
              controller.signal
            );

          if (!Array.isArray(body.illusts)) {
            throw new Error(
              `illustsなし（bodyキー: ${diagKeys(body)}）`
            );
          }

          const ids = new Set(
            body.illusts.map(
              x => String(
                x?.id ?? x?.illustId ?? ''
              )
            )
          );

          const matched = carousel.filter(
            x => ids.has(x)
          ).length;

          return (
            `OK / カルーセル${carousel.length}件中` +
            ` recommend/initに${matched}件` +
            ` / DOM見出し探索（要確認）`
          );
        }
      );

      diagAppend(
        seq,
        '完了（診断中の書き込み操作なし）'
      );

    } finally {
      if (seq === ptsDiag.seq) {
        ptsDiag.controller = null;
        start.disabled = false;
      }
    }
  }

  /* ---------- 診断UIの設置 ---------- */

  function installDiagnosticUI() {
    if (ptsDiag.installed || !overlay) return;

    ptsDiag.installed = true;

    // 上部バーのボタン
    const btn = document.createElement('button');

    btn.className = 'pts-diagnostic';
    btn.type = 'button';
    btn.textContent = '診断';

    overlay.querySelector('.pts-rescan').before(btn);

    // 診断結果パネル
    const panel = document.createElement('div');

    panel.className = 'pts-diag-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="pts-diag-sheet"
           role="dialog"
           aria-modal="true"
           aria-label="API診断">
        <div class="pts-diag-toolbar">
          <strong>pixiv API診断（読み取り専用）</strong>
          <button type="button" class="pts-diag-copy">コピー</button>
          <button type="button" class="pts-diag-close">閉じる</button>
        </div>
        <textarea
          class="pts-diag-output"
          readonly
          spellcheck="false"
          aria-label="診断結果"></textarea>
      </div>
    `;

    overlay.appendChild(panel);

    const style = document.createElement('style');

    style.textContent = `
      #pts-overlay .pts-diagnostic {
        background: rgba(255,255,255,.15);
        color: #fff;
        border: 0;
        border-radius: 999px;
        padding: 7px 10px;
        font-size: 12px;
        white-space: nowrap;
        flex-shrink: 0;
      }

      #pts-overlay .pts-bar {
        overflow-x: auto;
        overscroll-behavior-x: contain;
        white-space: nowrap;
        -webkit-overflow-scrolling: touch;
      }

      #pts-overlay .pts-close {
        position: sticky;
        right: 0;
        flex-shrink: 0;
        z-index: 4;
      }

      #pts-overlay .pts-diag-panel {
        position: absolute;
        inset: 0;
        z-index: 30;
        background: rgba(0,0,0,.85);
        align-items: center;
        justify-content: center;
        padding:
          calc(14px + env(safe-area-inset-top))
          12px
          calc(14px + env(safe-area-inset-bottom));
        box-sizing: border-box;
      }

      #pts-overlay .pts-diag-sheet {
        width: 100%;
        max-width: 900px;
        height: 83vh;
        height: 83dvh;
        max-height: 100%;
        display: flex;
        flex-direction: column;
        background: #171717;
        color: white;
        border: 1px solid #555;
        border-radius: 12px;
        box-sizing: border-box;
        padding: 10px;
        min-height: 0;
      }

      #pts-overlay .pts-diag-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 13px;
      }

      #pts-overlay .pts-diag-toolbar strong {
        flex: 1;
      }

      #pts-overlay .pts-diag-toolbar button {
        background: #333;
        color: white;
        border: 1px solid #666;
        border-radius: 8px;
        padding: 9px 12px;
        white-space: nowrap;
      }

      #pts-overlay .pts-diag-output {
        width: 100%;
        flex: 1;
        min-height: 0;
        resize: none;
        box-sizing: border-box;
        background: #080808;
        color: #eee;
        border: 1px solid #444;
        border-radius: 7px;
        padding: 10px;
        font: 12px/1.65 ui-monospace, Menlo, monospace;
        white-space: pre-wrap;
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }
    `;

    document.head.appendChild(style);

    btn.addEventListener(
      'click',
      () => {
        void runDiagnostic();
      }
    );

    panel.querySelector('.pts-diag-close')
      .addEventListener(
        'click',
        closeDiagnosticPanel
      );

    panel.querySelector('.pts-diag-copy')
      .addEventListener(
        'click',
        () => {
          void copyDiagnosticReport();
        }
      );
  }

  function openViewer() {
    buildOverlay();
    // 診断ボタンとパネルを一度だけ設置する（この時点では診断は実行しない）
    installDiagnosticUI();
    overlay.style.display = 'block';
    keepAwake(true);
    buildFeed();
    setTimeout(() => pageLoadMore(), 800);
    setTimeout(() => pageLoadMore(), 2500);
  }

  function closeViewer() {
    // 診断中なら通信を中止し、パネルを閉じる
    closeDiagnosticPanel();
    feedGeneration++;
    customResetState();
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
        <button class="pts-custom">自前フィード</button>
        <button class="pts-rescan">再スキャン</button>
        <button class="pts-close" title="閉じる">✕</button>
      </div>
      <div class="pts-feed"></div>
    `;
    feedEl = overlay.querySelector('.pts-feed');
    overlay.querySelector('.pts-close').addEventListener('click', closeViewer);
    overlay.querySelector('.pts-rescan').addEventListener('click', buildFeed);
    overlay.querySelector('.pts-custom').addEventListener('click', switchToCustom);
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
        if (mode === 'custom') customLoadMore();
        else if (mode === 'related') relatedLoadMore();
        else if (mode === 'page') pageLoadMore();
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
      .pts-custom{background:#0096fa;color:#fff;border:0;border-radius:999px;padding:7px 12px;cursor:pointer;font-size:12px;white-space:nowrap;}
      .pts-custom:disabled{opacity:.6;}
      @media (max-width:480px){
        .pts-bar{gap:5px;padding:8px 6px;}
        .pts-custom{padding:7px 8px;font-size:11px;}
        .pts-counter{font-size:11px;}
      }
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
