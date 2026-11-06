// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      3.13.1
// @description  今開いているpixivのページに並んでいる作品を、元画像で1枚ずつTikTok風に縦スクロールして眺めるビューアです。複数枚は横スライド、うごイラはアニメーション再生。
// @match        https://www.pixiv.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__ptsLoaded) {
    return;
  }
  window.__ptsLoaded = true;

  let overlay = null;
  let feedEl = null;
  let slides = [];
  let mode = 'custom'; // 'custom' | 'search'
  let nearObs = null;
  // 画像サーバーへの接続を先に温めておく（初回表示の高速化）
  const pc = document.createElement('link');
  pc.rel = 'preconnect';
  pc.href = 'https://i.pximg.net';
  pc.crossOrigin = 'anonymous';
  document.head.appendChild(pc);


  function pickPair(urls) {
    if (!urls) return { r: '', o: '' };
    return { r: urls.regular || urls.original || '', o: urls.original || urls.regular || '' };
  }

  /* ---------- ページ内スキャン（3段構え） ---------- */



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


  /* ---------- 作品情報の解決（元画像・複数枚・うごイラ） ---------- */

  function upgradeUrl(url) {
    if (!url) return '';
    let u = url.replace(/^https:\/\/i\.pximg\.net\/c\/[^/]+\//, 'https://i.pximg.net/');
    u = u.replace(/_(square1200|custom1200)\.(\w+)$/, '_p0_master1200.jpg');
    return u;
  }

  async function fetchJson(url, signal, cacheMode) {
    const options = {
      method: 'GET',
      credentials: 'same-origin',
      signal
    };

    if (cacheMode) options.cache = cacheMode;

    const res = await fetch(url, options);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    if (!json || typeof json !== 'object') {
      throw new Error('JSON形式が不正');
    }

    if (json.error) {
      throw new Error(json.message || 'api error');
    }

    if (json.body == null) {
      throw new Error('API bodyがありません');
    }

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

  function seriesNextId(nav) {
    if (!nav || typeof nav !== 'object') return null;

    const options = [
      nav.next, nav.nextIllust, nav.nextArtwork,
      nav.nextWork, nav.nextEpisode,
      nav.nextIllustId, nav.nextId
    ];

    for (const value of options) {
      const id = value && typeof value === 'object'
        ? (value.id ?? value.illustId ??
           value.illust?.id ?? value.work?.id)
        : value;

      if (id != null && /^\d+$/.test(String(id))) {
        return String(id);
      }
    }

    return null;
  }

  async function resolveSlideImpl(s, signal) {
    const cacheMode = s.forceRefetch ? 'no-store' : undefined;
    const get = (path, sig) =>
      fetchJson(path, sig, cacheMode);

    try {
      const body = await get(`/ajax/illust/${s.id}`, signal);

      if (signal?.aborted) return;

      s.seriesNextId = seriesNextId(body.seriesNavData);
      s.seriesInfoChecked = true;
      s.rawType = Number(body.illustType);
      s.tags = normTags(body.tags);
      s.userId = body.userId == null
        ? null : String(body.userId);

      s.bookmarked = s.bookmarked ||
        knownBookmarkedIds.has(String(s.id)) ||
        !!body.bookmarkData;

      if (s.bookmarked) {
        knownBookmarkedIds.add(String(s.id));

        if (!s.tasteLearned &&
            !bookmarkHistory.works.some(w =>
              String(w.id) === String(s.id))) {
          learnFromWork(s.tags, s.userId, s.rawType, 3);
          s.tasteLearned = true;
        }
      }

      paintBookmarkBtn(s);

      if (body.title && !s.title) {
        s.title = body.title;
        if (s.titleEl) s.titleEl.textContent = s.title;
      }

      if (body.userName) {
        s.author = body.userName;
        if (s.authorEl) s.authorEl.textContent = s.author;
      }

      const pageCount = Number(body.pageCount) || 1;

      if (s.rawType === 2) {
        s.kind = 'ugoira';
        setUgoiraStatus(s, 'loading');

        try {
          const meta = await get(
            `/ajax/illust/${s.id}/ugoira_meta`,
            signal
          );

          if (signal?.aborted) return;

          s.zipSmall = meta.src || null;
          s.zipFull = meta.originalSrc || null;
          s.zipUrl = s.zipSmall || s.zipFull;
          s.frames = Array.isArray(meta.frames)
            ? meta.frames : null;

          if (!s.zipUrl) s.ugoiraError = 'ZIPなし';
          else if (!s.frames?.length) {
            s.ugoiraError = 'フレーム情報なし';
          }
        } catch (e) {
          if (signal?.aborted) return;
          s.ugoiraError = 'メタ取得失敗: ' +
            (e?.message || String(e));
        }

        const pair = pickPair(body.urls);
        s.pairs = [pair];

        const m = (pair.o || '')
          .match(/^(.*_ugoira)0(\.\w+)$/);

        if (m) {
          s.frameBase = m[1];
          s.frameExt = m[2];
        }

        if (s.ugoiraError) {
          setUgoiraStatus(s, 'error', s.ugoiraError);
        }

      } else if (pageCount > 1) {
        s.kind = 'multi';
        setUgoiraStatus(s, 'none');

        try {
          const pages = await get(
            `/ajax/illust/${s.id}/pages`,
            signal
          );

          if (signal?.aborted) return;

          s.pairs = pages.map(p => pickPair(p.urls));

        } catch (e) {
          if (signal?.aborted) return;
          s.pairs = [pickPair(body.urls)];
          s.kind = 'single';
        }

      } else {
        s.kind = 'single';
        s.pairs = [pickPair(body.urls)];
        setUgoiraStatus(s, 'none');
      }

    } catch (e) {
      if (signal?.aborted) return;

      s.resolveError = e?.message || String(e);

      if (Number(s.rawType) === 2 || s.kind === 'ugoira') {
        setUgoiraStatus(s, 'error', s.resolveError);
      } else {
        setUgoiraStatus(s, 'none');
      }

      s.kind = 'single';
      const u = upgradeUrl(s.thumb) || s.thumb;
      s.pairs = [{ r: u, o: u }];
    }

    if (signal?.aborted) return;

    s.resolved = true;
    applyResolved(s);
    upgradeSlide(s);
  }

  // 表示レベルに応じて画像を差し替える：表示中は元画像、近くは1200px
  function levelUrl(s, pair) {
    if (!pair) return s.thumb;
    return s.isCurrent
      ? (pair.o || pair.r)
      : (pair.r || pair.o);
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

    const holder = s.sectionEl?.querySelector('.pts-holder');
    if (!holder) return;

    if (s.kind === 'multi') {
      const imgs = holder.querySelectorAll('.pts-page img');

      imgs.forEach((im, i) => {
        const pair = s.pairs[i];
        if (!pair) return;

        if (force) {
          const target = levelUrl(s, pair);
          if (target && im.getAttribute('src') !== target) {
            im.src = target;
          }
        } else if (s.isCurrent && i === (s.pageIdx || 0)) {
          swapToOriginal(s, im, pair);
        }
      });

      s.mainImg =
        imgs[s.pageIdx || 0] || imgs[0] || s.mainImg;

    } else {
      const pair = s.pairs[0];

      if (s.mainImg && pair) {
        if (force) {
          const target = levelUrl(s, pair);
          if (target && s.mainImg.getAttribute('src') !== target) {
            s.mainImg.src = target;
          }
        } else if (s.isCurrent) {
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

  function setUgoiraStatus(s, state, message = '') {
    const el = s?.ugoiraStatusEl;
    if (!el) return;

    if (state === 'none' || state === 'playing') {
      el.hidden = true;
      el.textContent = '';
      return;
    }

    el.hidden = false;
    el.classList.toggle('pts-ugoira-error', state === 'error');

    el.textContent = state === 'error'
      ? `⚠ うごイラ読み込み失敗: ${message || '不明なエラー'}`
      : '◌ うごイラ読み込み中…';
  }

  function startUgoira(s) {
    if (s.animTimer || !s.frameUrls?.length ||
        !s.frames?.length || !s.isCurrent) return;

    setUgoiraStatus(s, 'playing');
    upgradeUgoiraHiRes(s);

    if (s.pageChip) {
      s.pageChip.style.display = 'block';
      s.pageChip.textContent = 'うごイラ再生中';
    }

    const total = s.frames.reduce(
      (sum, f) => sum + (f.delay || 100), 0
    );

    s.animTotal = total;
    if (s.seekEl) s.seekEl.style.display = 'block';

    const step = () => {
      if (!s.frameUrls?.length || !s.isCurrent) {
        s.animTimer = null;
        return;
      }

      const i = s.animIdx % s.frameUrls.length;
      const url = s.frameUrls[i];

      if (url && s.mainImg && s.mainImg.src !== url) {
        s.mainImg.src = url;
      }

      let elapsed = 0;
      for (let k = 0; k < i; k++) {
        elapsed += s.frames[k]?.delay || 100;
      }

      const pct = total > 0 ? elapsed / total * 100 : 0;

      if (s.seekFill) s.seekFill.style.width = pct + '%';
      if (s.seekKnob) s.seekKnob.style.left = pct + '%';

      const delay = s.frames[i]?.delay || 100;

      s.animIdx++;
      s.loopSteps = (s.loopSteps || 0) + 1;

      s.animTimer = setTimeout(() => {
        s.animTimer = null;
        if (!s.isCurrent) return;

        if (s.loopSteps >= s.frameUrls.length) {
          s.loopSteps = 0;
          onUgoiraLoop(s);
        }

        step();
      }, delay);
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
    s.loopSteps = 0;
  }

  function setChip(s, text) {
    if (!s.pageChip) return;
    s.pageChip.style.display = 'block';
    s.pageChip.textContent = text;
  }

  async function prepareUgoira(s) {
    if (s.frameUrls || s.preparingUgoira) return;

    if (s.ugoiraError || !s.frames?.length) {
      setUgoiraStatus(
        s, 'error', s.ugoiraError || 'フレーム情報なし'
      );
      return;
    }

    s.preparingUgoira = true;
    s.ugoiraAbort = new AbortController();
    setUgoiraStatus(s, 'loading');

    try {
      if (s.zipUrl) {
        s.frameUrls = await unzipFrames(
          s.zipUrl, s.frames, s.ugoiraAbort.signal
        );

        if (!s.frameUrls.some(Boolean)) {
          throw new Error('フレーム0枚');
        }

        if (s.isCurrent) startUgoira(s);
        upgradeUgoiraHiRes(s);
        return;
      }

      if (s.frameBase && s.frameExt) {
        const urls = s.frames.map(
          (f, i) => `${s.frameBase}${i}${s.frameExt}`
        );

        const available = await new Promise(done => {
          const probe = new Image();
          probe.onload = () => done(true);
          probe.onerror = () => done(false);
          probe.src = urls[Math.min(1, urls.length - 1)];
        });

        if (!available) {
          throw new Error('個別フレーム取得不可');
        }

        s.frameUrls = urls;

        urls.forEach(url => {
          const img = new Image();
          img.src = url;
        });

        if (s.isCurrent) startUgoira(s);
        return;
      }

      throw new Error('再生手段なし');

    } catch (e) {
      if (e?.name !== 'AbortError') {
        s.ugoiraError = e?.message || String(e);
        setUgoiraStatus(s, 'error', s.ugoiraError);
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
    const now = Date.now();
    reloadTimes = reloadTimes.filter(t => now - t < 60000);
    reloadTimes.push(now);

    if (reloadTimes.length >= 3) {
      effectsReduced = true;
      overlay?.classList.add('pts-low-effects');
    }

    const img = s.mainImg;
    const pair = s.pairs?.[s.pageIdx || 0] || s.pairs?.[0];

    if (!img || !pair) return;

    const url = pair.o || pair.r;
    if (!url) return;

    img.removeAttribute('src');
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

  function checkMangaComplete(s, idx) {
    if (!s || s.kind !== 'multi' || !s.isCurrent ||
        !s.pairs || idx !== s.pairs.length - 1) return;

    const img = s.sectionEl
      ?.querySelectorAll('.pts-page img')[idx];

    if (!img) return;

    if (img.complete && img.naturalWidth > 0) {
      applyPositive(s, 'complete', 1.0);

    } else if (s.completeWaitImg !== img) {
      s.completeWaitImg = img;

      img.addEventListener('load', () => {
        if (s.isCurrent &&
            s.pageIdx === s.pairs?.length - 1) {
          applyPositive(s, 'complete', 1.0);
        }
      }, { once: true });
    }
  }

  function applyResolved(s) {
    if (!s.sectionEl) return;

    const multi = s.kind === 'multi' &&
      Array.isArray(s.pairs) && s.pairs.length > 1;

    s.sectionEl.classList.toggle('pts-multi', multi);

    const holder = s.sectionEl.querySelector('.pts-holder');
    if (!holder) return;

    if (multi) {
      holder.innerHTML = '';

      const pager = document.createElement('div');
      pager.className = 'pts-pager';

      s.pairs.forEach((pair, i) => {
        const pg = document.createElement('div');
        pg.className = 'pts-page';
        const im = document.createElement('img');
        im.className = 'pts-img';
        im.decoding = 'async';

        if (i <= 1) im.src = pair.r || pair.o;
        else im.dataset.src = pair.r || pair.o;

        im.loading = i === 0 ? 'eager' : 'lazy';
        im.alt = s.title || '';
        pg.appendChild(im);
        pager.appendChild(pg);
      });

      pager.addEventListener('scroll', () => {
        const idx = Math.max(
          0,
          Math.min(
            s.pairs.length - 1,
            Math.round(
              pager.scrollLeft /
              Math.max(1, pager.clientWidth)
            )
          )
        );

        s.pageIdx = idx;

        if (s.pageChip) {
          s.pageChip.textContent =
            `${idx + 1} / ${s.pairs.length}`;
        }

        loadHorizontalNeighbors(s, idx);
        upgradeSlide(s);
        checkMangaComplete(s, idx);
      }, { passive: true });

      holder.appendChild(pager);

      if (s.pageChip) {
        s.pageChip.style.display = 'block';
        s.pageChip.textContent = `1 / ${s.pairs.length}`;
      }

      s.mainImg = pager.querySelector('img');

    } else {
      const pair = s.pairs && s.pairs[0];
      const target = (pair && (pair.r || pair.o)) || s.thumb;
      const im = s.mainImg;

      if (im && holder.contains(im)) {
        if (im.dataset) delete im.dataset.ptsPh;
        if (target &&
            !(im.getAttribute('src') || '').includes(target)) {
          im.src = target;
        }
        im.alt = s.title || im.alt || '';

      } else {
        holder.innerHTML = '';
        const nim = document.createElement('img');
        nim.className = 'pts-img';
        nim.decoding = 'async';
        nim.src = target;
        nim.alt = s.title || '';

        nim.addEventListener('error', () => {
          if (s.thumb && !nim.src.includes(s.thumb)) {
            nim.src = s.thumb;
          }
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
    ph.loading = idx < 2 ? 'eager' : 'lazy';

    if (idx < 3) {
      ph.src = upgradeUrl(s.thumb) || s.thumb;
      ph.onerror = () => {
        if (s.thumb && ph.src !== s.thumb) {
          ph.src = s.thumb;
        }
      };
    } else {
      ph.dataset.ptsPh = '1';
    }

    ph.alt = s.title || '';
    holder.appendChild(ph);
    sec.appendChild(holder);
    s.mainImg = ph;

    const chip = document.createElement('div');
    chip.className = 'pts-pagechip';
    chip.style.display = 'none';
    sec.appendChild(chip);
    s.pageChip = chip;

    const status = document.createElement('div');
    status.className = 'pts-ugoira-status';
    status.hidden = true;
    status.setAttribute('role', 'status');
    sec.appendChild(status);
    s.ugoiraStatusEl = status;

    if (Number(s.rawType) === 2) {
      setUgoiraStatus(s, 'loading');
    }

    const seek = document.createElement('div');
    seek.className = 'pts-seek';
    seek.style.display = 'none';

    const fill = document.createElement('div');
    fill.className = 'pts-seek-fill';
    seek.appendChild(fill);

    const knob = document.createElement('div');
    knob.className = 'pts-seek-knob';
    seek.appendChild(knob);

    s.seekEl = seek;
    s.seekFill = fill;
    s.seekKnob = knob;

    const dragTo = clientX => {
      const r = seek.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(
        0, (clientX - r.left) / Math.max(1, r.width)
      ));
      dragUgoira(s, ratio);
    };

    seek.addEventListener('pointerdown', e => {
      seek.setPointerCapture(e.pointerId);
      s.seekDragging = true;
      stopUgoira(s);
      dragTo(e.clientX);
      e.stopPropagation();
      e.preventDefault();
    });

    seek.addEventListener('pointermove', e => {
      if (s.seekDragging) dragTo(e.clientX);
    });

    const endDrag = () => {
      if (!s.seekDragging) return;
      s.seekDragging = false;

      if (s.isCurrent && s.frameUrls) {
        startUgoira(s);
      }
    };

    seek.addEventListener('pointerup', endDrag);
    seek.addEventListener('pointercancel', endDrag);
    sec.appendChild(seek);

    feedEl.appendChild(sec);
    if (nearObs) nearObs.observe(sec);
  }

  /* ---------- 関連作品への切り替え ---------- */



  // 関連モードの続き読み込み（候補IDが残っている間は末尾に足していく）

  /* ---------- フィード管理 ---------- */

  function updateCounter() {
    const c = overlay?.querySelector('.pts-counter');
    if (!c) return;

    if (!slides.length) {
      c.textContent = mode === 'search'
        ? '検索結果を取得中…'
        : '自前フィード準備中…';
    } else {
      c.textContent =
        `${slides.length}件（${mode === 'search' ? '検索' : '自前'}）`;
    }

    syncDock();
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
    if (!feedEl || !slides.length) return;

    const idx = Math.max(
      0, Math.min(slides.length - 1, currentIndex())
    );

    slides.forEach((s, i) => {
      const current = i === idx;
      s.sectionEl?.classList.toggle('pts-current', current);

      if (current && !s.isCurrent) {
        s.isCurrent = true;

        if (s.resolved) upgradeSlide(s);
        else void resolveSlide(s);

        if (s.kind === 'ugoira') {
          if (s.frameUrls?.length) startUgoira(s);
          else if (s.resolved) void prepareUgoira(s);
        }

        armWatchdog(s);

      } else if (!current && s.isCurrent) {
        s.isCurrent = false;
        stopUgoira(s);
        if (s.resolved) upgradeSlide(s);
      }
    });

    const s = slides[idx];
    onCurrentSlideChanged(s);

    for (
      let i = Math.max(0, idx - 3);
      i <= Math.min(slides.length - 1, idx + 3);
      i++
    ) {
      const x = slides[i];

      if (x.mainImg?.dataset?.ptsPh &&
          !x.mainImg.getAttribute('src') && x.thumb) {
        x.mainImg.src = x.thumb;
      }
    }

    for (const [step, field, urlKey] of [
      [1, 'preloadedO', 'o'],
      [2, 'preloadedR', 'r']
    ]) {
      const n = slides[idx + step];

      if (n?.resolved &&
          n.kind !== 'ugoira' &&
          n.pairs?.[0]?.[urlKey] &&
          !n[field]) {
        n[field] = true;
        const pre = new Image();
        pre.decoding = 'async';
        pre.src = n.pairs[0][urlKey];
      }
    }

    syncDock();
  }

  /* ---------- 自前レコメンド v2（履歴500件＋永続化） ---------- */
  /* ---------- v3.12 配布対応：アカウント識別 ---------- */

  function detectLoggedInPixivId() {
    const ids = [];
    const valid = value => {
      const id = String(value ?? '');
      return /^[1-9]\d*$/.test(id) ? id : '';
    };
    const add = value => {
      const id = valid(value);
      if (id) ids.push(id);
    };
    const parse = text => {
      if (!text || typeof text !== 'string') return null;
      try { return JSON.parse(text); }
      catch (e) { return null; }
    };

    // 方式1：pixivのサーバー埋め込みログイン情報
    const meta = document.querySelector(
      'meta[name="global-data"]'
    );

    const globalData = parse(meta?.content);

    if (globalData?.isLoggedIn === false ||
        globalData?.userData?.isLoggedIn === false) {
      return '';
    }

    add(globalData?.userData?.id);
    add(globalData?.userData?.userId);

    // 方式2：Next.jsのページ埋め込み情報
    const next = parse(
      document.getElementById('__NEXT_DATA__')
        ?.textContent
    );

    const props = next?.props?.pageProps;

    if (props?.isLoggedIn === false ||
        props?.gaUserData?.isLoggedIn === false) {
      return '';
    }

    add(props?.gaUserData?.userId);

    const state = props?.serverSerializedPreloadedState;
    const parsedState = typeof state === 'string'
      ? parse(state)
      : state;

    add(parsedState?.userData?.self?.id);
    add(parsedState?.userData?.self?.userId);

    // 取得元が矛盾した場合は使用しない。
    const unique = [...new Set(ids)];

    if (unique.length !== 1) {
      console.warn(
        '[PTS] ログインユーザーIDを確定できません',
        unique.length > 1 ? '取得元が不一致' : '識別情報なし'
      );
      return '';
    }

    return unique[0];
  }

  const ACTIVE_PIXIV_USER_ID = detectLoggedInPixivId();

  function accountStorageKey(base) {
    if (!ACTIVE_PIXIV_USER_ID) return '';
    return `${base}:user:${ACTIVE_PIXIV_USER_ID}`;
  }

  function legacyProfileOwnerMatches() {
    if (!ACTIVE_PIXIV_USER_ID) return false;

    try {
      const saved = JSON.parse(
        localStorage.getItem('PTS_PROFILE_V2') || 'null'
      );

      return saved?.version === 2 &&
        String(saved?.history?.userId || '') ===
          ACTIVE_PIXIV_USER_ID;
    } catch (e) {
      return false;
    }
  }

  function readAccountStorage(base) {
    const key = accountStorageKey(base);
    if (!key) return null;

    try {
      const current = localStorage.getItem(key);
      if (current !== null) return current;

      const legacy = localStorage.getItem(base);
      if (legacy === null) return null;

      let mayMigrate = legacyProfileOwnerMatches();

      // スキップ履歴には所有者IDを直接保存している。
      if (base === 'PTS_SKIP_V1') {
        try {
          const data = JSON.parse(legacy);
          mayMigrate =
            String(data?.userId || '') === ACTIVE_PIXIV_USER_ID;
        } catch (e) {
          mayMigrate = false;
        }
      }

      if (!mayMigrate) return null;

      // コピーのみ。旧キーは変更しない。
      try {
        localStorage.setItem(key, legacy);
      } catch (e) {
        console.warn('[PTS] 旧データの移行保存失敗', e);
      }

      return legacy;

    } catch (e) {
      console.warn('[PTS] アカウント別データ読み込み失敗', e);
      return null;
    }
  }

  const PROFILE_KEY = 'PTS_PROFILE_V2';
  const HISTORY_LIMIT = 500;
  const HISTORY_PAGE_SIZE = 48;
  const HISTORY_REFRESH_MS = 6 * 60 * 60 * 1000;
  const HISTORY_HALF_LIFE = 100;

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
    // 未ログイン・ID不明なら旧データを使用しない。
    if (!getMyUserId()) return;

    let saved = null;

    try {
      saved = JSON.parse(
        readAccountStorage(PROFILE_KEY) || 'null'
      );
    } catch (e) {
      console.warn('[PTS] プロフィール解析失敗', e);
    }

    if (!saved || saved.version !== 2) return;

    if (saved.live &&
        typeof saved.live === 'object') {
      const p = saved.live;

      if (p.tags && typeof p.tags === 'object' &&
          !Array.isArray(p.tags)) {
        profile.tags = p.tags;
      }

      if (p.authors && typeof p.authors === 'object' &&
          !Array.isArray(p.authors)) {
        profile.authors = p.authors;
      }

      profile.ugoira = Number(p.ugoira) || 0;
    }

    const h = saved.history;

    if (h && Array.isArray(h.works) &&
        String(h.userId || '') === getMyUserId()) {
      bookmarkHistory = {
        userId: getMyUserId(),
        works: h.works.slice(0, HISTORY_LIMIT),
        initialized: h.initialized === true,
        updatedAt: Number(h.updatedAt) || 0,
        dateMigrationChecked: h.dateMigrationChecked === true
      };
    }
  }

  function saveProfile() {
    const key = accountStorageKey(PROFILE_KEY);

    if (!key) return;

    try {
      localStorage.setItem(key, JSON.stringify({
        version: 2,
        live: profile,
        history: bookmarkHistory
      }));
    } catch (e) {
      console.warn('[PTS] profile保存失敗', e);
    }
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

  /* ---------- v3.12: 独立したスキップ学習 ---------- */

  const SKIP_KEY = 'PTS_SKIP_V1';
  const skipProfile = {
    tags: {},
    authors: {},
    works: {}
  };

  const skippedThisSession = new Set();
  const viewedThisSession = new Set();

  let navIntent = { reason: 'other', until: 0 };
  let skipNavigationBound = false;

  function loadSkipProfile() {
    if (!getMyUserId()) return;

    try {
      const raw = JSON.parse(
        readAccountStorage(SKIP_KEY) || 'null'
      );

      if (!raw ||
          String(raw.userId || '') !== getMyUserId()) {
        return;
      }

      for (const key of ['tags', 'authors', 'works']) {
        if (raw[key] &&
            typeof raw[key] === 'object' &&
            !Array.isArray(raw[key])) {
          Object.assign(skipProfile[key], raw[key]);
        }
      }
    } catch (e) {
      console.warn('[PTS] スキップ履歴読み込み失敗', e);
    }
  }

  function saveSkipProfile() {
    const key = accountStorageKey(SKIP_KEY);
    if (!key) return;

    const entries = Object.entries(skipProfile.works)
      .sort((a, b) =>
        (Number(b[1]?.time) || 0) -
        (Number(a[1]?.time) || 0)
      );

    skipProfile.works =
      Object.fromEntries(entries.slice(0, 2000));

    try {
      localStorage.setItem(key, JSON.stringify({
        userId: getMyUserId(),
        ...skipProfile
      }));
    } catch (e) {
      console.warn('[PTS] スキップ履歴保存失敗', e);
    }
  }

  function learnSkip(s) {
    const id = String(s?.id || '');

    if (!/^\d+$/.test(id) ||
        skippedThisSession.has(id) ||
        s.bookmarked || s.likedThisSession) return;

    skippedThisSession.add(id);

    for (const tag of normTags(s.tags)) {
      skipProfile.tags[tag] = Math.min(
        50,
        (Number(skipProfile.tags[tag]) || 0) + 0.15
      );
    }

    if (s.userId) {
      const author = String(s.userId);
      skipProfile.authors[author] = Math.min(
        50,
        (Number(skipProfile.authors[author]) || 0) + 0.15
      );
    }

    const old = skipProfile.works[id];

    skipProfile.works[id] = {
      count: Math.min(20, (Number(old?.count) || 0) + 1),
      time: Date.now()
    };

    saveSkipProfile();
  }

  function skipStrong(id) {
    return (
      Number(skipProfile.works[String(id)]?.count) || 0
    ) >= 2;
  }

  function bindSkipNavigation() {
    if (skipNavigationBound || !feedEl) return;
    skipNavigationBound = true;

    const userIntent = () => {
      navIntent = {
        reason: 'user',
        until: performance.now() + 2500
      };
    };

    feedEl.addEventListener('touchstart', e => {
      if (e.touches.length === 1) userIntent();
    }, { passive: true, capture: true });

    feedEl.addEventListener('pointerdown', e => {
      if (e.isPrimary) userIntent();
    }, { passive: true, capture: true });

    feedEl.addEventListener('wheel', userIntent, {
      passive: true
    });
  }

  loadSkipProfile();

  function getMyUserId() {
    // ページ読み込み時に確認したログインユーザーのみ。
    // 他人のプロフィールURLや作品の作者IDは使わない。
    return ACTIVE_PIXIV_USER_ID;
  }

  function parseBookmarkPage(body) {
    if (!body || !Array.isArray(body.works)) {
      throw new Error('bookmarks API: body.worksがありません');
    }

    return body.works.map(w => {
      const id = w && (w.id ?? w.illustId);
      if (id == null) return null;

      return {
        id: String(id),
        userId: w.userId == null ? '' : String(w.userId),
        tags: normTags(w.tags),
        illustType: Number(w.illustType),
        pageCount: Number(w.pageCount) || 1,
        createDate: typeof w.createDate === 'string'
          ? w.createDate : null
      };
    }).filter(Boolean);
  }

  function learnFromBookmarks(works) {
    const next = { tags: {}, authors: {}, ugoira: 0 };
    const now = Date.now();

    (works || []).slice(0, HISTORY_LIMIT)
      .forEach((work, index) => {
        const ts = Date.parse(work.createDate || '');
        const valid = Number.isFinite(ts) &&
          ts > 0 && ts <= now + 86400000;

        const weight = valid
          ? Math.pow(
              0.5,
              Math.max(0, now - ts) / (180 * 86400000)
            )
          : Math.pow(0.5, index / HISTORY_HALF_LIFE);

        for (const tag of normTags(work.tags)) {
          next.tags[tag] = (next.tags[tag] || 0) + weight;
        }

        if (work.userId) {
          const id = String(work.userId);
          next.authors[id] =
            (next.authors[id] || 0) + weight;
        }

        if (Number(work.illustType) === 2) {
          next.ugoira += weight;
        }
      });

    historyProfile = next;
  }

  function applyBookmarkHistory() {
    learnFromBookmarks(bookmarkHistory.works);
    for (const work of bookmarkHistory.works) knownBookmarkedIds.add(String(work.id));
  }

  /* ---------- ブックマークAPI取得 v3.10.2 ---------- */

  // 履歴学習で最後に成功した取得方式。
  // 診断モードからは変更しない。
  let bookmarkApiMethod = '';

  // 通常の履歴取得でもHTTPステータスを確認する。
  // 既存のfetchJson()には変更を加えない。
  async function getBookmarkApiBody(url) {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin'
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

    if (
      !json ||
      typeof json !== 'object' ||
      Array.isArray(json)
    ) {
      throw new Error('JSON形式が想定外');
    }

    if (json.error) {
      throw new Error(
        `API error: ${String(json.message || '詳細なし')}`
      );
    }

    if (
      !json.body ||
      typeof json.body !== 'object' ||
      Array.isArray(json.body)
    ) {
      throw new Error(
        'bodyがオブジェクトではない'
      );
    }

    return json.body;
  }

  // 履歴学習と診断で共有するAPIフォールバック。
  //
  // A: /ajax/user/{id}/illusts/bookmarks
  // B: /ajax/user/{id}/bookmarks/artworks
  //
  // AがHTTPエラー・形式不正ならBを試す。
  // 両方失敗した場合は、両方の理由を返す。
  //
  // getBody:
  //   履歴学習 → getBookmarkApiBody
  //   診断     → diagGetを呼ぶ関数
  async function fetchBookmarkBodyWithFallback(
    userId,
    offset,
    limit,
    getBody
  ) {
    const id = String(userId || '');

    if (!/^\d+$/.test(id)) {
      throw new Error(
        'ユーザーIDが不正または不明'
      );
    }

    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error(
        'offsetまたはlimitが不正'
      );
    }

    const params =
      `?tag=&offset=${offset}` +
      `&limit=${limit}&rest=show`;

    const sources = [
      {
        method: 'illusts/bookmarks',
        url:
          `/ajax/user/${id}/illusts/bookmarks${params}`
      },
      {
        method: 'bookmarks/artworks',
        url:
          `/ajax/user/${id}/bookmarks/artworks${params}`
      }
    ];

    const failures = [];

    for (const source of sources) {
      try {
        const body = await getBody(source.url);

        if (
          !body ||
          !Array.isArray(body.works)
        ) {
          const keys =
            body && typeof body === 'object'
              ? Object.keys(body)
                  .slice(0, 20)
                  .join(', ')
              : 'なし';

          throw new Error(
            `body.worksが配列でない` +
            `（bodyキー: ${keys}）`
          );
        }

        return {
          body,
          method: source.method,
          fallbackReason:
            failures.length
              ? failures.join(' / ')
              : ''
        };

      } catch (e) {
        failures.push(
          `${source.method}: ` +
          (e && e.message
            ? e.message
            : String(e))
        );
      }
    }

    throw new Error(
      `両方式失敗 / ${failures.join(' / ')}`
    );
  }

  // 既存のinitProfileFromBookmarks()から呼ばれる関数。
  // 返り値は従来どおり作品配列なので
  // 既存のページング処理を変更する必要はない。
  async function fetchBookmarkPage(userId, offset) {
    const result =
      await fetchBookmarkBodyWithFallback(
        userId,
        offset,
        HISTORY_PAGE_SIZE,
        getBookmarkApiBody
      );

    const works = parseBookmarkPage(
      result.body
    );

    // パースまで成功した場合のみ記録。
    bookmarkApiMethod = result.method;

    return works;
  }

  async function initProfileFromBookmarks(force = false) {
    if (historyInitPromise) return historyInitPromise;

    const userId = getMyUserId();
    if (!userId) {
      console.warn('[PTS] 自分のIDが不明');
      return;
    }

    if (bookmarkHistory.userId &&
        bookmarkHistory.userId !== userId) {
      bookmarkHistory = {
        userId, works: [], initialized: false,
        updatedAt: 0, dateMigrationChecked: false
      };
      historyProfile = { tags: {}, authors: {}, ugoira: 0 };
    }

    bookmarkHistory.userId = userId;
    applyBookmarkHistory();

    const fresh =
      Date.now() - bookmarkHistory.updatedAt < HISTORY_REFRESH_MS;

    if (!force && bookmarkHistory.initialized && fresh &&
        bookmarkHistory.dateMigrationChecked) return;

    historyInitPromise = (async () => {
      const previous = bookmarkHistory.initialized
        ? bookmarkHistory.works : [];
      const oldIds = new Set(previous.map(w => String(w.id)));
      const incoming = [], seen = new Set();
      let overlap = false, exhausted = false;

      for (let offset = 0; offset < HISTORY_LIMIT;
           offset += HISTORY_PAGE_SIZE) {
        const page = await fetchBookmarkPage(userId, offset);
        if (!page.length) { exhausted = true; break; }

        for (const work of page) {
          if (seen.has(work.id)) continue;
          seen.add(work.id);
          incoming.push(work);
          if (oldIds.has(work.id)) overlap = true;
        }

        if (page.length < HISTORY_PAGE_SIZE) {
          exhausted = true; break;
        }
        if (previous.length && overlap) break;
      }

      const freshIds = new Set(incoming.map(w => w.id));
      const merged = previous.length && overlap && !exhausted
        ? [...incoming, ...previous.filter(w => !freshIds.has(w.id))]
        : incoming;

      if (!(incoming.length >= HISTORY_LIMIT ||
            exhausted || (previous.length > 0 && overlap))) {
        throw new Error('履歴取得が未完了');
      }

      bookmarkHistory = {
        userId,
        works: merged.slice(0, HISTORY_LIMIT),
        initialized: true,
        updatedAt: Date.now(),
        dateMigrationChecked: true
      };

      applyBookmarkHistory();
      saveProfile();
      console.info('[PTS] 履歴学習完了',
        bookmarkHistory.works.length);
    })().catch(e =>
      console.warn('[PTS] 履歴学習失敗', e)
    ).finally(() => { historyInitPromise = null; });

    return historyInitPromise;
  }

  // 数値を返す完成版。タグ×3、作者×9、うごイラ、R-18を評価。
  function tasteScore(it) {
    const tags = normTags(it.tags);
    let tagScore = 0;

    for (const tag of tags) {
      const count = Math.max(0,
        (Number(historyProfile.tags[tag]) || 0) +
        (Number(profile.tags[tag]) || 0) * 1.5
      );

      tagScore += Math.log1p(count);
    }

    let score = Math.min(30, tagScore * 3);

    const authorId =
      it.userId == null ? '' : String(it.userId);

    if (authorId) {
      const count = Math.max(0,
        (Number(historyProfile.authors[authorId]) || 0) +
        (Number(profile.authors[authorId]) || 0) * 1.5
      );

      score += Math.min(27, Math.log1p(count) * 9);
    }

    if (Number(it.illustType) === 2 &&
        historyProfile.ugoira + profile.ugoira > 0) {
      score += 4;
    }

    if (tags.includes('R-18')) score += 3;

    const negTags = tags.reduce(
      (sum, t) =>
        sum + (Number(skipProfile.tags[t]) || 0) * 0.5,
      0
    );

    const negAuthor =
      (Number(skipProfile.authors[authorId]) || 0) * 2;

    const penalty = Math.min(
      8,
      score * 0.30,
      negTags + negAuthor
    );

    return Number.isFinite(score)
      ? Math.max(0, score - penalty)
      : 0;
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
    return items.map(it => {
      const s = newSlide(
        it.id,
        it.url || '',
        it.title || '',
        it.userName || ''
      );

      s.tags = normTags(it.tags);
      s.userId = it.userId == null
        ? null : String(it.userId);

      if (Number.isFinite(Number(it.illustType))) {
        s.rawType = Number(it.illustType);
      }

      s.bookmarked = false;
      s.customSources = Array.isArray(it._customSources)
        ? it._customSources.slice()
        : [];
      s.createDate = it.createDate || null;

      return s;
    });
  }

  /* ---------- 自前フィード v1（ChatGPT実装） ---------- */

  const CUSTOM_TARGET = 80;
  const CUSTOM_MAX_REQUESTS = 8;
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
    const merged = new Map();
    let order = 0;
    for (const result of results) {
      const perSource = new Set();
      for (const raw of (Array.isArray(result.items) ? result.items : [])) {
        const id = candidateId(raw);
        if (!/^\d+$/.test(id)) continue;
        let it = merged.get(id);
        if (!it) {
          it = { ...raw, id, url: raw.url || raw.urls?.regular || raw.urls?.small ||
            raw.urls?.original || '', _customVotes: 0, _customDiscovery: false,
            _customSources: [], _customOrder: order++ };
          merged.set(id, it);
        } else {
          for (const key of ['tags','userId','illustType','pageCount','url','title','userName']) {
            const old = it[key], newer = raw[key];
            if ((old == null || old === '' || (Array.isArray(old) && !old.length)) &&
                newer != null) it[key] = newer;
          }
          if (!it.bookmarkData && raw.bookmarkData) it.bookmarkData = raw.bookmarkData;
        }
        if (perSource.has(id)) continue;
        perSource.add(id);
        if (!it._customSources.includes(result.type)) it._customSources.push(result.type);
        if (result.type === 'seed') it._customVotes++;
        if (result.type === 'discovery') it._customDiscovery = true;
      }
    }
    return [...merged.values()];
  }

  function customBaseScore(it) {
    const sources = Array.isArray(it._customSources) ? it._customSources : [];
    return tasteScore(it) + (Number(it._customVotes) || 0) * CUSTOM_VOTE_BONUS +
      (sources.includes('discovery') ? 2 : 0) +
      (sources.includes('tag') ? 5 : 0) +
      (sources.includes('follow') ? 4 : 0) +
      (sources.includes('author') ? 3 : 0) +
      (Number(it.illustType) === 2 ? 5 : 0);
  }

  // 最終順位を1件ずつ決め、作者の連続だけを緩く抑える
  function customArrangeBatch(items) {
    const ranked = customDiversify(items).filter(it =>
      !skipStrong(it.id) &&
      !isSeen(it.id) &&
      !knownBookmarkedIds.has(String(it.id))
    );

    const total = Math.min(CUSTOM_TARGET, ranked.length);

    const topAuthors = new Set(
      Object.entries(historyProfile.authors)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 12)
        .map(([id]) => String(id))
    );

    const now = Date.now();

    const recentFavorite = it => {
      if (customBatchNumber !== 0 ||
          !it._customSources?.includes('follow') ||
          !topAuthors.has(String(it.userId || ''))) {
        return false;
      }

      const ts = Date.parse(it.createDate || '');
      return Number.isFinite(ts) &&
        ts <= now && now - ts <= 14 * 86400000;
    };

    const fav = ranked.filter(recentFavorite).slice(0, 3);
    const favIds = new Set(fav.map(it => it.id));
    const rest = ranked.filter(it => !favIds.has(it.id));

    const tastes = rest.map(tasteScore).sort((a, b) => a - b);
    const median = tastes[Math.floor(tastes.length / 2)] ?? 0;

    const eligible = it =>
      it._customSources?.some(x =>
        x === 'discovery' || x === 'tag'
      ) &&
      !topAuthors.has(String(it.userId || '')) &&
      tasteScore(it) <= median &&
      !skipStrong(it.id);

    const explorers = rest.filter(eligible)
      .slice(0, Math.floor(total / 5));

    const explorerIds = new Set(explorers.map(it => it.id));
    const ordinary = rest.filter(it => !explorerIds.has(it.id));

    const output = [], used = new Set();

    for (let i = 0; i < total; i++) {
      let it = i < fav.length ? fav[i] : null;

      if (!it && i % 5 === 4) it = explorers.shift();
      if (!it) it = ordinary.shift() || explorers.shift();
      if (!it || used.has(it.id)) break;

      used.add(it.id);
      output.push(it);
    }

    return output;
  }

  function reorderUnviewedAfterLike(liked) {
    if (mode !== 'custom' ||
        !slides.includes(liked) || !feedEl) return;

    const idx = currentIndex();
    if (slides[idx] !== liked) return;

    const tagSet = new Set(normTags(liked.tags));
    const slots = [];

    for (let i = idx + 1; i < slides.length; i++) {
      if (!viewedThisSession.has(String(slides[i].id))) {
        slots.push(i);
      }
    }

    if (!slots.length) return;

    const candidates = slots.map(i => slides[i]);

    const score = s => {
      const matches = normTags(s.tags)
        .filter(t => tagSet.has(t)).length;

      const sameAuthor = liked.userId && s.userId &&
        String(liked.userId) === String(s.userId);

      return tasteScore(s) +
        Math.min(20, matches * 5) +
        (sameAuthor ? 16 : 0);
    };

    candidates.sort((a, b) => score(b) - score(a));
    slots.forEach((i, n) => {
      slides[i] = candidates[n];
    });

    const top = feedEl.scrollTop;
    let next = null;

    for (let i = slides.length - 1; i > idx; i--) {
      const el = slides[i].sectionEl;
      if (el && el.nextElementSibling !== next) {
        feedEl.insertBefore(el, next);
      }
      next = el;
    }

    feedEl.scrollTop = top;
  }

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
    const jobs = [];
    const seeds = customPickSeeds();

    if (!first && customNextIds.length) {
      const ids = customNextIds.slice(0, 60);
      jobs.push({
        type: 'next', ids,
        run: () => fetchJson(
          '/ajax/illust/recommend/illusts?illustIds=' +
          encodeURIComponent(ids.join(',')) + '&lang=ja'
        )
      });
    }

    for (const id of seeds) {
      jobs.push({
        type: 'seed',
        run: () => fetchJson(
          `/ajax/illust/${encodeURIComponent(id)}/recommend/init?limit=60&lang=ja`
        )
      });
    }

    jobs.push({
      type: 'discovery',
      run: () => fetchJson(
        '/ajax/discovery/artworks?mode=all&limit=60'
      )
    });

    const tags = Object.entries(historyProfile.tags)
      .map(([k, v]) => [
        k, Number(v || 0) + Number(profile.tags[k] || 0) * 1.5
      ])
      .filter(([k, v]) => k && Number.isFinite(v) && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k]) => k);

    if (!tags.length) tags.push('R-18');

    const tag = tags[customTagOffset++ % tags.length];

    jobs.push({
      type: 'tag',
      run: () => fetchJson(
        '/ajax/search/artworks/' + encodeURIComponent(tag) +
        '?' + new URLSearchParams({
          word: tag, order: 'popular_d',
          mode: 'all', s_mode: 's_tag', p: '1'
        })
      )
    });

    if (!customFollowFinished) {
      const page = customFollowPage;
      jobs.push({
        type: 'follow', page,
        run: () => fetchJson(
          `/ajax/follow_latest/illust?mode=all&p=${page}`
        )
      });
    }

    const authors = Object.entries(historyProfile.authors)
      .filter(([k, v]) => /^\d+$/.test(k) && Number(v) > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    if (authors.length) {
      const authorId =
        authors[customAuthorOffset++ % authors.length][0];

      jobs.push({
        type: 'author',
        run: () => fetchJson(
          `/ajax/user/${encodeURIComponent(authorId)}/illusts?limit=30&tag=&lang=ja`
        )
      });
    }

    const chosen = jobs.slice(0, CUSTOM_MAX_REQUESTS);

    const settled = await mapLimited(chosen, 3, async job => {
      try {
        return { ok: true, body: await job.run() };
      } catch (e) {
        return { ok: false, error: e };
      }
    });

    const results = [], nextIds = [];
    let successful = 0;

    settled.forEach((r, i) => {
      const job = chosen[i];

      if (!r?.ok) {
        if (job.type !== 'author') {
          console.warn('[PTS custom]', job.type, r?.error);
        }
        return;
      }

      const body = r.body || {};
      let items = customCandidateArray(body);

      if (job.type === 'author') {
        items = items.filter(x =>
          x && typeof x.url === 'string' && x.url.length > 0
        );
      }

      if (job.type === 'author' && !items.length) return;

      successful++;
      results.push({ type: job.type, items });

      if (Array.isArray(body.nextIds)) {
        nextIds.push(...body.nextIds);
      }

      if (job.type === 'follow') {
        if (items.length) customFollowPage = job.page + 1;
        else customFollowFinished = true;
      }

      if (job.type === 'next') {
        const consumed = new Set(job.ids);
        customNextIds = customNextIds.filter(
          x => !consumed.has(x)
        );
        customQueuedIds = new Set(customNextIds);
      }
    });

    if (!successful) {
      throw new Error('全候補ソースの取得に失敗');
    }

    customMergeNextIds(nextIds);

    const prepared = await prepareCandidates(
      customCollect(results),
      {
        excludeIds: [...customSeenIds, ...seenTimes.keys()],
        enrichTop: 0,
        rank: customBaseScore
      }
    );

    return customArrangeBatch(prepared);
  }

  function customResetState() {
    customBusy = false;
    customSeedOffset = 0;
    customNextIds = [];
    customQueuedIds = new Set();
    customExhausted = false;
    customBatchNumber = 0;
    customTagOffset = 0;
    customFollowPage = 1;
    customFollowFinished = false;
    customAuthorOffset = 0;
  }

  async function startCustomFeed() {
    if (!overlay || !feedEl) return;

    feedGeneration++;
    const generation = feedGeneration;

    slides.forEach(cleanupSlide);
    slides = [];

    feedEl.replaceChildren();
    feedEl.scrollTop = 0;

    mode = 'custom';
    activeView = null;

    customResetState();
    customSeenIds = new Set();
    customBusy = true;
    updateCounter();

    try {
      const items = await customFetchBatch();

      if (
        generation !== feedGeneration ||
        mode !== 'custom' ||
        overlay.style.display === 'none'
      ) return;

      if (!items.length) {
        throw new Error('表示できる候補がありません');
      }

      addItems(candidatesToSlides(items));

      for (const item of items) {
        customSeenIds.add(String(item.id));
      }

      customBatchNumber++;

      if (slides[0]) {
        void resolveSlide(slides[0]);
      }

      markCurrentFromScroll();

    } catch (e) {
      if (generation === feedGeneration) {
        console.warn('[PTS custom]', e);

        const c = overlay.querySelector('.pts-counter');
        if (c) {
          c.textContent =
            '自前フィード失敗: ' + (e?.message || e);
        }
      }

    } finally {
      if (generation === feedGeneration) {
        customBusy = false;
      }
    }
  }

  async function customLoadMore() {
    if (mode !== 'custom' || customBusy || customExhausted ||
        !overlay || overlay.style.display === 'none') return;
    customBusy = true;
    const generation = feedGeneration;
    try {
      const items = await customFetchBatch();
      if (generation !== feedGeneration || mode !== 'custom') return;
      const existing = new Set(slides.map(s => String(s.id)));
      const selected = items.filter(it => !existing.has(String(it.id)) &&
        !customSeenIds.has(String(it.id)) && !isSeen(it.id) &&
        !knownBookmarkedIds.has(String(it.id)));
      if (selected.length) {
        addItems(candidatesToSlides(selected));
        for (const it of selected) customSeenIds.add(String(it.id));
      }
      customBatchNumber++;
      if (!selected.length && customSeedOffset >= (bookmarkHistory.works || []).length &&
          !customNextIds.length && customFollowFinished) customExhausted = true;
    } catch (e) {
      console.warn('[PTS custom] 続き取得失敗', e);
    } finally {
      if (generation === feedGeneration) customBusy = false;
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

  /* ---------- v3.11: 既読・セッション・体験制御 ---------- */
  const SEEN_KEY = 'PTS_SEEN_V1';
  const SEEN_LIFE = 90 * 86400000;
  const SEEN_MAX = 5000;
  const seenTimes = new Map();
  const sessionTrail = [];
  const POSITIVE_KEY = 'PTS_POSITIVE_V1';
  const positiveSignals = new Set();

  try {
    const saved = JSON.parse(
      readAccountStorage(POSITIVE_KEY) || '[]'
    );

    if (Array.isArray(saved)) {
      for (const key of saved.slice(-10000)) {
        if (/^\d+:(long|loop|complete)$/.test(String(key))) {
          positiveSignals.add(String(key));
        }
      }
    }
  } catch (e) {
    console.warn('[PTS] ポジティブ履歴復元失敗', e);
  }
  let sessionBackTarget = '';
  let activeView = null;
  let activeTick = null;
  let immersive = false;
  let uiHideTimer = null;
  let reloadTimes = [];
  let effectsReduced = false;
  let closeConfirmTimer = null;
  let experienceInstalled = false;
  let touchStart = null;
  let lastTap = null;
  let singleTapTimer = null;

  function loadSeenTimes() {
    if (!getMyUserId()) return;

    try {
      const raw = JSON.parse(
        readAccountStorage(SEEN_KEY) || '{}'
      );

      if (!raw || typeof raw !== 'object' ||
          Array.isArray(raw)) return;

      const now = Date.now();

      for (const [id, value] of Object.entries(raw)) {
        const time = Number(value);

        if (/^\d+$/.test(id) &&
            Number.isFinite(time) &&
            time > now - SEEN_LIFE &&
            time <= now) {
          seenTimes.set(id, time);
        }
      }

      trimSeenTimes();

    } catch (e) {
      console.warn('[PTS] 既読読み込み失敗', e);
    }
  }
  function trimSeenTimes() {
    if (seenTimes.size <= SEEN_MAX) return;
    const sorted = [...seenTimes].sort((a, b) => a[1] - b[1]);
    for (const [id] of sorted.slice(0, seenTimes.size - SEEN_MAX)) seenTimes.delete(id);
  }
  let seenSaveTimer = null;
  function saveSeenTimes() {
    clearTimeout(seenSaveTimer);
    seenSaveTimer = null;

    const key = accountStorageKey(SEEN_KEY);
    if (!key) return;

    trimSeenTimes();

    try {
      localStorage.setItem(
        key,
        JSON.stringify(Object.fromEntries(seenTimes))
      );
    } catch (e) {
      console.warn('[PTS] 既読保存失敗', e);
    }
  }
  function markSeen(id) {
    if (!/^\d+$/.test(String(id))) return;
    seenTimes.set(String(id), Date.now());
    trimSeenTimes();
    clearTimeout(seenSaveTimer);
    seenSaveTimer = setTimeout(saveSeenTimes, 1500);
  }
  function isSeen(id) { return seenTimes.has(String(id)); }
  loadSeenTimes();
  window.addEventListener('pagehide', saveSeenTimes);

  function visibleReady(s) {
    if (!s || !s.resolved) return false;
    if (s.kind === 'ugoira') return !!(s.frameUrls && s.frameUrls.length);
    const img = s.mainImg;
    return !!(img && img.complete && img.naturalWidth > 0);
  }

  function syncDock() {
    if (!overlay || !experienceInstalled) return;

    const btn = overlay.querySelector(
      '.pts-dock-immersive'
    );

    if (btn) {
      btn.textContent = immersive ? 'UI表示' : '没入';
    }
  }
  function noteSessionVisit(s) {
    if (!s || !s.id) return;
    const id = String(s.id);
    if (sessionBackTarget === id) { sessionBackTarget = ''; return; }
    if (sessionTrail.at(-1)?.id === id) return;
    sessionTrail.push({ id, title: s.title || id, thumb: s.thumb || '' });
    if (sessionTrail.length > 50) sessionTrail.shift();
  }
  function onCurrentSlideChanged(s) {
    if (!s || activeView?.slide === s) return;

    const old = activeView;

    if (
      old &&
      old.slide !== s &&
      old.mode === mode &&
      old.generation === feedGeneration &&
      slides.includes(old.slide)
    ) {
      const manual =
        navIntent.reason === 'user' &&
        performance.now() <= navIntent.until;

      if (
        manual &&
        old.readySeen &&
        old.elapsed < 2000 &&
        !old.slide.bookmarked &&
        !old.slide.likedThisSession
      ) {
        learnSkip(old.slide);
      }
    }

    viewedThisSession.add(String(s.id));

    activeView = {
      slide: s,
      mode,
      generation: feedGeneration,
      elapsed: 0,
      last: performance.now(),
      readySeen: false,
      recorded: false,
      long: false,
      loop: false,
      loopCompleted: false
    };

    syncDock();
  }
  function applyPositive(s, kind, weight) {
    if (!s) return;

    const signal = `${s.id}:${kind}`;

    if (positiveSignals.has(signal) ||
        !s.tags?.length) return;

    positiveSignals.add(signal);

    const recent = [...positiveSignals].slice(-10000);

    if (positiveSignals.size > 10000) {
      positiveSignals.clear();

      recent.forEach(key => {
        positiveSignals.add(key);
      });
    }

    const key = accountStorageKey(POSITIVE_KEY);

    if (key) {
      try {
        localStorage.setItem(
          key,
          JSON.stringify(recent)
        );
      } catch (e) {
        console.warn('[PTS] 学習履歴保存失敗', e);
      }
    }

    learnFromWork(
      s.tags,
      s.userId,
      s.rawType,
      weight
    );
  }

  function tickViewing() {
    if (
      !overlay ||
      overlay.style.display === 'none' ||
      !activeView
    ) return;

    const v = activeView;
    const now = performance.now();
    const dt = Math.max(0, Math.min(1000, now - v.last));

    v.last = now;

    const s = v.slide;

    if (
      document.hidden ||
      slides[currentIndex()] !== s ||
      !s.isCurrent ||
      !visibleReady(s)
    ) return;

    v.readySeen = true;
    v.elapsed += dt;

    if (!v.recorded && v.elapsed >= 1000) {
      v.recorded = true;
      markSeen(s.id);
      noteSessionVisit(s);
    }

    if (!v.long && v.elapsed >= 20000) {
      v.long = true;
      applyPositive(s, 'long', 0.25);
    }

    if (
      !v.loop &&
      v.loopCompleted &&
      v.elapsed >= 5000
    ) {
      v.loop = true;
      applyPositive(s, 'loop', 0.4);
    }
  }
  function onUgoiraLoop(s) {
    if (activeView?.slide === s) {
      activeView.loopCompleted = true;
    }
  }



  function showControlsTemporarily() {
    if (!overlay) return;
    overlay.classList.add('pts-controls-show');
    overlay.classList.remove('pts-top-hidden');
    clearTimeout(uiHideTimer);
    uiHideTimer = setTimeout(() => {
      if (immersive) overlay.classList.remove('pts-controls-show');
      else overlay.classList.add('pts-top-hidden');
    }, 2500);
  }
  function setImmersive(on) {
    immersive = !!on;
    overlay.classList.toggle('pts-immersive', immersive);
    overlay.classList.toggle('pts-controls-show', !immersive);
    if (immersive) {
      overlay.classList.add('pts-top-hidden');
      clearTimeout(uiHideTimer);
    } else showControlsTemporarily();
    syncDock();
  }
  const LIKE_TAP_WINDOW = 240;

  function showLikeHeart(s, x, y) {
    const section = s?.sectionEl;
    if (!section) return;

    const r = section.getBoundingClientRect();
    const heart = document.createElement('span');

    heart.className = 'pts-like-heart';
    heart.textContent = '❤️';
    heart.setAttribute('aria-hidden', 'true');

    heart.style.left =
      `${Math.max(0, Math.min(r.width, x - r.left))}px`;
    heart.style.top =
      `${Math.max(0, Math.min(r.height, y - r.top))}px`;

    section.appendChild(heart);

    heart.addEventListener(
      'animationend',
      () => heart.remove(),
      { once: true }
    );

    setTimeout(() => heart.remove(), 1200);
  }

  async function likeArtwork(s, x, y) {
    showLikeHeart(s, x, y);
    s.likedThisSession = true;

    const generation = feedGeneration;

    try {
      if (!s.resolved && (!s.tags?.length || !s.userId)) {
        await resolveSlide(s);
      }

      if (s.tags?.length ||
          s.userId ||
          Number(s.rawType) === 2) {
        learnFromWork(s.tags, s.userId, s.rawType, 3);
        s.tasteLearned = true;
      }

      if (generation === feedGeneration &&
          mode === 'custom' &&
          slides.includes(s)) {

        reorderUnviewedAfterLike(s);
        void insertSeriesAfter(s);
        void insertRecommendationsAfterBookmark(s);
      }

      // 既に保存済みならensureBookmarkedは再POSTしない。
      await ensureBookmarked(s);

    } catch (e) {
      console.warn('[PTS like]', e);
    } finally {
      syncDock();
    }
  }

  function handleImageTap(e) {
    const holder = e.target.closest?.('.pts-holder');
    if (!holder) return;

    // 既存renderSlide側のタップ送りとの二重実行防止。
    e.stopImmediatePropagation();

    if (e.isPrimary === false || !touchStart) return;

    if (
      touchStart.pointerId !== e.pointerId ||
      Math.hypot(
        e.clientX - touchStart.x,
        e.clientY - touchStart.y
      ) > 12
    ) return;

    const s = slides[currentIndex()];

    if (!s || holder.closest('.pts-slide') !== s.sectionEl) {
      return;
    }

    const now = performance.now();

    if (
      lastTap &&
      lastTap.id === String(s.id) &&
      now - lastTap.time <= LIKE_TAP_WINDOW &&
      Math.hypot(
        e.clientX - lastTap.x,
        e.clientY - lastTap.y
      ) <= 46
    ) {
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
      lastTap = null;

      void likeArtwork(s, e.clientX, e.clientY);
      return;
    }

    lastTap = {
      id: String(s.id),
      time: now,
      x: e.clientX,
      y: e.clientY
    };

    clearTimeout(singleTapTimer);

    singleTapTimer = setTimeout(() => {
      singleTapTimer = null;
      lastTap = null;

      if (
        !slides.includes(s) ||
        slides[currentIndex()] !== s ||
        overlay?.style.display === 'none'
      ) return;

      if (immersive) {
        showControlsTemporarily();
        return;
      }

      if (s.kind === 'multi') return;

      const r = holder.getBoundingClientRect();
      const step =
        (e.clientX - r.left) / Math.max(1, r.width) < .33
          ? -1 : 1;

      gotoSlide(currentIndex() + step, 'user');
    }, LIKE_TAP_WINDOW);
  }

  function bindExperienceGestures() {
    feedEl.addEventListener('pointerdown', e => {
      if (!e.target.closest?.('.pts-holder')) return;

      if (!e.isPrimary) {
        touchStart = null;
        lastTap = null;
        clearTimeout(singleTapTimer);
        singleTapTimer = null;
        return;
      }

      touchStart = {
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId
      };
    }, true);

    feedEl.addEventListener(
      'pointerup',
      handleImageTap,
      true
    );

    feedEl.addEventListener('pointercancel', () => {
      touchStart = null;
      lastTap = null;
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
    }, true);
  }


  function showSessionHistory() {
    const panel = overlay.querySelector('.pts-history-panel');
    const list = panel.querySelector('.pts-history-list');
    list.replaceChildren();
    for (const item of [...sessionTrail].reverse()) {
      const btn = document.createElement('button');
      const available = slides.some(s => String(s.id) === item.id);
      btn.textContent = `${available ? '▶' : '—'} ${item.title || item.id} (${item.id})`;
      btn.disabled = !available;
      btn.addEventListener('click', () => {
        panel.hidden = true;
        const idx = slides.findIndex(s => String(s.id) === item.id);
        if (idx >= 0) { sessionBackTarget = item.id; gotoSlide(idx); }
      });
      list.appendChild(btn);
    }
    if (!list.childElementCount) list.textContent = '閲覧履歴はまだありません';
    panel.hidden = false;
  }

  function confirmCloseViewer() {
    const btn = overlay?.querySelector('.pts-close');
    if (!btn) return;
    if (btn.dataset.confirm === '1') {
      clearTimeout(closeConfirmTimer);
      btn.dataset.confirm = '0'; closeViewer(); return;
    }
    btn.dataset.confirm = '1'; btn.textContent = '本当に閉じる？';
    clearTimeout(closeConfirmTimer);
    closeConfirmTimer = setTimeout(() => {
      btn.dataset.confirm = '0'; btn.textContent = '閉じる';
    }, 2500);
  }

  function handleExperienceAction(act, fromTools = false) {
    if (!act || !overlay) return;

    const tools = overlay.querySelector('.pts-tools');

    if (act === 'immersive') {
      setImmersive(!immersive);
      return;
    }

    if (act === 'tools') {
      if (tools) tools.hidden = !tools.hidden;
      showControlsTemporarily();
      return;
    }

    if (act === 'history') {
      showSessionHistory();
    }

    if (act === 'refresh') {
      void refreshCurrentSlide();
    }

    if (fromTools && tools) {
      tools.hidden = true;
    }

    syncDock();
  }

  function installExperienceCSS() {
    const style = document.createElement('style');

    style.textContent = `
      #pts-overlay .pts-bar{
        pointer-events:none;
        justify-content:center;
        background:linear-gradient(#0009,transparent);
        transition:opacity .2s
      }
      #pts-overlay.pts-top-hidden .pts-bar{opacity:0}

      #pts-overlay .pts-meta,
      #pts-overlay .pts-related,
      #pts-overlay .pts-bookmark,
      #pts-overlay .pts-open{display:none!important}

      #pts-overlay .pts-img{
        display:block;
        width:100%;
        height:100%;
        max-width:100%;
        max-height:100%;
        object-fit:contain!important;
        animation:none!important;
        transform:none!important
      }

      #pts-overlay .pts-dock{
        position:absolute;bottom:0;left:0;right:0;z-index:19;
        display:grid;
        grid-template-columns:repeat(2,minmax(0,1fr));
        gap:8px;
        padding:8px 8px calc(8px + env(safe-area-inset-bottom));
        background:linear-gradient(transparent,#000c 20%,#000d);
        transition:opacity .2s
      }
      #pts-overlay .pts-dock button{
        min-height:48px;border:1px solid #ffffff28;
        background:#202020a8;color:white;
        border-radius:12px;font-size:14px;
        touch-action:manipulation
      }

      #pts-overlay .pts-tools{
        position:absolute;
        bottom:calc(68px + env(safe-area-inset-bottom));
        left:8px;right:8px;z-index:21;
        background:#151515eb;border:1px solid #5558;
        border-radius:12px;padding:10px;
        display:flex;flex-wrap:wrap;gap:8px;
        max-height:55vh;overflow:auto
      }
      #pts-overlay .pts-tools[hidden],
      #pts-overlay .pts-history-panel[hidden],
      #pts-overlay .pts-search-tags[hidden]{
        display:none!important
      }
      #pts-overlay .pts-tools button{
        padding:10px;color:#fff;background:#444;
        border:0;border-radius:8px;min-height:42px
      }

      #pts-overlay .pts-history-panel{
        position:absolute;inset:0;z-index:35;
        background:#000d;display:flex;
        align-items:center;justify-content:center;
        padding:12px;box-sizing:border-box
      }
      #pts-overlay .pts-history-sheet{
        width:100%;max-width:900px;height:80dvh;
        background:#151515;color:white;
        border:1px solid #555;border-radius:12px;
        display:flex;flex-direction:column;
        padding:12px;box-sizing:border-box
      }
      #pts-overlay .pts-history-head{
        display:flex;align-items:center;
        justify-content:space-between;padding-bottom:10px
      }
      #pts-overlay .pts-history-head button{
        padding:10px;border-radius:8px;
        background:#444;color:white;border:0
      }
      #pts-overlay .pts-history-list{
        display:flex;flex-direction:column;
        gap:6px;overflow:auto;min-height:0
      }
      #pts-overlay .pts-history-list button{
        padding:11px;text-align:left;
        background:#303030;color:#fff;
        border:0;border-radius:7px
      }
      #pts-overlay .pts-history-list button:disabled{opacity:.4}

      #pts-overlay.pts-immersive:not(.pts-controls-show) .pts-dock,
      #pts-overlay.pts-immersive:not(.pts-controls-show) .pts-bar,
      #pts-overlay.pts-immersive:not(.pts-controls-show) .pts-tools,
      #pts-overlay.pts-immersive:not(.pts-controls-show) .pts-pagechip{
        opacity:0;pointer-events:none
      }
      #pts-overlay.pts-immersive:not(.pts-controls-show)
        .pts-slide.pts-current.pts-multi .pts-pagechip{
        opacity:.42;pointer-events:none;
        top:calc(10px + env(safe-area-inset-top));
        right:9px;font-size:10px;padding:2px 6px;
        background:rgba(0,0,0,.35);color:#fff
      }

      #pts-overlay .pts-seek{
        position:absolute;left:12px;right:12px;
        top:auto;bottom:calc(73px + env(safe-area-inset-bottom));
        height:32px;z-index:27;background:none;
        touch-action:none
      }
      #pts-overlay .pts-seek::before{
        content:"";position:absolute;
        left:0;right:0;top:50%;
        height:4px;transform:translateY(-50%);
        background:rgba(255,255,255,.30);border-radius:4px
      }
      #pts-overlay .pts-seek-fill{
        position:absolute;left:0;top:50%;
        height:4px;transform:translateY(-50%);
        background:#0096fa;border-radius:4px
      }
      #pts-overlay .pts-seek-knob{
        position:absolute;top:50%;left:0%;
        width:16px;height:16px;margin-left:0;
        transform:translate(-50%,-50%);
        border-radius:50%;background:#fff;
        box-shadow:0 1px 5px #0009
      }
      #pts-overlay.pts-immersive:not(.pts-controls-show) .pts-seek{
        opacity:1!important;pointer-events:auto!important
      }
      #pts-overlay .pts-ugoira-status{
        position:absolute;left:50%;top:43%;z-index:17;
        transform:translate(-50%,-50%);
        padding:10px 15px;border-radius:12px;
        background:rgba(0,0,0,.78);color:#fff;
        font-size:13px;text-align:center;
        pointer-events:none;max-width:85vw
      }
      #pts-overlay .pts-ugoira-status[hidden]{
        display:none!important
      }
      #pts-overlay .pts-ugoira-error{color:#ffd6d6}

      #pts-overlay .pts-search-tags{
        position:absolute;left:0;right:0;z-index:20;
        top:calc(39px + env(safe-area-inset-top));
        display:flex;gap:6px;padding:4px 10px;
        overflow-x:auto;scrollbar-width:none;
        background:linear-gradient(#000a,#0003);
        transition:opacity .2s
      }
      #pts-overlay .pts-search-tags::-webkit-scrollbar{
        display:none
      }
      #pts-overlay .pts-search-tags button{
        flex-shrink:0;white-space:nowrap;color:#fff;
        background:#333b;border:1px solid #ffffff30;
        border-radius:999px;padding:7px 11px;font-size:12px
      }
      #pts-overlay.pts-top-hidden .pts-search-tags,
      #pts-overlay.pts-immersive:not(.pts-controls-show) .pts-search-tags{
        opacity:0;pointer-events:none
      }

      #pts-overlay .pts-slide.pts-current .pts-holder{
        animation:ptsIn .16s ease-out
      }
      @keyframes ptsIn{
        from{opacity:.83}to{opacity:1}
      }
      #pts-overlay.pts-low-effects .pts-current .pts-holder{
        animation:none!important
      }

      #pts-overlay .pts-holder{
        touch-action:pan-x pan-y
      }
      #pts-overlay .pts-like-heart{
        position:absolute;z-index:18;pointer-events:none;
        font-size:clamp(70px,20vw,120px);
        filter:drop-shadow(0 4px 16px #0009);
        animation:ptsHeart .85s ease-out forwards
      }
      @keyframes ptsHeart{
        0%{opacity:0;transform:translate(-50%,-40%) scale(.35)}
        24%{opacity:1;transform:translate(-50%,-55%) scale(1.18)}
        65%{opacity:.95;transform:translate(-50%,-65%) scale(1)}
        100%{opacity:0;transform:translate(-50%,-100%) scale(1.14)}
      }
      @media(prefers-reduced-motion:reduce){
        #pts-overlay .pts-holder{
          animation:none!important;transition:none!important
        }
        #pts-overlay .pts-like-heart{
          animation-duration:.2s
        }
      }
    `;

    document.head.appendChild(style);
  }

  function installExperienceUI() {
    if (experienceInstalled || !overlay) return;
    experienceInstalled = true;

    const dock = document.createElement('nav');
    dock.className = 'pts-dock';
    dock.setAttribute('aria-label', 'ビューア操作');

    dock.innerHTML = `
      <button type="button"
        class="pts-dock-immersive"
        data-act="immersive">没入</button>
      <button type="button"
        class="pts-dock-tools"
        data-act="tools">その他</button>
    `;

    overlay.appendChild(dock);

    const tools = document.createElement('div');
    tools.className = 'pts-tools';
    tools.hidden = true;

    const history = document.createElement('button');
    history.type = 'button';
    history.dataset.act = 'history';
    history.textContent = '履歴';
    tools.appendChild(history);

    overlay.appendChild(tools);

    // 診断・更新はイベント登録済みの要素を移動。
    for (const sel of [
      '.pts-diagnostic',
      '.pts-rescan'
    ]) {
      const el = overlay.querySelector('.pts-bar ' + sel);
      if (el) tools.appendChild(el);
    }

    const oldClose = overlay.querySelector('.pts-close');

    if (oldClose) {
      const replacement = oldClose.cloneNode(true);
      replacement.textContent = '閉じる';
      oldClose.replaceWith(replacement);
      replacement.addEventListener('click', confirmCloseViewer);
      tools.appendChild(replacement);
    }

    const openPage = document.createElement('button');
    openPage.type = 'button';
    openPage.textContent = 'pixivで開く';

    openPage.addEventListener('click', () => {
      const s = slides[currentIndex()];
      if (s) window.open(s.page, '_blank', 'noopener');
    });

    tools.appendChild(openPage);

    const panel = document.createElement('div');
    panel.className = 'pts-history-panel';
    panel.hidden = true;

    panel.innerHTML = `
      <div class="pts-history-sheet">
        <div class="pts-history-head">
          閲覧履歴（最新50件）
          <button type="button"
            class="pts-history-close">閉じる</button>
        </div>
        <div class="pts-history-list"></div>
      </div>
    `;

    overlay.appendChild(panel);

    panel.querySelector('.pts-history-close')
      .addEventListener('click', () => {
        panel.hidden = true;
      });

    dock.addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (act) handleExperienceAction(act);
    });

    tools.addEventListener('click', e => {
      const act = e.target.closest('button[data-act]')?.dataset.act;
      if (act) handleExperienceAction(act, true);
    });

    bindExperienceGestures();

    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' ||
          overlay.style.display === 'none') return;

      e.stopImmediatePropagation();
      e.preventDefault();
      confirmCloseViewer();
    }, true);

    if (!activeTick) {
      activeTick = setInterval(tickViewing, 250);
    }

    installExperienceCSS();
    syncDock();
  }

  // 候補一覧の形をソースごとに吸収。IDだけの作者profile/allは採用しない。
  function customCandidateArray(body) {
    const preferred = [body?.illustManga?.data, body?.thumbnails?.illust,
      body?.illusts, body?.works, body?.items, body?.data];
    for (const a of preferred) if (Array.isArray(a) &&
        a.some(x => x && (x.id != null || x.illustId != null))) return a;
    const q = [{o:body, d:0}];
    let traversed = 0;
    while (q.length && traversed++ < 50) {
      const {o,d} = q.shift();
      if (!o || typeof o !== 'object' || d >= 3) continue;
      for (const v of Object.values(o).slice(0,30)) {
        if (Array.isArray(v) && v.some(x => x && typeof x === 'object' &&
            (x.id != null || x.illustId != null))) return v;
        if (v && !Array.isArray(v) && typeof v === 'object') q.push({o:v,d:d+1});
      }
    }
    return [];
  }

  function getSearchPageConfig() {
    const path = location.pathname;

    const match = path.match(
      /^\/tags\/([^/]+)(?:\/(?:artworks|illustrations|manga))?\/?$/
    );

    if (!match) return null;

    let word;

    try {
      word = decodeURIComponent(match[1]);
    } catch (e) {
      return null;
    }

    word = word.trim();
    if (!word) return null;

    const params = new URLSearchParams(location.search);

    const order = ['popular_d', 'date_d'].includes(
      params.get('order')
    ) ? params.get('order') : 'popular_d';

    const searchMode = ['all', 'safe', 'r18'].includes(
      params.get('mode')
    ) ? params.get('mode') : 'all';

    const matchMode = ['s_tag', 's_tag_full'].includes(
      params.get('s_mode')
    ) ? params.get('s_mode') : 's_tag';

    const requestedPage = Number(params.get('p'));
    const page = Number.isInteger(requestedPage) &&
      requestedPage >= 1 && requestedPage <= 1000
        ? requestedPage : 1;

    return { word, order, searchMode, matchMode, page };
  }

  let searchConfig = null;
  let searchPage = 1;
  let searchBusy = false;
  let searchFinished = false;
  let searchLastFailure = 0;
  let searchTagCandidates = [];

  function findSearchTagCandidates(body, currentWord) {
    const result = [];
    const used = new Set([currentWord]);

    const add = value => {
      const tag = String(value || '').trim();

      if (!tag || used.has(tag) || tag.length > 80) return;
      used.add(tag);
      result.push(tag);
    };

    const read = items => {
      if (Array.isArray(items)) {
        for (const item of items) {
          if (typeof item === 'string') add(item);
          else if (item && typeof item === 'object') {
            add(item.tag ?? item.name ?? item.word);
          }
        }
      }
    };

    read(body?.relatedTags);
    read(body?.illustManga?.relatedTags);
    read(body?.tagSuggestions);
    read(body?.suggestTags);

    if (!result.length) {
      document.querySelectorAll(
        'a[href^="/tags/"]'
      ).forEach(a => {
        if (result.length >= 12) return;
        if (overlay?.contains(a)) return;

        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/tags\/([^/?#]+)/);
        if (!m) return;

        try {
          add(decodeURIComponent(m[1]));
        } catch (e) {}
      });
    }

    if (!result.length) {
      const values = new Map();

      for (const source of [
        historyProfile.tags,
        profile.tags
      ]) {
        for (const [tag, score] of Object.entries(source || {})) {
          const weight = Number(score);
          if (tag && Number.isFinite(weight) && weight > 0) {
            values.set(tag, (values.get(tag) || 0) + weight);
          }
        }
      }

      for (const [tag] of [...values].sort(
        (a, b) => b[1] - a[1]
      )) {
        add(tag);
        if (result.length >= 12) break;
      }
    }

    return result.slice(0, 12);
  }

  function renderSearchTagCandidates() {
    let bar = overlay?.querySelector('.pts-search-tags');
    if (!overlay) return;

    if (!bar) {
      bar = document.createElement('nav');
      bar.className = 'pts-search-tags';
      bar.setAttribute('aria-label', '検索ワード候補');
      overlay.appendChild(bar);
    }

    bar.replaceChildren();

    if (mode !== 'search' || !searchTagCandidates.length) {
      bar.hidden = true;
      return;
    }

    for (const tag of searchTagCandidates) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = `# ${tag}`;

      chip.addEventListener('click', () => {
        const url =
          '/tags/' + encodeURIComponent(tag) + '/artworks';
        window.location.assign(url);
      });

      bar.appendChild(chip);
    }

    bar.hidden = false;
    showControlsTemporarily();
  }

  async function searchLoadMore() {
    if (mode !== 'search' || !searchConfig ||
        searchBusy || searchFinished ||
        overlay?.style.display === 'none') return;

    if (Date.now() - searchLastFailure < 4000) return;

    searchBusy = true;
    const generation = feedGeneration;
    const page = searchPage;

    try {
      const params = new URLSearchParams({
        word: searchConfig.word,
        order: searchConfig.order,
        mode: searchConfig.searchMode,
        s_mode: searchConfig.matchMode,
        p: String(page)
      });

      const url =
        '/ajax/search/artworks/' +
        encodeURIComponent(searchConfig.word) +
        '?' + params.toString();

      const body = await fetchJson(url);

      if (generation !== feedGeneration ||
          mode !== 'search') return;

      const data = body?.illustManga?.data;

      if (!Array.isArray(data)) {
        throw new Error('検索APIのdataが配列ではありません');
      }

      if (page === searchConfig.page) {
        searchTagCandidates = findSearchTagCandidates(
          body, searchConfig.word
        );
        renderSearchTagCandidates();
      }

      const displayed = new Set(
        slides.map(s => String(s.id))
      );

      const selected = [];

      for (const raw of data) {
        if (!raw || typeof raw !== 'object') continue;

        const it = normalizeCandidate(raw);

        if (!/^\d+$/.test(it.id) ||
            displayed.has(it.id) ||
            isSeen(it.id) ||
            knownBookmarkedIds.has(it.id) ||
            it.bookmarked) continue;

        displayed.add(it.id);
        selected.push(it);
      }

      if (selected.length) {
        addItems(candidatesToSlides(selected));
        if (slides.length === selected.length) {
          markCurrentFromScroll();
        }
      }

      const total = Number(body?.illustManga?.total);
      const size = 36;

      searchPage = page + 1;

      if (!data.length ||
          (Number.isFinite(total) && total >= 0 &&
           page * size >= total)) {
        searchFinished = true;
      }

      if (!slides.length && searchFinished) {
        overlay.querySelector('.pts-counter').textContent =
          '表示可能な検索結果がありません';
      }

    } catch (e) {
      searchLastFailure = Date.now();
      console.warn('[PTS search]', e);

      if (!slides.length) {
        overlay.querySelector('.pts-counter').textContent =
          '検索取得失敗: ' + (e?.message || e);
      }

    } finally {
      if (generation === feedGeneration) searchBusy = false;
    }
  }

  async function startSearchFeed() {
    if (!overlay || !feedEl || !searchConfig) return;

    feedGeneration++;
    const generation = feedGeneration;

    slides.forEach(cleanupSlide);
    slides = [];

    feedEl.replaceChildren();
    feedEl.scrollTop = 0;

    mode = 'search';
    activeView = null;

    searchPage = searchConfig.page;
    searchBusy = false;
    searchFinished = false;
    searchLastFailure = 0;
    searchTagCandidates = [];

    updateCounter();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (
        generation !== feedGeneration ||
        searchFinished ||
        slides.length
      ) break;

      await searchLoadMore();

      if (searchLastFailure) break;
    }

    if (
      generation === feedGeneration &&
      slides.length
    ) {
      markCurrentFromScroll();
    }
  }
  let customTagOffset = 0;
  let customFollowPage = 1;
  let customFollowFinished = false;
  let customAuthorOffset = 0;

  /* ---------- 片手・ハンズフリー向け機能 ---------- */

  let wakeLock = null;
  let csrfToken = null;

  function gotoSlide(i, reason = 'other') {
    if (!feedEl || i < 0 || i >= slides.length) return;

    navIntent = {
      reason,
      until: performance.now() + 3000
    };

    feedEl.scrollTo({
      top: i * feedEl.clientHeight,
      behavior: 'smooth'
    });
  }

  function currentIndex() {
    if (!feedEl) return 0;
    return Math.round(feedEl.scrollTop / Math.max(1, feedEl.clientHeight));
  }

  // 自動送り：表示が落ち着いたらタイマーを張り直す。うごイラは1ループ分は最低待つ

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
  async function insertSeriesAfter(s) {
    if (!s || s.seriesInsertStarted ||
        !slides.includes(s)) return;

    s.seriesInsertStarted = true;
    const generation = feedGeneration;

    try {
      if (!s.seriesInfoChecked) {
        const body = await fetchJson(
          `/ajax/illust/${encodeURIComponent(s.id)}`
        );

        s.seriesNextId = seriesNextId(body?.seriesNavData);
        s.seriesInfoChecked = true;
      }

      const id = String(s.seriesNextId || '');

      if (!/^\d+$/.test(id) ||
          id === String(s.id) ||
          isSeen(id) ||
          knownBookmarkedIds.has(id) ||
          viewedThisSession.has(id) ||
          slides.some(x => String(x.id) === id)) return;

      const next = await fetchJson(
        `/ajax/illust/${encodeURIComponent(id)}`
      );

      if (!next ||
          next.bookmarkData ||
          !next.urls ||
          generation !== feedGeneration ||
          !slides.includes(s) ||
          slides.some(x => String(x.id) === id) ||
          isSeen(id) ||
          knownBookmarkedIds.has(id)) return;

      const item = newSlide(
        id,
        next.urls.regular || next.urls.original || '',
        next.title || '',
        next.userName || ''
      );

      item.tags = normTags(next.tags);
      item.userId = next.userId == null
        ? null : String(next.userId);
      item.rawType = Number(next.illustType);
      item.seriesParentId = String(s.id);

      const current = slides[currentIndex()];
      const oldTop = feedEl.scrollTop;
      const height = Math.max(1, feedEl.clientHeight);

      insertSlidesAfter(slides.indexOf(s), [item]);

      if (current && current !== s &&
          slides.includes(current)) {
        feedEl.scrollTop =
          slides.indexOf(current) * height + oldTop % height;
      }

      markCurrentFromScroll();

    } catch (e) {
      s.seriesInsertStarted = false;
    }
  }

  async function insertRecommendationsAfterBookmark(s) {
    if (s.recommendInsertStarted) return;

    s.recommendInsertStarted = true;
    const generation = feedGeneration;

    if (!slides.includes(s)) return;

    try {
      const body = await fetchJson(
        `/ajax/illust/${s.id}/recommend/init?limit=60&lang=ja`
      );

      let candidates = Array.isArray(body.illusts)
        ? body.illusts : [];

      if (!candidates.length &&
          Array.isArray(body.nextIds) &&
          body.nextIds.length) {
        const batch = body.nextIds.slice(0, 60).map(String);
        const more = await fetchJson(
          '/ajax/illust/recommend/illusts?illustIds=' +
          batch.join(',') + '&lang=ja'
        );
        candidates = more.illusts || [];
      }

      const ranked = await prepareCandidates(candidates, {
        excludeIds: [s.id, s.seriesNextId].filter(Boolean),
        enrichTop: 16
      });

      if (generation !== feedGeneration ||
          !feedEl || !slides.includes(s)) return;

      const seen = new Set(slides.map(x => String(x.id)));

      const selected = ranked.filter(it => {
        if (seen.has(it.id) ||
            knownBookmarkedIds.has(it.id)) return false;
        seen.add(it.id);
        return true;
      }).slice(0, 12);

      if (!selected.length) return;

      const current = slides[currentIndex()];
      const oldTop = feedEl.scrollTop;
      const height = Math.max(1, feedEl.clientHeight);

      let pos = slides.indexOf(s);

      if (slides[pos + 1]?.seriesParentId === String(s.id)) {
        pos++;
      }

      insertSlidesAfter(pos, candidatesToSlides(selected));

      if (current && current !== s &&
          slides.includes(current)) {
        feedEl.scrollTop =
          slides.indexOf(current) * height + oldTop % height;
      }

      markCurrentFromScroll();

    } catch (e) {
      s.recommendInsertStarted = false;
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

  async function refreshCurrentSlide() {
    const s = slides[currentIndex()];
    if (!s || s.refreshBusy) return;

    s.refreshBusy = true;
    const generation = feedGeneration;
    const btn = overlay?.querySelector('.pts-rescan');

    if (btn) {
      btn.disabled = true;
      btn.textContent = '更新中…';
    }

    const oldPage = s.pageIdx || 0;
    const oldFrames = [...(s.frameUrls || [])];

    try {
      if (s.resolveAbort) s.resolveAbort.abort();
      if (s.ugoiraAbort) s.ugoiraAbort.abort();

      if (s.resolvePromise) {
        await s.resolvePromise.catch(() => {});
      }

      // 中断したZIP展開の終了を短時間待つ。
      for (let i = 0; i < 20 && s.preparingUgoira; i++) {
        await new Promise(r => setTimeout(r, 50));
      }

      if (generation !== feedGeneration ||
          !slides.includes(s)) return;

      stopUgoira(s);

      if (s.loadWatch) clearTimeout(s.loadWatch);
      s.loadWatch = null;

      s.resolved = false;
      s.resolving = false;
      s.resolveError = null;
      s.ugoiraError = null;
      s.resolvePromise = null;
      s.resolveAbort = null;
      s.metaPromise = null;

      s.frameUrls = null;
      s.frames = null;
      s.pairs = null;
      s.zipUrl = null;
      s.zipSmall = null;
      s.zipFull = null;
      s.hiDone = false;
      s.animIdx = 0;
      s.loopSteps = 0;
      s.origLoading = false;
      s.forceRefetch = true;

      if (Number(s.rawType) === 2 || s.kind === 'ugoira') {
        setUgoiraStatus(s, 'loading');
      }

      await resolveSlide(s);

      if (generation !== feedGeneration ||
          !slides.includes(s)) return;

      s.forceRefetch = false;

      if (s.kind === 'multi' && s.pairs?.length) {
        const pager = s.sectionEl?.querySelector('.pts-pager');
        const idx = Math.min(oldPage, s.pairs.length - 1);

        s.pageIdx = idx;
        loadHorizontalNeighbors(s, idx);

        if (pager) {
          pager.scrollLeft = idx * pager.clientWidth;
        }

        upgradeSlide(s);
      }

      if (s.kind === 'single' && s.isCurrent) {
        const oldImg = s.mainImg;
        const url = s.pairs?.[0]?.o || s.pairs?.[0]?.r;

        if (oldImg?.isConnected && url) {
          const fresh = new Image();
          fresh.className = 'pts-img';
          fresh.decoding = 'async';
          fresh.alt = s.title || '';
          fresh.src = url;

          const replace = () => {
            if (s.isCurrent && oldImg.isConnected &&
                generation === feedGeneration) {
              oldImg.replaceWith(fresh);
              s.mainImg = fresh;
            }
          };

          if (fresh.decode) {
            fresh.decode().then(replace).catch(() => {});
          } else {
            fresh.onload = replace;
          }
        }
      }

      if (s.kind === 'ugoira' && s.isCurrent &&
          !s.frameUrls && !s.preparingUgoira) {
        void prepareUgoira(s);
      }

      armWatchdog(s);
      markCurrentFromScroll();

    } catch (e) {
      console.warn('[PTS refresh]', e);
      setUgoiraStatus(s, 'error', e?.message || String(e));

    } finally {
      s.forceRefetch = false;
      s.refreshBusy = false;

      // 旧Blobがまだ画像に使われていれば解放しない。
      setTimeout(() => {
        for (const url of oldFrames) {
          if (url?.startsWith('blob:') &&
              s.mainImg?.src !== url &&
              !s.frameUrls?.includes(url)) {
            URL.revokeObjectURL(url);
          }
        }
      }, 12000);

      if (btn) {
        btn.disabled = false;
        btn.textContent = '更新';
      }
    }
  }



  /* ---------- 背後ページの無限読み込みと連動 ---------- */


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
      let result;

      if (label === '2. 履歴学習') {
        const key = accountStorageKey(PROFILE_KEY);

        if (!key) {
          throw new Error(
            'ログインID不明（履歴学習停止中）'
          );
        }

        const raw = localStorage.getItem(key);

        if (!raw) {
          throw new Error(
            'このアカウントのプロフィール未保存'
          );
        }

        const saved = JSON.parse(raw);
        const history = saved?.history;

        if (!history ||
            !Array.isArray(history.works) ||
            String(history.userId || '') !== getMyUserId()) {
          throw new Error(
            '履歴なし、または保存アカウントが不一致'
          );
        }

        const tagged = history.works.filter(
          w => diagTagShape(w?.tags).count > 0
        ).length;

        result =
          `OK / ログイン識別=OK` +
          ` / initialized=${history.initialized === true}` +
          ` / 保存${history.works.length}件` +
          ` / tags ${tagged}/${history.works.length}`;

      } else {
        result = await work();
      }

      diagAppend(seq, `${label}: ${result}`);

    } catch (e) {
      diagAppend(
        seq,
        `${label}: NG / ${diagError(e)}`
      );
    }

    // v3.12.0で追加したシリーズ診断を維持。
    if (label === '7. カルーセル照合' &&
        seq === ptsDiag.seq) {
      await diagCheck(
        seq,
        '8. シリーズ情報',
        async () => {
          const id = String(
            slides[currentIndex()]?.id ||
            location.pathname.match(
              /^\/artworks\/(\d+)/
            )?.[1] || ''
          );

          if (!/^\d+$/.test(id)) {
            return '対象外（作品IDなし）';
          }

          const body = await diagGet(
            `/ajax/illust/${id}`,
            ptsDiag.controller?.signal
          );

          const nav = body?.seriesNavData;
          const next = seriesNextId(nav);

          return (
            `OK / seriesNavData=${
              nav && typeof nav === 'object'
                ? 'あり' : 'なし'
            } / next=${next || 'なし'}`
          );
        }
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
      `pixiv診断 v3.10.2 / ${new Date().toLocaleString('ja-JP')}`
    );

    diagAppend(
      seq,
      '通信はGETのみ。APIの返答形式は実機で確認します。'
    );

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

          // A → Bの順で試す。
          // 診断はbookmarkApiMethodを変更しない。
          const result =
            await fetchBookmarkBodyWithFallback(
              id,
              0,
              48,
              url => diagGet(
                url,
                controller.signal
              )
            );

          const body = result.body;
          bookmarkWorks = body.works;

          const first = bookmarkWorks[0];

          const tagged = bookmarkWorks.filter(
            w =>
              diagTagShape(w?.tags).count > 0
          ).length;

          const users = bookmarkWorks.filter(
            w =>
              w?.userId != null &&
              String(w.userId) !== ''
          ).length;

          const ugoira = bookmarkWorks.filter(
            w =>
              Number(w?.illustType) === 2
          ).length;

          const status = result.fallbackReason
            ? (
                ` / 第一候補NG: ` +
                diagText(result.fallbackReason)
              )
            : '';

          return (
            `OK / 方式=${result.method}` +
            ` / ${bookmarkWorks.length}件` +
            ` / tags ${tagged}/${bookmarkWorks.length}` +
            `（先頭: ${
              diagTagShape(first?.tags).shape
            }）` +
            ` / userId ${users}/${bookmarkWorks.length}` +
            ` / うごイラ ${ugoira}` +
            ` / total ${
              body.total ?? 'なし'
            }` +
            ` / 学習側方式=${
              bookmarkApiMethod || '未取得'
            }` +
            status +
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

          const history =
            saved?.history ??
            saved?.bookmarkHistory;

          if (
            !history ||
            typeof history !== 'object'
          ) {
            throw new Error(
              `historyなし（保存キー: ${
                diagKeys(saved)
              }）`
            );
          }

          if (!Array.isArray(history.works)) {
            throw new Error(
              '保存済みhistory.worksが配列でない'
            );
          }

          storedHistoryWorks = history.works;

          const tagged =
            storedHistoryWorks.filter(
              w =>
                diagTagShape(w?.tags).count > 0
            ).length;

          return (
            `OK / initialized=${
              history.initialized === true
            }` +
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
              w =>
                w &&
                (
                  w.id != null ||
                  w.illustId != null
                )
            ) ||
            storedHistoryWorks.find(
              w =>
                w &&
                (
                  w.id != null ||
                  w.illustId != null
                )
            );

          const id = String(
            first?.id ??
            first?.illustId ??
            ''
          );

          if (!/^\d+$/.test(id)) {
            throw new Error(
              'ブックマーク先頭の作品IDがない'
            );
          }

          const body = await diagGet(
            `/ajax/illust/${
              encodeURIComponent(id)
            }/recommend/init?limit=60&lang=ja`,
            controller.signal
          );

          recCache.set(id, body);

          if (!Array.isArray(body.illusts)) {
            throw new Error(
              `body.illustsなし（bodyキー: ${
                diagKeys(body)
              }）`
            );
          }

          const a = body.illusts;

          const tagged = a.filter(
            w =>
              diagTagShape(w?.tags).count > 0
          ).length;

          const users = a.filter(
            w =>
              w?.userId != null &&
              String(w.userId) !== ''
          ).length;

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
            ` / bookmarkDataキー ${
              bookmarks
            }/${a.length}` +
            ` / nextIds ${
              Array.isArray(body.nextIds)
                ? body.nextIds.length
                : '配列なし'
            }` +
            `\n   先頭キー: ${
              diagKeys(a[0])
            }`
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
            `/ajax/search/artworks/${
              encodeURIComponent(tag)
            }?` +
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
              `候補配列なし（bodyキー: ${
                diagKeys(body)
              }）`
            );
          }

          return (
            `OK / タグ「${diagText(tag)}」` +
            ` / popular_d指定（有効性未確認）` +
            ` / ${found.path} ${
              found.data.length
            }件` +
            `\n   先頭キー: ${
              diagKeys(found.data[0])
            }` +
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
              `/ajax/user/${
                encodeURIComponent(userId)
              }/profile/all`,
              controller.signal
            );

            const il = body.illusts;

            if (
              !il ||
              typeof il !== 'object'
            ) {
              throw new Error(
                `illusts形式不明（bodyキー: ${
                  diagKeys(body)
                }）`
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
                : keys.every(
                    k => /^\d+$/.test(k)
                  )
                  ? '数字IDキーのオブジェクト'
                  : 'キー形式不明のオブジェクト';

            const manga =
              body.manga &&
              typeof body.manga === 'object'
                ? (
                    Array.isArray(body.manga)
                      ? body.manga.length
                      : Object.keys(
                          body.manga
                        ).length
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
              `/ajax/user/${
                encodeURIComponent(userId)
              }/illusts` +
              '?limit=30&tag=&lang=ja',
              controller.signal
            );

            const found = diagFindArray(body);

            if (!found) {
              throw new Error(
                `候補配列なし（bodyキー: ${
                  diagKeys(body)
                }）`
              );
            }

            return (
              `OK / 代替illusts使用` +
              ` / ${found.path} ${
                found.data.length
              }件` +
              ` / 先頭キー: ${
                diagKeys(found.data[0])
              }` +
              ` / 第一候補NG: ${reason}`
            );

          } catch (e) {
            throw new Error(
              `profile/all: ${reason}` +
              ` / 代替illusts: ${
                diagError(e)
              }`
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
              `候補配列なし（bodyキー: ${
                diagKeys(body)
              }）`
            );
          }

          return (
            `OK / ${found.path} ${
              found.data.length
            }件` +
            `\n   先頭キー: ${
              diagKeys(found.data[0])
            }` +
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

          const body =
            recCache.get(id) ||
            await diagGet(
              `/ajax/illust/${
                encodeURIComponent(id)
              }/recommend/init?limit=60&lang=ja`,
              controller.signal
            );

          if (!Array.isArray(body.illusts)) {
            throw new Error(
              `illustsなし（bodyキー: ${
                diagKeys(body)
              }）`
            );
          }

          const ids = new Set(
            body.illusts.map(
              x => String(
                x?.id ??
                x?.illustId ??
                ''
              )
            )
          );

          const matched = carousel.filter(
            x => ids.has(x)
          ).length;

          return (
            `OK / カルーセル${
              carousel.length
            }件中` +
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
    if (overlay && overlay.style.display !== 'none') return;

    buildOverlay();
    installDiagnosticUI();
    installExperienceUI();
    bindSkipNavigation();

    skippedThisSession.clear();
    viewedThisSession.clear();

    navIntent = { reason: 'other', until: 0 };

    sessionTrail.length = 0;
    activeView = null;

    searchConfig = getSearchPageConfig();
    mode = searchConfig ? 'search' : 'custom';

    overlay.style.display = 'block';
    keepAwake(true);
    setImmersive(false);

    if (mode === 'search') {
      void startSearchFeed();
    } else {
      renderSearchTagCandidates();
      void startCustomFeed();
    }
  }

  function closeViewer() {
    if (!overlay) return;

    closeDiagnosticPanel();

    clearTimeout(uiHideTimer);
    clearTimeout(singleTapTimer);
    clearTimeout(closeConfirmTimer);

    overlay.querySelector('.pts-history-panel')
      ?.setAttribute('hidden', '');

    feedGeneration++;
    customResetState();
    searchBusy = false;

    slides.forEach(cleanupSlide);
    slides = [];

    if (feedEl) feedEl.replaceChildren();

    activeView = null;
    overlay.style.display = 'none';

    keepAwake(false);
    saveSeenTimes();
  }

  function buildOverlay() {
    if (overlay) return;

    setupObservers();

    overlay = document.createElement('div');
    overlay.id = 'pts-overlay';

    overlay.innerHTML = `
      <div class="pts-bar">
        <span class="pts-counter">…</span>
        <button type="button" class="pts-rescan">更新</button>
        <button type="button" class="pts-close">閉じる</button>
      </div>
      <div class="pts-feed"></div>
    `;

    feedEl = overlay.querySelector('.pts-feed');

    overlay.querySelector('.pts-close')
      .addEventListener('click', closeViewer);

    overlay.querySelector('.pts-rescan')
      .addEventListener('click', () => {
        void refreshCurrentSlide();
      });

    feedEl.addEventListener('scroll', () => {
      const remaining =
        feedEl.scrollHeight -
        feedEl.scrollTop -
        feedEl.clientHeight;

      if (remaining < feedEl.clientHeight * 2) {
        if (mode === 'custom') {
          void customLoadMore();
        } else if (mode === 'search') {
          void searchLoadMore();
        }
      }

      clearTimeout(curTimer);
      curTimer = setTimeout(markCurrentFromScroll, 130);
    }, { passive: true });

    const style = document.createElement('style');

    style.textContent = `
      #pts-overlay{
        position:fixed;inset:0;background:#000;
        z-index:99999;display:none
      }
      .pts-bar{
        position:absolute;top:0;left:0;right:0;z-index:3;
        display:flex;align-items:center;gap:8px;
        padding:10px 14px;color:#fff;
        background:linear-gradient(#000a,transparent);
        font-size:13px
      }
      .pts-counter{opacity:.9}
      .pts-rescan,.pts-close{
        background:#ffffff26;color:white;border:0;
        border-radius:9px;padding:9px 12px;font-size:12px
      }
      .pts-feed{
        height:100%;overflow-y:auto;
        scroll-snap-type:y mandatory;
        scrollbar-width:none;overscroll-behavior:contain
      }
      .pts-feed::-webkit-scrollbar{display:none}
      .pts-slide{
        position:relative;height:100%;
        scroll-snap-align:start;scroll-snap-stop:always;
        background:#000
      }
      .pts-holder{
        position:absolute;inset:0;
        display:flex;align-items:center;justify-content:center
      }
      .pts-img{
        max-width:100%;max-height:100%;object-fit:contain
      }
      .pts-pager{
        display:flex;height:100%;width:100%;
        overflow-x:auto;overflow-y:hidden;
        scroll-snap-type:x mandatory;
        scrollbar-width:none;overscroll-behavior:contain
      }
      .pts-pager::-webkit-scrollbar{display:none}
      .pts-page{
        min-width:100%;height:100%;
        scroll-snap-align:start;scroll-snap-stop:always;
        display:flex;align-items:center;justify-content:center
      }
      .pts-pagechip{
        position:absolute;top:52px;right:14px;z-index:2;
        background:#0009;color:#fff;
        font-size:12px;padding:4px 9px;border-radius:999px
      }
      .pts-seek{
        position:absolute;left:12px;right:12px;
        bottom:75px;height:32px;z-index:27;
        touch-action:none
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }

  function shouldAutoOpenPixivView() {
    if (location.hostname !== 'www.pixiv.net') {
      return false;
    }

    const path = location.pathname;

    const excludedPaths = [
      // 設定・アカウント管理
      /^\/(?:settings?|accounts?)(?:\/|$)/i,

      // 認証・API
      /^\/(?:login|logout|signup|register|auth|oauth|ajax|api)(?:\/|$)/i,

      // 投稿・アップロード・管理・編集
      /^\/(?:upload|uploads|editor|edit|create|dashboard|manage)(?:\/|$)/i,

      // メッセージ・通知
      /^\/(?:messages?|inbox|notifications?)(?:\/|$)/i,

      // 決済・有料プラン
      /^\/(?:premium|payment|payments|checkout|billing)(?:\/|$)/i,

      // ユーザー情報や小説の編集
      /^\/users\/[^/]+\/(?:edit|settings?|manage)(?:\/|$)/i,
      /^\/novel\/(?:new|edit|create|upload)(?:\/|$)/i,

      // 旧式PHPの設定・投稿ページ
      /^\/(?:setting_[^/]*|upload[^/]*|edit[^/]*|new_illust)\.php$/i,

      // 閲覧用途ではない案内ページ
      /^\/(?:error|maintenance|help|terms|privacy|policy)(?:\/|$)/i
    ];

    if (excludedPaths.some(re => re.test(path))) {
      return false;
    }

    // 旧式の作品編集・投稿画面
    if (/^\/member_illust\.php$/i.test(path)) {
      const mode = new URLSearchParams(
        location.search
      ).get('mode') || '';

      if (/^(?:edit|upload|new)$/i.test(mode)) {
        return false;
      }
    }

    return true;
  }

  function installRouteAutoStart() {
    let lastRoute =
      location.pathname + location.search;

    const openForRoute = route => {
      requestAnimationFrame(() => {
        const current =
          location.pathname + location.search;

        if (current !== route) return;
        if (!shouldAutoOpenPixivView()) return;

        if (
          !overlay ||
          overlay.style.display === 'none'
        ) {
          openViewer();
        }
      });
    };

    const checkRoute = () => {
      const current =
        location.pathname + location.search;

      // 同一URLなら何もしない。
      // 閉じたあとも自動再起動しない。
      if (current === lastRoute) return;

      lastRoute = current;

      // 新しいURLに移った場合は旧フィードを終了。
      if (
        overlay &&
        overlay.style.display !== 'none'
      ) {
        closeViewer();
      }

      // 設定・投稿画面などでは起動しない。
      if (!shouldAutoOpenPixivView()) return;

      openForRoute(current);
    };

    // 最初のページ読み込みで1回だけ起動する。
    if (shouldAutoOpenPixivView()) {
      openForRoute(lastRoute);
    }

    // 戻る・進む操作への即時対応。
    window.addEventListener('popstate', checkRoute);

    // SPAルーターによるURL変更を検知。
    // pixiv本体のhistory APIは変更しない。
    window.setInterval(checkRoute, 700);
  }

  const btn = document.createElement('button');

  btn.id = 'pts-launch';
  btn.textContent = '縦スクロール';

  btn.style.cssText = [
    'position:fixed',
    'right:16px',
    'bottom:16px',
    'z-index:99998',
    'background:#0096fa',
    'color:#fff',
    'border:0',
    'border-radius:999px',
    'padding:12px 18px',
    'font-size:14px',
    'font-weight:700',
    'cursor:pointer',
    'box-shadow:0 4px 16px #0006'
  ].join(';');

  btn.addEventListener('click', openViewer);
  document.body.appendChild(btn);

  // 閲覧ページでは自動起動。
  // SPA遷移も監視するが、同じURLでは再起動しない。
  installRouteAutoStart();
})();
