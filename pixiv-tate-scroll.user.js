// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      3.13.23
// @description  今開いているpixivのページに並んでいる作品を、元画像で1枚ずつTikTok風に縦スクロールして眺めるビューアです。複数枚は横スライド、うごイラはアニメーション再生。
// @match        https://www.pixiv.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  if (window.__ptsLoaded) {
    return;
  }
  window.__ptsLoaded = true;

  let overlay = null;
  // ユーザーが閉じた後は、ページ再読み込みまで自動起動しない。
  let routeAutoStartSuppressed = false;
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
      ugoiraPlayer:null, ugoiraCanvas:null, animSeekMs:null,
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
    if (s.contentBlocked) return Promise.resolve();
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

      if (signal?.aborted || s.contentFilterEpoch !== contentFilterEpoch || !slides.includes(s)) return;
      if (!contentMatches(body)) {
        s.rawType = contentEnum(body.illustType);
        s.xRestrict = contentEnum(body.xRestrict);
        s.contentBlocked = true;
        cleanupSlide(s);
        s.sectionEl?.replaceChildren();
        if (s.sectionEl) s.sectionEl.textContent = contentEmptyMessage();
        s.isCurrent = false;
        if (activeView?.slide === s) activeView = null;
        return;
      }

      s.createDate = body.createDate || s.createDate || null;
      s.seriesNextId = seriesNextId(body.seriesNavData);
      s.series = parseArtworkSeries(body);
      s.seriesInfoChecked = true;
      if(s.isCurrent)syncSeriesBar();
      if (!contentMatches(body) || s.contentFilterEpoch !== contentFilterEpoch || signal?.aborted) return;
      s.rawType = contentEnum(body.illustType);
      s.xRestrict = contentEnum(body.xRestrict);
      s.tags = normTags(body.tags);
      s.userId = body.userId == null
        ? null : String(body.userId);
      if (s.isCurrent) syncDock();

      s.bookmarked = s.bookmarked ||
        knownBookmarkedIds.has(String(s.id)) ||
        !!body.bookmarkData;

      if (s.bookmarked) {
        knownBookmarkedIds.add(String(s.id));

        if (!s.tasteLearned &&
            !bookmarkHistory.works.some(w =>
              String(w.id) === String(s.id))) {
          learnFromWork(s.tags, s.userId, s.rawType, LEARN_BOOKMARK_WEIGHT, false);
          s.tasteLearned = true;
        }
      }

      paintBookmarkBtn(s);
      if (s.bookmarked) syncSearchGridBookmark(s.id);
      if (s.isCurrent) syncDock();

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
    if (!contentMatches(s) || !s.resolved || !s.pairs) return;

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
        } else if (s.isCurrent && s.kind !== 'ugoira') {
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
      : '↻ うごイラ読み込み中…';
  }

  // v3.13.19: 画面表示は1枚のcanvas。時刻を基準にrAFで表示コマを決める。
  // エンコードされたフレームURLは維持し、デコード済み画像のみ最大4枚に制限。
  const UGOIRA_DECODE_AHEAD = 2;
  const UGOIRA_DECODE_LIMIT = 4;

  function ugoiraTimeline(frames) {
    const starts = [0];
    for (const frame of frames) starts.push(starts.at(-1) +
      (Number(frame?.delay) > 0 ? Number(frame.delay) : 100));
    return starts;
  }

  function ugoiraFrameAt(starts, time) {
    let low = 0, high = starts.length - 2;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (starts[mid] <= time) low = mid;
      else high = mid - 1;
    }
    return Math.max(0, low);
  }

  function ensureUgoiraCanvas(s) {
    const holder = s.sectionEl?.querySelector('.pts-holder');
    if (!holder) return null;
    if (s.ugoiraCanvas?.parentElement !== holder) {
      s.ugoiraCanvas?.remove();
      const canvas = document.createElement('canvas');
      canvas.className = 'pts-ugoira-canvas';
      holder.appendChild(canvas);
      s.ugoiraCanvas = canvas;
      holder.classList.remove('pts-ugoira-active');
      if (s.ugoiraPlayer) s.ugoiraPlayer.displayed = -1;
    }
    return s.ugoiraCanvas;
  }

  function clearUgoiraDecodeCache(s) {
    const player = s.ugoiraPlayer;
    if (!player) return;
    player.generation++;
    player.ready.clear();
    player.loading.clear();
    player.displayed = -1;
    player.urls = ugoiraPlayUrls(s);
  }

  function queueUgoiraFrame(s, index) {
    const player = s.ugoiraPlayer;
    const urls = ugoiraPlayUrls(s);
    if (!player || !urls?.length) return;
    const i = (index + urls.length) % urls.length;
    if (player.ready.has(i) || player.loading.has(i)) return;
    if (player.loading.size >= UGOIRA_DECODE_AHEAD + 1) return;
    const url = urls[i];
    if (!url) return;
    const img = new Image();
    img.decoding = 'async';
    const generation = player.generation;
    const task = new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('ugoira frame load failed'));
      img.src = url;
    }).then(() => img.decode ? img.decode() : undefined)
      .then(() => {
        if (s.ugoiraPlayer !== player || player.generation !== generation ||
            ugoiraPlayUrls(s) !== urls || !s.isCurrent) return;
        if (!img.naturalWidth || !img.naturalHeight) return;
        // Insertion order acts as a small decoded image LRU.
        player.ready.delete(i);
        player.ready.set(i, img);
        if (s.seekDragging && s.animIdx === i) renderUgoiraFrame(s, i);
        while (player.ready.size > UGOIRA_DECODE_LIMIT) {
          const victim = [...player.ready.keys()].find(
            key => key !== player.displayed
          );
          if (victim === undefined) break;
          player.ready.delete(victim);
        }
      }).catch(() => {
        // Decode may fail; retain the last fully painted canvas frame.
      }).finally(() => {
        if (player.generation === generation) player.loading.delete(i);
      });
    player.loading.set(i, task);
  }

  function renderUgoiraFrame(s, index) {
    const player = s.ugoiraPlayer;
    const img = player?.ready.get(index);
    const canvas = ensureUgoiraCanvas(s);
    if (!player || !img || !canvas) return false;
    const width = img.naturalWidth, height = img.naturalHeight;
    if (!width || !height) return false;
    const ctx = canvas.getContext('2d', {alpha:false});
    if (!ctx) return false;
    // Resize only if dimensions change; never clear the visible frame first.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      ctx.drawImage(img, 0, 0, width, height);
    } catch (_) {
      return false;
    }
    player.displayed = index;
    s.animIdx = index;
    s.sectionEl?.querySelector('.pts-holder')?.classList.add('pts-ugoira-active');
    return true;
  }

  function startUgoira(s) {
    if (s.animTimer != null || !s.frameUrls?.length ||
        !s.frames?.length || !s.isCurrent) return;
    if (!ensureUgoiraCanvas(s)) return;
    const timeline = ugoiraTimeline(ugoiraPlayFrames(s));
    const total = timeline.at(-1);
    if (!(total > 0)) return;
    s.animTotal = total;
    if (!s.ugoiraPlayer) s.ugoiraPlayer = {
      urls:ugoiraPlayUrls(s), ready:new Map(), loading:new Map(),
      generation:0, displayed:-1, elapsed:0, started:null,
      loops:0, timeline, total
    };
    const player=s.ugoiraPlayer;
    if (player.urls !== ugoiraPlayUrls(s)) clearUgoiraDecodeCache(s);
    player.timeline=timeline;
    player.total=total;
    player.started=null;
    player.loops=0;
    player.elapsed=Number.isFinite(s.animSeekMs)
      ? ((s.animSeekMs % total) + total) % total : 0;
    s.animSeekMs=null;
    setUgoiraStatus(s,'playing');
    void upgradeUgoiraHiRes(s);
    if (!s.hiRunning) void buildUgoiraTween(s);
    updateTweenButton(s);
    if (s.pageChip) {
      s.pageChip.style.display='block';
      s.pageChip.textContent='うごイラ再生中';
    }
    if (s.seekEl) s.seekEl.style.display='block';

    const tick = now => {
      if (!s.isCurrent || s.ugoiraPlayer !== player ||
          !s.frameUrls?.length || s.seekDragging) {
        s.animTimer=null;
        return;
      }
      if (player.urls !== ugoiraPlayUrls(s)) {
        clearUgoiraDecodeCache(s);
        player.displayed=-1;
      }
      if (player.started == null) player.started=now-player.elapsed;
      const elapsed=Math.max(0, now-player.started);
      const cycles=Math.floor(elapsed / total);
      if (cycles > player.loops) {
        // rAF background throttling must not replay thousands of callbacks.
        for (let i=0;i<Math.min(cycles-player.loops,20);i++) onUgoiraLoop(s);
        player.loops=cycles;
      }
      player.elapsed=elapsed % total;
      const index=ugoiraFrameAt(timeline,player.elapsed);
      queueUgoiraFrame(s,index);
      for(let n=1;n<=UGOIRA_DECODE_AHEAD;n++) queueUgoiraFrame(s,index+n);
      if(player.ready.has(index)&&player.displayed!==index)renderUgoiraFrame(s,index);
      const pct=timeline[index]/total*100;
      if(s.seekFill)s.seekFill.style.width=pct+'%';
      if(s.seekKnob)s.seekKnob.style.left=pct+'%';
      s.animTimer=requestAnimationFrame(tick);
    };
    s.animTimer=requestAnimationFrame(tick);
  }

  function dragUgoira(s,ratio) {
    if(!s.frameUrls?.length||!s.frames?.length)return;
    const timeline=ugoiraTimeline(ugoiraPlayFrames(s));
    const total=timeline.at(-1);
    s.animTotal=total;
    const elapsed=Math.max(0,Math.min(total-0.001,ratio*total));
    const index=ugoiraFrameAt(timeline,elapsed);
    s.animSeekMs=elapsed;
    s.animIdx=index;
    if(s.ugoiraPlayer) {
      s.ugoiraPlayer.elapsed=elapsed;
      s.ugoiraPlayer.started=null;
      queueUgoiraFrame(s,index);
      if(s.ugoiraPlayer.ready.has(index))renderUgoiraFrame(s,index);
    }
    const pct=timeline[index]/total*100;
    if(s.seekFill)s.seekFill.style.width=pct+'%';
    if(s.seekKnob)s.seekKnob.style.left=pct+'%';
  }

  function stopUgoira(s) {
    if(s.animTimer!=null){
      cancelAnimationFrame(s.animTimer);
      s.animTimer=null;
    }
    if(s.ugoiraPlayer){
      s.animSeekMs=s.animSeekMs??s.ugoiraPlayer.elapsed;
      clearUgoiraDecodeCache(s);
      s.ugoiraPlayer.started=null;
    }
  }

  // スクロールで離れたうごイラは大きなCanvas/デコード画像を解放。
  // シーク中のstopUgoiraとは分離し、ドラッグ中に表示が消えるのを防ぐ。
  function releaseUgoiraCanvas(s) {
    if (s.kind !== 'ugoira') return;
    s.ugoiraCanvas?.remove();
    s.ugoiraCanvas = null;
    s.sectionEl?.querySelector('.pts-holder')
      ?.classList.remove('pts-ugoira-active');
    s.ugoiraPlayer = null;
  }

  /* ---------- うごイラのAIコマ補間（Safari拡張機能版のみ） ---------- */

  // 拡張機能に同梱した補間エンジン(RIFE)で前後のコマから中間のコマを作り、
  // コマ数を2倍にして再生する。エンジンは拡張機能のページをiframeで開いて使う。
  // ユーザースクリプト版にはエンジンがないので、この機能は現れない。
  const UGOIRA_TWEEN_KEY = 'PTS_UGOIRA_TWEEN_V1';
  const UGOIRA_TWEEN_MAX_SIDE = 640;   // 補間計算をする解像度の上限（長辺px）
  const UGOIRA_TWEEN_MIN_DELAY = 34;   // これより短いコマ間は既に十分滑らかなので補間しない
  const UGOIRA_TWEEN_MAX_FRAMES = 240; // これより長い作品は補間しない（待ち時間とメモリ）
  const tweenEngine = {
    url: typeof globalThis.__ptsInterpEngineUrl === 'string'
      ? globalThis.__ptsInterpEngineUrl : '',
    frame: null, ready: null, seq: 0, pending: new Map(),
    backend: '', error: '', lastMs: 0, lastWork: '', made: 0, skipped: 0
  };

  function ugoiraTweenAvailable() {
    return !!tweenEngine.url;
  }

  function ugoiraTweenEnabled() {
    if (!ugoiraTweenAvailable()) return false;
    try { return localStorage.getItem(UGOIRA_TWEEN_KEY) !== 'off'; }
    catch { return true; }
  }

  function ugoiraTweenActive(s) {
    return !!(s?.tween?.done && s.tween.source === s.frameUrls &&
      ugoiraTweenEnabled());
  }

  // 再生に使うコマ一覧。補間済みなら中間コマを挟んだ一覧を返す。
  function ugoiraPlayUrls(s) {
    return ugoiraTweenActive(s) ? s.tween.playUrls : s.frameUrls;
  }

  function ugoiraPlayFrames(s) {
    return ugoiraTweenActive(s) ? s.tween.playFrames : s.frames;
  }

  function ensureTweenEngine() {
    if (tweenEngine.ready) return tweenEngine.ready;
    tweenEngine.ready = new Promise((resolve, reject) => {
      const origin = new URL(tweenEngine.url).origin;
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText =
        'position:fixed;width:1px;height:1px;left:-10px;top:-10px;' +
        'border:0;opacity:0;pointer-events:none';
      const timer = setTimeout(
        () => reject(new Error('補間エンジンが応答しません')), 20000
      );
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow ||
            event.origin !== origin) return;
        const data = event.data;
        if (data?.type === 'pts-interp-ready') {
          clearTimeout(timer);
          resolve(frame);
        } else if (data?.type === 'pts-interp-reply') {
          const done = tweenEngine.pending.get(data.id);
          tweenEngine.pending.delete(data.id);
          done?.(data);
        }
      });
      frame.src = tweenEngine.url;
      tweenEngine.frame = frame;
      document.documentElement.appendChild(frame);
    });
    return tweenEngine.ready;
  }

  async function tweenCall(message) {
    const frame = await ensureTweenEngine();
    const origin = new URL(tweenEngine.url).origin;
    const reply = await new Promise(resolve => {
      const id = ++tweenEngine.seq;
      tweenEngine.pending.set(id, resolve);
      frame.contentWindow.postMessage(
        { type: 'pts-interp', id, ...message }, origin
      );
    });
    if (!reply.ok) throw new Error(reply.error || '補間に失敗しました');
    return reply;
  }

  function dropUgoiraTween(s) {
    const tween = s?.tween;
    if (!tween) return;
    s.tween = null;
    // 表示中のコマがまだ参照していることがあるので遅らせて解放する。
    setTimeout(() => {
      for (const url of tween.urls) if (url) URL.revokeObjectURL(url);
    }, 5000);
  }

  function updateTweenButton(s) {
    const btn = s?.tweenBtn;
    if (!btn) return;
    if (!ugoiraTweenAvailable() || s.kind !== 'ugoira' ||
        !s.frameUrls?.length) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    const tween = s.tween;
    let text;
    if (!ugoiraTweenEnabled()) text = 'コマ補間 OFF';
    else if (tweenEngine.error) text = 'コマ補間 不可';
    else if (s.tweenNote) text = `コマ補間 ${s.tweenNote}`;
    else if (ugoiraTweenActive(s)) text = 'コマ補間 ON';
    else if (tween && tween.source === s.frameUrls) {
      text = `コマ補間 準備中 ${tween.next}/${tween.source.length}`;
    } else text = 'コマ補間 準備中';
    btn.textContent = text;
    btn.classList.toggle('pts-tween-on', ugoiraTweenActive(s));
  }

  // 再生中に一覧が切り替わるときは、位置を保ったまま再生し直す。
  function restartUgoiraKeepingPosition(s) {
    if (!s.isCurrent || s.seekDragging || s.animTimer == null) return;
    stopUgoira(s);
    startUgoira(s);
  }

  function toggleUgoiraTween(s) {
    const next = !ugoiraTweenEnabled();
    try { localStorage.setItem(UGOIRA_TWEEN_KEY, next ? 'on' : 'off'); }
    catch {}
    restartUgoiraKeepingPosition(s);
    if (next) void buildUgoiraTween(s);
    updateTweenButton(s);
  }

  async function buildUgoiraTween(s) {
    if (!ugoiraTweenEnabled() || tweenEngine.error) return;
    if (!s.isCurrent || s.tweenRunning || s.hiRunning) return;
    const source = s.frameUrls, frames = s.frames;
    const count = source?.length || 0;
    if (!frames?.length || frames.length !== count) return;
    if (s.tween && s.tween.source !== source) dropUgoiraTween(s);
    if (s.tween?.done) return;
    s.tweenNote = '';
    if (count < 2 || count > UGOIRA_TWEEN_MAX_FRAMES ||
        !source.every(url => url?.startsWith('blob:'))) {
      s.tweenNote = count > UGOIRA_TWEEN_MAX_FRAMES ? '対象外(長い)' : '対象外';
      updateTweenButton(s);
      return;
    }
    if (!s.tween) {
      s.tween = { source, urls: new Array(count).fill(null), next: 0,
        done: false, playUrls: null, playFrames: null };
    }
    const tween = s.tween;
    const valid = () => s.tween === tween && s.frameUrls === source &&
      s.isCurrent && ugoiraTweenEnabled();
    const blobs = new Map();
    const blobOf = async index => {
      if (!blobs.has(index)) {
        blobs.set(index, await (await fetch(source[index])).blob());
        for (const key of blobs.keys()) {
          if (blobs.size <= 3) break;
          if (key !== index) blobs.delete(key);
        }
      }
      return blobs.get(index);
    };
    s.tweenRunning = true;
    updateTweenButton(s);
    try {
      const init = await tweenCall({ cmd: 'init' });
      tweenEngine.backend = init.backend || '';
      while (tween.next < count && valid()) {
        const i = tween.next, j = (i + 1) % count;
        const delay = Number(frames[i]?.delay) > 0 ? Number(frames[i].delay) : 100;
        if (delay >= UGOIRA_TWEEN_MIN_DELAY) {
          const reply = await tweenCall({
            cmd: 'tween', t: 0.5, maxSide: UGOIRA_TWEEN_MAX_SIDE,
            aKey: `${s.id}:${i}`, a: await blobOf(i),
            bKey: `${s.id}:${j}`, b: await blobOf(j)
          });
          if (s.tween !== tween || s.frameUrls !== source) return;
          if (reply.blob) {
            tween.urls[i] = URL.createObjectURL(reply.blob);
            tweenEngine.lastMs = reply.ms || 0;
            tweenEngine.lastWork = reply.work || '';
            tweenEngine.backend = reply.backend || tweenEngine.backend;
            tweenEngine.made++;
          } else {
            tweenEngine.skipped++;
          }
        }
        tween.next = i + 1;
        updateTweenButton(s);
      }
      if (tween.next < count || s.tween !== tween) return;
      // 元コマの表示時間を半分ずつに分け、後半を中間コマに割り当てる。合計時間は変えない。
      const playUrls = [], playFrames = [];
      for (let i = 0; i < count; i++) {
        const delay = Number(frames[i]?.delay) > 0 ? Number(frames[i].delay) : 100;
        if (tween.urls[i]) {
          const first = Math.floor(delay / 2);
          playUrls.push(source[i], tween.urls[i]);
          playFrames.push({ delay: first }, { delay: delay - first });
        } else {
          playUrls.push(source[i]);
          playFrames.push({ delay });
        }
      }
      tween.playUrls = playUrls;
      tween.playFrames = playFrames;
      tween.done = true;
      if (!tween.urls.some(Boolean)) s.tweenNote = '対象外';
      restartUgoiraKeepingPosition(s);
    } catch (e) {
      tweenEngine.error = e?.message || String(e);
      console.warn('[PTS] コマ補間を停止:', tweenEngine.error);
    } finally {
      s.tweenRunning = false;
      updateTweenButton(s);
    }
  }

  function ugoiraTweenDiagnosticText() {
    if (!ugoiraTweenAvailable()) {
      return 'コマ補間: エンジンなし（拡張機能版でのみ有効）';
    }
    return `コマ補間: ${ugoiraTweenEnabled() ? 'ON' : 'OFF'}` +
      ` / 実行=${tweenEngine.backend || '未起動'}` +
      ` / 直近=${tweenEngine.lastMs}ms (${tweenEngine.lastWork || '-'})` +
      ` / 生成${tweenEngine.made} 見送り${tweenEngine.skipped}` +
      (tweenEngine.error ? ` / エラー=${tweenEngine.error}` : '');
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
        dropUgoiraTween(s);
        s.frameUrls = urls;
        s.hiDone = true;
        clearUgoiraDecodeCache(s);
        // 旧フレームは表示中imgがまだ参照していることがある。即解放すると画像が消えるので遅らせて解放
        if (old) setTimeout(() => {
          old.forEach((u) => { if (u && u.indexOf('blob:') === 0) URL.revokeObjectURL(u); });
        }, 5000);
      }
    } catch (e) { /* 小さいまま続行 */ }
    s.hiRunning = false;
    void buildUgoiraTween(s);
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
    if (!s || s.kind !== 'multi' || !s.isCurrent || activeView?.slide !== s) return;
    const img = s.sectionEl?.querySelectorAll('.pts-page img')[idx];
    if (img?.complete && img.naturalWidth > 0) {
      activeView.maxPage = Math.max(activeView.maxPage, idx);
      learnViewing(activeView);
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

    if (ugoiraTweenAvailable()) {
      const tweenBtn = document.createElement('button');
      tweenBtn.type = 'button';
      tweenBtn.className = 'pts-tween-btn';
      tweenBtn.hidden = true;
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick']) {
        tweenBtn.addEventListener(type, e => e.stopPropagation());
      }
      tweenBtn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        toggleUgoiraTween(s);
      });
      sec.appendChild(tweenBtn);
      s.tweenBtn = tweenBtn;
    }

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
    items = items.filter(s => contentMatches(s) && s.contentFilterEpoch === contentFilterEpoch);
    if (items.length === 0) { updateCounter(); return; }
    feedEl.querySelector('.pts-content-empty')?.remove();
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
        releaseUgoiraCanvas(s);
        if (s.resolved) upgradeSlide(s);
      }
    });

    const s = slides[idx];
    if (mode === 'search') s.searchFixed = true; // 一度表示した作品は固定
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

  const LOGIN_ID_KEY = 'PTS_LOGIN_USER_ID';
  const loginIdDetection = { source: '', saved: false, saveError: false };

  async function detectLoggedInPixivId() {
    const valid = value => {
      const id = String(value ?? '');
      return /^[1-9]\d*$/.test(id) ? id : '';
    };
    const parse = text => {
      try { return JSON.parse(text || 'null'); }
      catch (e) { return null; }
    };
    let saved = '';
    try { saved = valid(localStorage.getItem(LOGIN_ID_KEY)); }
    catch (e) { /* 保存不可でもページからの検出を続ける。 */ }
    loginIdDetection.saved = !!saved;

    const detect = (doc, prefix) => {
      const globalData = parse(
        doc.querySelector('meta[name="global-data"]')?.content
      );
      const next = parse(doc.getElementById('__NEXT_DATA__')?.textContent);
      const props = next?.props?.pageProps;
      const state = props?.serverSerializedPreloadedState;
      const parsedState = typeof state === 'string' ? parse(state) : state;
      const candidates = [
        ['global-data.userData.id', globalData?.userData?.id],
        ['global-data.userData.userId', globalData?.userData?.userId],
        ['__NEXT_DATA__.gaUserData', props?.gaUserData?.userId],
        ['__NEXT_DATA__.props.gaUserData', next?.props?.gaUserData?.userId],
        ['__NEXT_DATA__.gaUserData.root', next?.gaUserData?.userId],
        ['__NEXT_DATA__.userData.self.id', props?.userData?.self?.id],
        ['__NEXT_DATA__.userData.self.userId', props?.userData?.self?.userId],
        ['__NEXT_DATA__.self.id', parsedState?.userData?.self?.id],
        ['__NEXT_DATA__.self.userId', parsedState?.userData?.self?.userId]
      ];
      for (const [source, value] of candidates) {
        const id = valid(value);
        if (id) return { id, source: prefix + '.' + source };
      }

      // 一覧の作者リンクは使わず、本人のプロフィールと明示されたリンクのみ。
      for (const link of doc.querySelectorAll('a[href*="/users/"]')) {
        const labels = [link.textContent, link.getAttribute('aria-label'),
          link.getAttribute('title')];
        if (!labels.some(label => /^(?:マイページ|自分のプロフィール|プロフィールを見る|my (?:page|profile)|your profile)$/i.test((label || '').trim()))) continue;
        const url = new URL(link.getAttribute('href'), 'https://www.pixiv.net/');
        const id = url.origin === 'https://www.pixiv.net'
          ? valid(url.pathname.match(/^\/users\/(\d+)(?:\/|$)/)?.[1]) : '';
        if (id) return { id, source: prefix + '.self-profile-link' };
      }

      // 任意のuserIdは作品作者にも現れるため、ログイン情報の範囲に限定。
      const html = (doc.documentElement?.innerHTML || '')
        .replace(/&quot;/g, '"').replace(/\\"/g, '"');
      const patterns = [
        /"gaUserData"\s*:\s*\{[^{}]*?"userId"\s*:\s*"?([1-9]\d*)"?/,
        /"(?:loggedInUserId|loginUserId|currentUserId|myUserId)"\s*:\s*"?([1-9]\d*)"?/,
        /"userData"\s*:\s*\{\s*"self"\s*:\s*\{[^{}]*?"(?:id|userId)"\s*:\s*"?([1-9]\d*)"?/
      ];
      for (let i = 0; i < patterns.length; i++) {
        const id = valid(html.match(patterns[i])?.[1]);
        if (id) return { id, source: prefix + '.login-regex-' + (i + 1) };
      }
      return null;
    };

    let result = detect(document, 'page');
    if (!result) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('https://www.pixiv.net/', {
          credentials: 'include', signal: controller.signal
        });
        if (response.ok) {
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
          result = detect(doc, 'home-fetch');
        }
      } catch (e) { /* 通信失敗時も保存値にフォールバックする。 */ }
      finally { clearTimeout(timer); }
    }

    if (result) {
      loginIdDetection.source = result.source;
      try {
        localStorage.setItem(LOGIN_ID_KEY, result.id);
        loginIdDetection.saved = true;
      } catch (e) { loginIdDetection.saveError = true; }
      return result.id;
    }
    loginIdDetection.source = saved ? 'localStorage' : '識別情報なし';
    return saved;
  }

  // プロフィール読み込み・履歴初期化より先にアカウントを確定する。
  const ACTIVE_PIXIV_USER_ID = await detectLoggedInPixivId();

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

      if (!legacyProfileOwnerMatches()) return null;

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

  /* ---------- v3.13.16: 連続学習・短期意図・明示フィードバック ---------- */
  const LEARN_LIKE_WEIGHT = 3;
  const LEARN_BOOKMARK_WEIGHT = 3;
  const LEARN_OPEN_WEIGHT = 1.5;
  const LEARN_DWELL_WEIGHT = 0.6;
  const LEARN_PAGE_WEIGHT = 1;
  const LEARN_LOOP_WEIGHT = 0.4;
  const LEARN_REWATCH_WEIGHT = 1.5;
  const LEARN_REWATCH_LIMIT = 2;
  const LEARN_VIEW_BUDGET = 3;
  const LEARN_RATIO_CAP = 1.5;
  const LEARN_LOOP_CAP = 3;
  const LEARN_SINGLE_MS = 8000;
  const LEARN_PAGE_MS = 6000;
  const LEARN_MULTI_MAX_MS = 120000;
  const LEARN_ANIMATION_MIN_MS = 2000;
  const LEARN_ANIMATION_CYCLES = 2;
  const LEARN_READY_MS = 1000;
  const LEARN_TICK_MAX_MS = 250;
  const LEARN_SAVE_INTERVAL_MS = 1500;
  let viewSaveTimer = null;
  const LEARN_PROFILE_LIMIT = 2000;
  const LEARN_PROFILE_CAP = 1000;
  const LEARN_SESSION_LIMIT = 1000;
  const LEARN_SESSION_VALUE_CAP = 100;
  const LEARN_SESSION_HALF_LIFE_MS = 10 * 60 * 1000;
  const LEARN_SESSION_TAG_WEIGHT = 7;
  const LEARN_SESSION_AUTHOR_WEIGHT = 9;
  const LEARN_SESSION_SCORE_CAP = 35;
  const LEARN_EVENT_LIMIT = 40;
  const LEARN_EXPLORE_BASE = 0.2;
  const LEARN_EXPLORE_MIN = 0.1;
  const LEARN_EXPLORE_MAX = 0.4;
  const LEARN_EXPLORE_ENGAGE_GAIN = 0.15;
  const LEARN_ENGAGE_RATIO = 0.6;
  const LEARN_FRESH_WEIGHT = 8;
  const LEARN_FRESH_HALF_LIFE_MS = 7 * 86400000;
  const sessionProfile = {
    tags: {}, authors: {},
    works: new Map(), events: []
  };
  let sessionProfileOwner = '';

  function trimLearningMap(values, limit = LEARN_PROFILE_LIMIT) {
    return Object.fromEntries(Object.entries(values)
      .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, limit)
      .map(([key, value]) => [key, Math.min(LEARN_PROFILE_CAP, Number(value))]));
  }

  function addProfileWeight(values, key, weight) {
    // 上限に達していても新しい興味を受け入れ、最も弱い既存項目を置き換える。
    if (!Object.prototype.hasOwnProperty.call(values, key) &&
        Object.keys(values).length >= LEARN_PROFILE_LIMIT) {
      const weakest = Object.keys(values).reduce((a, b) =>
        Number(values[a]) <= Number(values[b]) ? a : b);
      delete values[weakest];
    }
    values[key] = Math.min(LEARN_PROFILE_CAP, (Number(values[key]) || 0) + weight);
  }

  function resetSessionLearning() {
    for (const key of ['tags', 'authors']) {
      sessionProfile[key] = {};
    }
    sessionProfile.works.clear();
    sessionProfile.events = [];
    sessionProfileOwner = getMyUserId();
  }

  function sessionLearning() {
    if (sessionProfileOwner !== getMyUserId()) resetSessionLearning();
    return sessionProfile;
  }

  function sessionValue(values, key, now = Date.now()) {
    const entry = values[key];
    return entry ? entry.value * Math.pow(0.5,
      Math.max(0, now - entry.time) / LEARN_SESSION_HALF_LIFE_MS) : 0;
  }

  function addSessionValue(values, key, amount) {
    values[key] = {value: Math.min(LEARN_SESSION_VALUE_CAP, Math.max(0, sessionValue(values, key) + amount)), time: Date.now()};
    const keys = Object.keys(values);
    if (keys.length > LEARN_SESSION_LIMIT) {
      keys.sort((a, b) => values[a].time - values[b].time)
        .slice(0, keys.length - LEARN_SESSION_LIMIT).forEach(k => delete values[k]);
    }
  }

  function learnSessionWork(tags, userId, weight) {
    const p = sessionLearning();
    for (const tag of normTags(tags)) {
      addSessionValue(p.tags, tag, weight);
    }
    if (userId) {
      addSessionValue(p.authors, String(userId), weight);
    }
  }

  function sessionWork(id) {
    const works = sessionLearning().works;
    id = String(id);
    if (!works.has(id)) {
      if (works.size >= LEARN_SESSION_LIMIT) works.delete(works.keys().next().value);
      works.set(id, {viewed: false, rewatched: 0, learned: 0, opened: false});
    }
    return works.get(id);
  }

  function customSessionScore(it) {
    const p = sessionLearning();
    const tags = normTags(it.tags);
    const positive = tags.reduce((sum, tag) => sum + Math.log1p(sessionValue(p.tags, tag)), 0) *
      LEARN_SESSION_TAG_WEIGHT + Math.log1p(sessionValue(p.authors, String(it.userId || ''))) *
      LEARN_SESSION_AUTHOR_WEIGHT;
    return Math.min(LEARN_SESSION_SCORE_CAP, positive);
  }

  function customFreshnessScore(it, now = Date.now()) {
    const time = Date.parse(it.createDate || '');
    return Number.isFinite(time) && time > 0 && time <= now
      ? LEARN_FRESH_WEIGHT * Math.pow(0.5, (now - time) / LEARN_FRESH_HALF_LIFE_MS) : 0;
  }

  function customExplorationRate() {
    const events = sessionLearning().events;
    if (!events.length) return LEARN_EXPLORE_BASE;
    const engaged = events.filter(e => e.engaged).length / events.length;
    return Math.max(LEARN_EXPLORE_MIN, Math.min(LEARN_EXPLORE_MAX,
      LEARN_EXPLORE_BASE - engaged * LEARN_EXPLORE_ENGAGE_GAIN));
  }

  async function learnOpenWork(s) {
    const generation = feedGeneration;
    const userId = getMyUserId();
    if (sessionWork(s.id).opened) return;
    try {
      if (!s.tags?.length && !s.userId) await resolveSlide(s);
      if (generation !== feedGeneration || userId !== getMyUserId() ||
          (!s.tags?.length && !s.userId) ) return;
      const record = sessionWork(s.id);
      if (record.opened) return;
      record.opened = true;
      learnFromWork(s.tags, s.userId, s.rawType, LEARN_OPEN_WEIGHT);
    } catch (e) {
      console.warn('[PTS] 開く操作の学習失敗', e);
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

    profile.tags = trimLearningMap(profile.tags);
    profile.authors = trimLearningMap(profile.authors);
    profile.ugoira = Math.min(LEARN_PROFILE_CAP, Math.max(0, Number(profile.ugoira) || 0));
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
  function learnFromWork(tags, userId, illustType, weight = 1, shortTerm = true, persist = true) {
    const w = Number(weight) || 0;
    if (w <= 0) return;
    if (shortTerm) learnSessionWork(tags, userId, w);
    for (const tag of normTags(tags)) addProfileWeight(profile.tags, tag, w);
    if (userId != null && userId !== '') {
      const id = String(userId);
      addProfileWeight(profile.authors, id, w);
    }
    if (Number(illustType) === 2) profile.ugoira += w;
    if (persist) saveProfile();
  }

  // 手動ナビゲーション識別は再閲覧学習で使用する。
  const viewedThisSession = new Set();
  let navIntent = {reason:'other',until:0};
  let navigationBound = false;
  function bindUserNavigationIntent() {
    if (navigationBound || !feedEl) return;
    navigationBound = true;
    const note = () => {navIntent={reason:'user',until:performance.now()+2500};};
    feedEl.addEventListener('touchstart', e => {
      if (e.touches.length===1) note();
    }, {passive:true,capture:true});
    feedEl.addEventListener('pointerdown', e => {
      if (e.isPrimary) note();
    }, {passive:true,capture:true});
    feedEl.addEventListener('wheel', note, {passive:true});
  }

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
        illustType: contentEnum(w.illustType),
        xRestrict: contentEnum(w.xRestrict),
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
  function tasteScore(it, breakdown = null) {
    const tags = normTags(it.tags);
    let tagScore = 0;

    for (const tag of tags) {
      const count = Math.max(0,
        (Number(historyProfile.tags[tag]) || 0) +
        (Number(profile.tags[tag]) || 0) * 1.5
      );

      tagScore += Math.log1p(count);
    }

    const tagRaw = tagScore * 3;
    let authorRaw = 0;
    let score = Math.min(30, tagRaw);

    const authorId =
      it.userId == null ? '' : String(it.userId);

    if (authorId) {
      const count = Math.max(0,
        (Number(historyProfile.authors[authorId]) || 0) +
        (Number(profile.authors[authorId]) || 0) * 1.5
      );

      authorRaw = Math.log1p(count) * 9;
      score += Math.min(27, authorRaw);
    }

    if (Number(it.illustType) === 2 &&
        historyProfile.ugoira + profile.ugoira > 0) {
      score += 4;
    }

    if (tags.includes('R-18')) score += 3;

    const total = Number.isFinite(score) ? Math.max(0, score) : 0;
    if (breakdown && typeof breakdown === 'object') Object.assign(breakdown, {
      total, tagRaw, tagCapped: Math.min(30, tagRaw),
      authorRaw, authorCapped: Math.min(27, authorRaw),
      ugoira: Number(it.illustType) === 2 &&
        historyProfile.ugoira + profile.ugoira > 0 ? 4 : 0,
      r18: tags.includes('R-18') ? 3 : 0,
      other: 0,
      tagSaturated: tagRaw > 30, authorSaturated: authorRaw > 27,
      scoreRuleVersion: '3.13.16'
    });
    return total;
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

  /* ---------- v3.13.22: 表示モードとは独立したコンテンツ条件 ---------- */
  let viewMode = 'feed'; // 将来の本棚モード用。検索/推薦(mode)とも独立。
  let contentFilter = { type: 'all', age: 'all' };
  let contentFilterEpoch = 0;
  let contentFilterConfirmed = false;
  let contentFilterDialog = null;
  const contentMetadata = new Map();
  const CONTENT_DETAIL_LIMIT = 24;

  function contentEnum(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (!/^[012]$/.test(String(value))) return null;
    return Number(value);
  }
  function contentType(it) {
    return contentEnum(it?.illustType ?? it?.rawType);
  }
  function contentKnown(it) {
    return contentType(it) !== null && contentEnum(it?.xRestrict) !== null;
  }
  function contentMatches(it, filter = contentFilter) {
    const type = contentType(it), age = contentEnum(it?.xRestrict);
    // 「すべて」でも未知の種別/区分は表示しない。
    return type !== null && age !== null &&
      (filter.type === 'all' || (filter.type === 'manga' ? type === 1 : type === 0 || type === 2)) &&
      (filter.age === 'all' || age === (filter.age === 'safe' ? 0 : 1));
  }
  function contentCouldMatch(it, filter) {
    const type = contentType(it), age = contentEnum(it?.xRestrict);
    return (type === null || filter.type === 'all' ||
      (filter.type === 'manga' ? type === 1 : type === 0 || type === 2)) &&
      (age === null || filter.age === 'all' || age === (filter.age === 'safe' ? 0 : 1));
  }
  async function filterContentCandidates(items, isCurrent = () => true) {
    const epoch = contentFilterEpoch, filter = {...contentFilter};
    const valid = () => epoch === contentFilterEpoch && isCurrent();
    let requests = 0;
    const result = await mapLimited(items, 4, async item => {
      if (!valid() || !contentCouldMatch(item, filter)) return null;
      let it = item;
      if (!contentKnown(it)) {
        const id = candidateId(it);
        if (!/^[1-9]\d*$/.test(id)) return null;
        let pending = contentMetadata.get(id);
        if (!pending) {
          if (requests++ >= CONTENT_DETAIL_LIMIT) return null;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          pending = fetchJson('/ajax/illust/' + encodeURIComponent(id), controller.signal)
            .then(body => ({illustType: contentEnum(body.illustType),
              xRestrict: contentEnum(body.xRestrict)})).catch(() => null)
            .finally(() => clearTimeout(timeout));
          contentMetadata.set(id, pending);
          if (contentMetadata.size > 500) contentMetadata.delete(contentMetadata.keys().next().value);
        }
        const metadata = await pending;
        if (!valid() || !metadata) return null;
        it = {...it, ...metadata};
      }
      return valid() && contentMatches(it, filter) ? it : null;
    });
    return valid() ? result.filter(Boolean) : [];
  }
  function contentFilterKey() {
    return 'PTS_CONTENT_FILTER_V1:' + (getMyUserId() || 'guest');
  }
  function readContentFilter() {
    try {
      const saved = JSON.parse(localStorage.getItem(contentFilterKey()) || 'null');
      contentFilter = {
        type: ['all','manga','illust'].includes(saved?.type) ? saved.type : 'all',
        age: ['all','safe','r18'].includes(saved?.age) ? saved.age : 'all'
      };
    } catch { contentFilter = {type:'all', age:'all'}; }
  }
  function contentFilterLabel() {
    return ({all:'すべて',manga:'マンガ',illust:'イラスト・うごイラ'})[contentFilter.type] +
      '・' + ({all:'すべて',safe:'全年齢',r18:'R-18'})[contentFilter.age];
  }
  function contentEmptyMessage() {
    return '現在の条件で表示できる作品がありません。取得範囲や作品情報、pixiv側の閲覧設定などにより結果が得られない場合があります。条件を変更するか、続きを取得してください。';
  }
  function showContentEmpty() {
    if (!feedEl || slides.length || contentFilterDialog?.open) return;
    let box = feedEl.querySelector('.pts-content-empty');
    if (!box) {
      box = document.createElement('div'); box.className = 'pts-content-empty';
      box.style.cssText = 'padding:100px 24px 160px;color:white;max-width:520px;margin:auto;line-height:1.8';
      const message = document.createElement('p'); message.textContent = contentEmptyMessage();
      const change = document.createElement('button'); change.textContent = '条件を変更';
      change.onclick = () => showContentFilterDialog(false);
      const more = document.createElement('button'); more.textContent = '続きを取得';
      more.onclick = async () => {
        more.disabled = true;
        try {
          if (mode === 'search') await searchLoadMore();
          else { customExhausted = false; customEmptyBatches = 0; await customLoadMore(); }
        }
        finally { more.disabled = false; }
      };
      box.append(message, change, more); feedEl.appendChild(box);
    }
  }
  function contentSourceMode(filter = contentFilter, fallback = 'all') {
    // URL側がsafeなら、ビューア選択でその制限を広げない。
    return fallback === 'safe' ? 'safe' : filter.age === 'all' ? fallback : filter.age;
  }
  function contentSourceType(filter = contentFilter) {
    return filter.type === 'manga' ? 'manga' : filter.type === 'illust' ? 'illust_and_ugoira' : 'all';
  }
  function contentDiscoveryUrl(filter = contentFilter) {
    return '/ajax/discovery/artworks?' + new URLSearchParams({
      mode: contentSourceMode(filter), type: contentSourceType(filter), limit: '60'
    });
  }
  function showContentFilterDialog(startup) {
    if (contentFilterDialog?.open) return;
    const dialog = document.createElement('dialog'); contentFilterDialog = dialog;
    dialog.id = 'pts-content-filter';
    dialog.style.cssText = 'position:fixed;top:auto;bottom:12px;width:min(92vw,480px);box-sizing:border-box;max-height:88dvh;overflow:auto;border:0;border-radius:18px;padding:20px;background:#20232b;color:white;z-index:100010';
    const title = document.createElement('h2'); title.textContent = startup ? '表示する作品を選択' : '表示条件を変更';
    const form = document.createElement('form'); form.method = 'dialog';
    for (const [name,label,options] of [
      ['type','種別',[['all','すべて'],['manga','マンガのみ'],['illust','イラスト・うごイラ']]],
      ['age','年齢',[['all','すべて'],['safe','全年齢のみ'],['r18','R-18のみ']]]
    ]) {
      const field = document.createElement('fieldset'), legend = document.createElement('legend');
      legend.textContent = label; field.appendChild(legend);
      for (const [value,text] of options) {
        const row = document.createElement('label'); row.style.cssText = 'display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer';
        const input = document.createElement('input'); input.type='radio'; input.name=name; input.value=value;
        input.checked=contentFilter[name]===value; row.append(input,document.createTextNode(text)); field.appendChild(row);
      }
      form.appendChild(field);
    }
    const note = document.createElement('p'); note.textContent = 'pixiv側の閲覧設定を尊重します。R-18Gは「R-18のみ」には含みません。';
    const reset = document.createElement('button'); reset.type='button'; reset.textContent='すべてに戻す';
    reset.onclick=()=>{for(const name of ['type','age'])form.elements[name].value='all';};
    const cancel = document.createElement('button'); cancel.type='button'; cancel.textContent='キャンセル';
    const start = document.createElement('button'); start.type='submit'; start.textContent=startup?'この条件で開始':'確定して先頭から開始';
    for(const b of [reset,cancel,start])b.style.cssText='min-height:48px;margin:6px 4px;padding:8px 12px';
    const dismiss = () => {
      dialog.close(); dialog.remove(); contentFilterDialog=null;
      if(activeView)activeView.last=performance.now();
      if(seriesUI.reading)seriesUI.reading.last=performance.now();
    };
    const cancelSelection = () => { dismiss(); if(startup)routeAutoStartSuppressed=true; };
    cancel.onclick=cancelSelection;
    dialog.addEventListener('cancel',e=>{e.preventDefault();cancelSelection();});
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const next={type:form.elements.type.value,age:form.elements.age.value};
      const changed=JSON.stringify(next)!==JSON.stringify(contentFilter);
      contentFilter=next; contentFilterConfirmed=true;
      try{localStorage.setItem(contentFilterKey(),JSON.stringify(next));}catch{}
      dismiss();
      if(startup){openViewer();return;}
      if(!changed)return;
      // 再生成は閲覧終了/スキップ学習を呼ばず、全非同期経路を失効させる。
      activeView=null; navIntent={reason:'other',until:0};
      contentFilterEpoch++; feedGeneration++;
      cancelSearchDiagnostic('filter changed'); searchRankPools.clear(); seriesCache.clear();
      const gridWord=searchGrid.open?searchGrid.config?.word:null;
      closeSearchGrid(false); gridReturnState=null;
      seriesCloseLayer(); seriesHideList(); sessionTrail.length=0;
      overlay.querySelector('.pts-history-panel')?.setAttribute('hidden','');
      syncContentFilterButton();
      if(mode==='search')void startSearchFeed(); else void startCustomFeed();
      if(gridWord)openSearchGrid(gridWord);
    });
    form.append(note,reset,cancel,start); dialog.append(title,form); document.body.appendChild(dialog); dialog.showModal();
    start.focus();
  }
  function syncContentFilterButton() {
    const button=overlay?.querySelector('.pts-content-filter');
    if(button)button.textContent=contentFilterLabel();
  }

  readContentFilter();

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
      illustType: contentType(it),
      xRestrict: contentEnum(it.xRestrict),
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
        illustType: contentEnum(body.illustType),
        xRestrict: contentEnum(body.xRestrict),
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
    const eligible = await filterContentCandidates(unique, options.isCurrent);
    const prelim = ranked(eligible);
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
    return ranked([...headOk, ...tail].filter(it => contentMatches(it)));
  }

  function candidatesToSlides(items) {
    return items.filter(it => contentMatches(it)).map(it => {
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

      s.xRestrict = contentEnum(it.xRestrict);
      s.contentFilterEpoch = contentFilterEpoch;
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
  let customEmptyBatches = 0;

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
    // 作品ページのシードは customFetchBatch で詳細を確認してから追加する。
    // 履歴から3件。次バッチでは3件ずつ先へ進める
    const works = bookmarkHistory.works || [];
    let added = 0;
    while (customSeedOffset < works.length && added < 3) {
      const work = works[customSeedOffset++];
      if (!contentMatches(work)) continue;
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
          for (const key of ['tags','userId','illustType','xRestrict','pageCount','url','title','userName']) {
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
    return tasteScore(it) + customSessionScore(it) + customFreshnessScore(it) +
      (Number(it._customVotes) || 0) * CUSTOM_VOTE_BONUS +
      (sources.includes('discovery') ? 2 : 0) +
      (sources.includes('tag') ? 5 : 0) +
      (sources.includes('follow') ? 4 : 0) +
      (sources.includes('author') ? 3 : 0) +
      (Number(it.illustType) === 2 ? 5 : 0);
  }

  // 最終順位を1件ずつ決め、作者の連続だけを緩く抑える
  function customArrangeBatch(items) {
    const ranked = customDiversify(items).filter(it =>
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
      true;

    const explorationRate = customExplorationRate();
    const explorers = rest.filter(eligible)
      .slice(0, Math.floor(total * explorationRate));

    const explorerIds = new Set(explorers.map(it => it.id));
    const ordinary = rest.filter(it => !explorerIds.has(it.id));

    const output = [], used = new Set();

    for (let i = 0; i < total; i++) {
      let it = i < fav.length ? fav[i] : null;

      if (!it && Math.floor((i + 1) * explorationRate) > Math.floor(i * explorationRate)) {
        it = explorers.shift();
      }
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

    const slots = [];

    for (let i = idx + 1; i < slides.length; i++) {
      if (slides[i].seriesParentId !== String(liked.id) &&
        !viewedThisSession.has(String(slides[i].id))) {
        slots.push(i);
      }
    }

    if (!slots.length) return;

    const candidates = slots.map(i => slides[i]);
    const sorted = diversifyBookmarkRecommendations(
      candidates, liked, [liked]
    );

    slots.forEach((i, n) => {
      slides[i] = sorted[n];
    });

    const top = feedEl.scrollTop;

    for (let i = slides.length - 1; i > idx; i--) {
      const el = slides[i].sectionEl;
      const following = slides[i + 1]?.sectionEl || null;

      if (el && el.nextElementSibling !== following) {
        feedEl.insertBefore(el, following);
      }
    }

    feedEl.scrollTop = top;
  }

  /* ---------- v3.13.9: 関連差し込みのタグ分散 ---------- */
  const INSERT_IDENTITY_CAP = 2;
  const INSERT_RECOMMENDATION_LIMIT = 12;

  const REC_GENERIC_TAGS = new Set([
    'r-18', 'r-18g', 'オリジナル', '創作',
    '一次創作', '二次創作', 'イラスト', '漫画',
    'マンガ', 'うごイラ', 'アニメ', 'ゲーム',
    '女の子', '男の子', '少女', '少年',
    '女性', '男性', '美少女', 'かわいい',
    '可愛い', '制服', '水着', '百合',
    'bl', 'nl', '背景', '風景',
    '落書き', 'らくがき', 'ファンアート', 'fanart'
  ]);

  function identityTagSet(tags) {
    const out = new Set();
    for (const tag of normTags(tags)) {
      const t = String(tag).normalize('NFKC')
        .trim().toLowerCase();
      if (t.length < 2 || REC_GENERIC_TAGS.has(t) ||
        /^[\d,]*users?入り$/.test(t)) continue;
      out.add(t);
    }
    return out;
  }

  function commonIdentityTags(a, b) {
    if (!a || !b) return 0;
    const x = identityTagSet(a.tags);
    const y = identityTagSet(b.tags);
    let count = 0;
    for (const tag of x) {
      if (y.has(tag)) count++;
    }
    return count;
  }

  function identityDiversityPenalty(
    it, source, last, second, repeated = 0
  ) {
    if (!source) return 0;

    const anchor = commonIdentityTags(it, source);
    const one = last &&
      String(last.id) !== String(source.id)
      ? commonIdentityTags(it, last) : 0;
    const two = second &&
      String(second.id) !== String(source.id)
      ? commonIdentityTags(it, second) : 0;

    return Math.min(
      18,
      Math.min(12, anchor * 5) +
      Math.min(8, one * 4) +
      Math.min(4, two * 2) +
      (anchor ? Math.min(6, repeated * 1.5) : 0)
    );
  }

  function diversifyBookmarkRecommendations(
    items, source, previous = [source], limit = Infinity
  ) {
    const pool = items.slice();
    const output = [];
    let repeated = 0;

    while (pool.length && output.length < limit) {
      const tail = [...previous, ...output];
      const last = tail.at(-1);
      const second = tail.at(-2);
      const a = String(last?.userId || '');
      const b = String(second?.userId || '');

      let best = -1;
      let bestScore = -Infinity;

      for (let i = 0; i < pool.length; i++) {
        const it = pool[i];
        if (output.length < INSERT_RECOMMENDATION_LIMIT &&
          repeated >= INSERT_IDENTITY_CAP &&
          commonIdentityTags(it, source)) continue;
        const author = String(it.userId || '');

        let score = customBaseScore(it);
        if (contentType(it) === contentType(source)) score += 12;
        if (contentEnum(it.xRestrict) === contentEnum(source?.xRestrict)) score += 12;

        if (author && author === a) score -= 12;
        if (author && author === b) score -= 5;

        score -= identityDiversityPenalty(
          it, source, last, second, repeated
        );

        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }

      if (best < 0) break;
      const chosen = pool.splice(best, 1)[0];
      output.push(chosen);

      if (commonIdentityTags(chosen, source)) repeated++;

    }

    // 差し込みは不足時も上限厳守。並べ替えは非共有候補を先に使い、
    // 12件に満たない場合も既存作品を失わないよう残りを末尾へ退避する。
    return Number.isFinite(limit) ? output : [...output, ...pool];
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
    const generation = feedGeneration, epoch = contentFilterEpoch;
    const valid = () => generation === feedGeneration && epoch === contentFilterEpoch;
    const filter = {...contentFilter};
    const first = customBatchNumber === 0;
    const jobs = [];
    const seeds = customPickSeeds();
    const pageId = first ? customPageArtworkId() : null;
    if (pageId) {
      const pageSeed = await filterContentCandidates([{id:pageId}], valid);
      if (!valid()) return [];
      if (pageSeed.length) seeds.unshift(pageId);
    }

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
        contentDiscoveryUrl(filter)
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

    if (!tags.length) tags.push(filter.age === 'safe' ? 'オリジナル' : filter.type === 'manga' ? '漫画' : 'R-18');

    const tagOffset = customTagOffset++;
    const tag = tags[tagOffset % tags.length];

    jobs.push({
      type: 'tag',
      run: () => fetchJson(
        '/ajax/search/artworks/' + encodeURIComponent(tag) +
        '?' + new URLSearchParams({
          word: tag, order: 'popular_d',
          mode: contentSourceMode(filter), type: contentSourceType(filter),
          s_mode: 's_tag', p: String(Math.min(1000, Math.floor(tagOffset / tags.length) + 1))
        })
      )
    });

    if (!customFollowFinished) {
      const page = customFollowPage;
      jobs.push({
        type: 'follow', page,
        run: () => fetchJson(
          `/ajax/follow_latest/illust?mode=${contentSourceMode(filter)}&p=${page}`
        )
      });
    }

    const authors = Object.entries(historyProfile.authors)
      .filter(([k, v]) => /^\d+$/.test(k) && Number(v) > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    // この既存作者APIはイラスト用。マンガ選択では推薦/検索プールを優先する。
    if (authors.length && filter.type !== 'manga') {
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

    if (!valid()) return [];
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
        rank: customBaseScore, isCurrent: valid
      }
    );

    return valid() ? customArrangeBatch(prepared) : [];
  }

  function customResetState() {
    customBusy = false;
    customSeedOffset = 0;
    customNextIds = [];
    customQueuedIds = new Set();
    customExhausted = false;
    customBatchNumber = 0;
    customEmptyBatches = 0;
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
      let items = [];
      for (let attempt = 0; attempt < 3 && !items.length; attempt++) {
        items = await customFetchBatch();
        if (generation !== feedGeneration) return;
        if (!items.length) customBatchNumber++;
      }

      if (
        generation !== feedGeneration ||
        mode !== 'custom' ||
        overlay.style.display === 'none'
      ) return;

      if (!items.length) {
        customExhausted = true; showContentEmpty(); return;
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
        showContentEmpty();
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
      customEmptyBatches = selected.length ? 0 : customEmptyBatches + 1;
      if (customEmptyBatches >= 3) customExhausted = true;
      if (!selected.length && customSeedOffset >= (bookmarkHistory.works || []).length &&
          !customNextIds.length && customFollowFinished) customExhausted = true;
    } catch (e) {
      console.warn('[PTS custom] 続き取得失敗', e);
    } finally {
      if (generation === feedGeneration) { customBusy = false; showContentEmpty(); }
    }
  }


  // スライド群を指定位置の直後に差し込む（ブックマーク時のおすすめ差し込み用）
  function insertSlidesAfter(posIdx, newSlides) {
    newSlides = newSlides.filter(s => contentMatches(s) && s.contentFilterEpoch === contentFilterEpoch);
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
  let sessionBackTarget = '';
  let activeView = null;
  let activeTick = null;
  let closeConfirmTimer = null;
  let experienceInstalled = false;
  let touchStart = null;
  let lastTap = null;

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
  window.addEventListener('pagehide', () => {
    tickViewing();
    saveProfile();
    saveSeenTimes();
  });

  function visibleReady(s) {
    if (!s || !contentMatches(s) || !s.resolved) return false;
    if (s.kind === 'ugoira') return !!(s.frameUrls && s.frameUrls.length);
    const img = s.mainImg;
    return !!(img && img.complete && img.naturalWidth > 0);
  }


  const SERIES_PAGE_SIZE=12, SERIES_ROW_H=70, SERIES_TTL=1800000;
  const seriesCache=new Map();
  const seriesUI={bar:null,sheet:null,list:null,rows:null,status:null,retry:null,
    label:null,activeId:null,sheetOpen:false,layerOpen:false,
    episode:null,layer:null,backdrop:null,reading:null,clock:null,
    initializing:false,requestToken:0,layerToken:0};
  let seriesActiveRequests=0;
  const seriesRequestQueue=[];
  function parseArtworkSeries(body){
    const nav=body?.seriesNavData;
    if(Number(body?.illustType)!==1||!nav||nav.seriesType!=='manga')return null;
    const id=String(nav.seriesId??''),order=Number(nav.order);
    if(!/^[1-9]\d*$/.test(id)||!Number.isFinite(order)||order<=0)return null;
    return {id,order,title:String(nav.title||'')};
  }
  function seriesCacheFor(id){
    const now=Date.now();
    for(const [key,v] of seriesCache)if(now-v.updated>SERIES_TTL)seriesCache.delete(key);
    id=String(id);
    let cache=seriesCache.get(id);
    if(!cache)cache={id,total:null,pages:new Set(),rows:new Map(),
      pending:new Map(),error:'',updated:now};
    else seriesCache.delete(id);
    cache.updated=now;
    seriesCache.set(id,cache);
    while(seriesCache.size>3)seriesCache.delete(seriesCache.keys().next().value);
    return cache;
  }
  function seriesPageForIndex(cache,index){
    return cache.total==null?1:Math.floor((cache.total-1-index)/12)+1;
  }
  async function seriesFetchPage(cache,page){
    page=Number(page);
    if(!Number.isSafeInteger(page)||page<1||
      (cache.total!=null&&page>Math.ceil(cache.total/12)))return false;
    if(cache.pages.has(page))return true;
    if(cache.pending.has(page))return cache.pending.get(page);
    const task=(async()=>{
      if(seriesActiveRequests>=2)await new Promise(r=>seriesRequestQueue.push(r));
      seriesActiveRequests++;
      try{
        const body=await fetchJson('/ajax/series/'+encodeURIComponent(cache.id)+'?p='+page);
        const total=Number(body?.page?.total),list=body?.page?.series,
          thumbs=body?.thumbnails?.illust;
        if(!Number.isSafeInteger(total)||total<1||!Array.isArray(list)||
          !Array.isArray(thumbs))throw Error('シリーズAPIの応答形式が不正です');
        if(cache.total!=null&&cache.total!==total){
          cache.pages.clear();cache.rows.clear();
        }
        cache.total=total;
        const epoch=contentFilterEpoch;
        const rows=thumbs.map((t,i)=>({...t,id:t?.id??t?.illustId??
          (thumbs.length===list.length?list[i]?.workId:null)}));
        const eligible=await filterContentCandidates(rows);
        if(epoch!==contentFilterEpoch)return false;
        const allowedIds=new Set(eligible.map(candidateId));
        const thumbMap=new Map(thumbs.map(t=>[String(t?.id??t?.illustId??''),t]));
        list.forEach((item,offset)=>{
          const id=String(item?.workId??''),order=Number(item?.order);
          const index=total-1-((page-1)*12+offset);
          if(index<0||!/^[1-9]\d*$/.test(id)||!Number.isFinite(order))return;
          const aligned=thumbs.length===list.length &&
            String(thumbs[offset]?.id??thumbs[offset]?.illustId??'')==='';
          const thumb=thumbMap.get(id)||(aligned?thumbs[offset]:null);
          cache.rows.set(index,{id,index,order,allowed:allowedIds.has(id),
            title:allowedIds.has(id)?thumb?.title||'':'表示条件に合わないか情報を確認できません',
            thumbnail:allowedIds.has(id)?thumb?.url||'':'',pageCount:Number(thumb?.pageCount)||null});
        });
        cache.pages.add(page);cache.error='';cache.updated=Date.now();
        return true;
      }catch(e){cache.error=String(e?.message||e);return false;}
      finally{
        seriesActiveRequests--;
        seriesRequestQueue.shift()?.();
        cache.pending.delete(page);
        if(seriesUI.sheetOpen&&seriesUI.activeId===cache.id)seriesRenderList();
        syncSeriesBar();
      }
    })();
    cache.pending.set(page,task);
    return task;
  }
  async function seriesFindOrder(cache,order){
    if(!cache.pages.has(1))await seriesFetchPage(cache,1);
    if(!cache.total)return null;
    const lookup=()=>[...cache.rows.values()].find(r=>r.order===order);
    const known=lookup();if(known)return known;
    const guess=Math.max(1,Math.min(Math.ceil(cache.total/12),
      Math.ceil((cache.total-order+1)/12)));
    await seriesFetchPage(cache,guess);
    return lookup()||null;
  }
  function seriesRenderList(){
    if(!seriesUI.sheetOpen||!seriesUI.activeId||!seriesUI.list)return;
    const cache=seriesCacheFor(seriesUI.activeId);
    seriesUI.status.textContent=cache.error?'取得失敗: '+cache.error:
      cache.total==null?'取得中…':
        '取得済み '+cache.rows.size+' / 全'+cache.total+'作品';
    seriesUI.retry.hidden=!cache.error;
    if(cache.total==null){seriesUI.rows.replaceChildren();return;}
    const top=seriesUI.list.scrollTop,first=Math.max(0,Math.floor(top/70)-8),
      count=Math.min(56,Math.ceil(seriesUI.list.clientHeight/70)+16),
      end=Math.min(cache.total,first+count),frag=document.createDocumentFragment();
    for(let i=first;i<end;i++){
      const item=cache.rows.get(i),button=document.createElement('button');
      button.type='button';button.className='pts-series-row';
      button.style.top=i*70+'px';
      if(!item){button.disabled=true;button.textContent='読み込み中…';}
      else{
        const img=document.createElement('img');img.alt='';img.loading='lazy';
        if(item.thumbnail)img.src=item.thumbnail;
        const label=document.createElement('span');
        label.textContent='第'+item.order+'話 '+(item.title||'タイトル未取得');
        button.append(img,label);
        const current=seriesUI.episode?.id||slides[currentIndex()]?.id;
        if(String(current)===item.id)button.classList.add('pts-series-selected');
        button.disabled=!item.allowed;
        button.addEventListener('click',()=>void seriesOpenEpisode(item));
      }
      frag.appendChild(button);
    }
    seriesUI.rows.replaceChildren(frag);
    seriesUI.rows.style.height=cache.total*70+'px';
    if(cache.error||seriesUI.initializing)return;
    const index=Math.max(0,Math.min(cache.total-1,Math.floor(
      (top+seriesUI.list.clientHeight/2)/70)));
    const page=seriesPageForIndex(cache,index);
    if(!cache.pages.has(page)&&!cache.pending.has(page)){
      void seriesFetchPage(cache,page).then(ok=>{
        if(!ok||!seriesUI.sheetOpen||seriesUI.activeId!==cache.id)return;
        const adjacent=index>cache.total/2?page+1:page-1;
        if(adjacent>=1&&adjacent<=Math.ceil(cache.total/12)&&
           !cache.pages.has(adjacent))void seriesFetchPage(cache,adjacent);
      });
    }
  }
  function syncSeriesBar(){
    if(!seriesUI.bar||!overlay)return;
    const info=slides[currentIndex()]?.series;
    const shown=!!info&&!seriesUI.layerOpen&&!searchGrid.open&&
      overlay.style.display!=='none';
    seriesUI.bar.hidden=!shown;
    if(!shown)return;
    const total=seriesCache.get(info.id)?.total;
    seriesUI.bar.textContent=(info.title||'漫画シリーズ')+' · '+
      (total==null?'第'+info.order+'話':info.order+' / '+total);
  }
  async function seriesShowList(){
    const info=seriesUI.episode?.series||slides[currentIndex()]?.series;
    if(!info||!seriesUI.sheet)return;
    seriesUI.activeId=info.id;seriesUI.sheetOpen=true;
    seriesUI.initializing=true;
    seriesUI.sheet.hidden=false;
    if(seriesUI.backdrop)seriesUI.backdrop.hidden=false;
    seriesUI.label.textContent=info.title||'漫画シリーズ';
    const token=++seriesUI.requestToken,cache=seriesCacheFor(info.id);
    seriesRenderList();
    if(!cache.pages.has(1))await seriesFetchPage(cache,1);
    if(token!==seriesUI.requestToken||!seriesUI.sheetOpen)return;
    const row=await seriesFindOrder(cache,info.order);
    if(token!==seriesUI.requestToken||!seriesUI.sheetOpen)return;
    seriesUI.initializing=false;
    if(row)seriesUI.list.scrollTop=Math.max(0,row.index*70-seriesUI.list.clientHeight/2);
    seriesRenderList();
    if(!row&&cache.total!=null)
      seriesUI.status.textContent='現在話を特定できません。スクロールして探してください。';
  }
  function seriesHideList(){
    seriesUI.sheetOpen=false;seriesUI.initializing=false;
    seriesUI.requestToken++;
    if(seriesUI.sheet)seriesUI.sheet.hidden=true;
    if(seriesUI.backdrop)seriesUI.backdrop.hidden=true;
    if(activeView)activeView.last=performance.now();
    syncSeriesBar();
  }
  function installSeriesUI(){
    if(!overlay||seriesUI.bar)return;
    const bar=document.createElement('button');
    bar.type='button';bar.className='pts-series-bar';bar.hidden=true;
    bar.addEventListener('click',()=>void seriesShowList());
    overlay.appendChild(bar);seriesUI.bar=bar;
    const backdrop=document.createElement('div');
    backdrop.className='pts-series-backdrop';backdrop.hidden=true;
    backdrop.addEventListener('click',seriesHideList);
    overlay.appendChild(backdrop);seriesUI.backdrop=backdrop;
    const panel=document.createElement('section');
    panel.className='pts-series-sheet';panel.hidden=true;
    panel.innerHTML='<header><strong class="pts-series-name"></strong>'+
      '<button type="button" class="pts-series-close">閉じる</button></header>'+
      '<div class="pts-series-scroll"><div class="pts-series-rows"></div></div>'+
      '<footer><span class="pts-series-status"></span>'+
      '<button class="pts-series-retry" type="button" hidden>再試行</button></footer>';
    overlay.appendChild(panel);seriesUI.sheet=panel;
    seriesUI.label=panel.querySelector('.pts-series-name');
    seriesUI.list=panel.querySelector('.pts-series-scroll');
    seriesUI.rows=panel.querySelector('.pts-series-rows');
    seriesUI.status=panel.querySelector('.pts-series-status');
    seriesUI.retry=panel.querySelector('.pts-series-retry');
    panel.querySelector('.pts-series-close').addEventListener('click',seriesHideList);
    seriesUI.retry.addEventListener('click',()=>{
      const c=seriesCacheFor(seriesUI.activeId);
      c.error='';
      const i=Math.floor(seriesUI.list.scrollTop/70);
      void seriesFetchPage(c,c.total==null?1:seriesPageForIndex(c,i));
    });
    let pending=false;
    seriesUI.list.addEventListener('scroll',()=>{
      if(pending)return;
      pending=true;requestAnimationFrame(()=>{pending=false;seriesRenderList();});
    },{passive:true});
    const st=document.createElement('style');
    st.textContent=[
      '#pts-overlay .pts-series-bar[hidden],#pts-overlay .pts-series-sheet[hidden],#pts-overlay .pts-series-retry[hidden],#pts-overlay .pts-series-backdrop[hidden]{display:none!important}',
      '#pts-overlay .pts-series-backdrop{position:absolute;inset:0;z-index:75;background:#0009}',
      '#pts-overlay .pts-series-bar{position:absolute;z-index:29;bottom:calc(67px + env(safe-area-inset-bottom));left:12px;right:12px;width:calc(100% - 24px);min-height:40px;padding:7px 14px;border:1px solid #ffffff40;border-radius:10px;background:#17171be8;color:#fff;text-align:left;font:13px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#pts-overlay .pts-series-sheet{position:absolute;z-index:76;bottom:0;left:0;right:0;height:73dvh;max-height:75vh;display:flex;flex-direction:column;background:#17171c;color:white;border-radius:18px 18px 0 0;border-top:1px solid #ffffff50;box-shadow:0 -18px 40px #000b}',
      '#pts-overlay .pts-series-sheet header,#pts-overlay .pts-series-sheet footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;flex-shrink:0}',
      '#pts-overlay .pts-series-sheet header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#pts-overlay .pts-series-sheet button{color:white}',
      '#pts-overlay .pts-series-close,#pts-overlay .pts-series-retry{border:1px solid #ffffff40;border-radius:9px;background:#383840;padding:9px 13px}',
      '#pts-overlay .pts-series-scroll{flex:1;overflow-y:auto;position:relative;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
      '#pts-overlay .pts-series-rows{position:relative}',
      '#pts-overlay .pts-series-row{position:absolute;left:0;right:0;height:70px;display:flex;align-items:center;gap:13px;width:100%;background:#202027;color:white;border:0;border-bottom:1px solid #ffffff18;text-align:left;padding:5px 14px;box-sizing:border-box;font:13px system-ui}',
      '#pts-overlay .pts-series-row[disabled]{opacity:.65}',
      '#pts-overlay .pts-series-row img{width:56px;height:56px;object-fit:cover;background:#333;border-radius:5px;flex:none}',
      '#pts-overlay .pts-series-row span{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}',
      '#pts-overlay .pts-series-selected{background:#34445d}',
      '#pts-overlay .pts-series-status{font-size:12px;color:#ccc}'
    ].join('\n');
    document.head.appendChild(st);
  }


  // 専用閲覧レイヤー。slides・feedEl・検索順位には一切挿入しない。
  function seriesStopReading(){
    if(seriesUI.clock){clearInterval(seriesUI.clock);seriesUI.clock=null;}
    if(seriesUI.reading){
      saveProfile();
      seriesUI.reading=null;
    }
  }
  function seriesTickReading(){
    const r=seriesUI.reading;
    if(!r)return;
    const now=performance.now();
    const dt=Math.min(250,Math.max(0,now-r.last));r.last=now;
    if(contentFilterDialog?.open||!seriesUI.layerOpen||seriesUI.sheetOpen||document.hidden||
       seriesUI.episode?.id!==r.id||!r.imageReady)return;
    r.elapsed+=dt;
    if(!r.recorded&&r.elapsed>=LEARN_READY_MS){
      r.recorded=true;
      markSeen(r.id);
      sessionWork(r.id).viewed=true;
    }
    if(r.elapsed<LEARN_READY_MS)return;
    const e=seriesUI.episode;
    const target=Math.min(LEARN_VIEW_BUDGET,viewingMetrics({
      slide:{kind:e.pairs.length>1?'multi':'single',pairs:e.pairs},
      elapsed:r.elapsed,maxPage:r.maxPage||0,played:0,loops:0
    }).score);
    const delta=Math.max(0,target-r.score);
    if(delta>0){
      r.score=target;
      learnFromWork(e.tags,e.userId,e.rawType,delta,true,false);
      if(!viewSaveTimer)viewSaveTimer=setTimeout(()=>{
        viewSaveTimer=null;saveProfile();
      },LEARN_SAVE_INTERVAL_MS);
    }
  }
  function seriesUpdateEpisodeUI(){
    const e=seriesUI.episode,root=seriesUI.layer;
    if(!root)return;
    const title=root.querySelector('.pts-series-episode-title');
    const page=root.querySelector('.pts-series-page-info');
    const prev=root.querySelector('.pts-series-prev-page');
    const next=root.querySelector('.pts-series-next-page');
    const before=root.querySelector('.pts-series-prev-episode');
    const after=root.querySelector('.pts-series-next-episode');
    const save=root.querySelector('.pts-series-save');
    title.textContent=e?(e.title||'漫画'):'読み込み中…';
    page.textContent=e?(seriesUI.pageIndex+1)+' / '+e.pairs.length:'…';
    prev.disabled=!e||seriesUI.pageIndex===0;
    next.disabled=!e||seriesUI.pageIndex>=e.pairs.length-1;
    if(e){
      const cache=seriesCacheFor(e.series.id);
      before.disabled=e.index<=0;
      after.disabled=cache.total!=null&&e.index>=cache.total-1;
      save.textContent=e.bookmarked?'✓ 保存済み':'♡ ブックマーク';
      save.disabled=!!e.bookmarked;
    }else{before.disabled=true;after.disabled=true;save.disabled=true;}
  }
  async function seriesShowPage(index){
    const e=seriesUI.episode;
    if(!e||index<0||index>=e.pairs.length||!seriesUI.layerOpen)return;
    seriesUI.pageIndex=index;
    if(seriesUI.reading){
      seriesUI.reading.imageReady=false;
      seriesUI.reading.maxPage=Math.max(seriesUI.reading.maxPage||0,index);
    }
    const imageRoot=seriesUI.layer.querySelector('.pts-series-image');
    const token=++seriesUI.layerToken;
    const url=e.pairs[index]?.o||e.pairs[index]?.r;
    if(!url)return;
    const img=new Image();
    img.decoding='async';img.alt=e.title||'';
    img.className='pts-series-artwork';
    img.src=url;
    try{
      if(img.decode)await img.decode();
      else await new Promise((resolve,reject)=>{
        img.onload=resolve;img.onerror=()=>reject(new Error('画像読み込み失敗'));
        if(img.complete&&img.naturalWidth)resolve();
      });
    }catch(err){
      if(token===seriesUI.layerToken)
        seriesUI.layer.querySelector('.pts-series-error').textContent=
          String(err?.message||err);
      return;
    }
    if(token!==seriesUI.layerToken||!seriesUI.layerOpen||
       seriesUI.episode!==e)return;
    imageRoot.replaceChildren(img);
    seriesUI.layer.querySelector('.pts-series-error').textContent='';
    if(seriesUI.reading)seriesUI.reading.imageReady=true;
    seriesUpdateEpisodeUI();
  }
  async function seriesOpenEpisode(item){
    if(!item||!seriesUI.layer)return;
    const source=seriesUI.episode?.series||slides[currentIndex()]?.series;
    if(!source||!seriesUI.sheetOpen)return;
    seriesUI.layerOpen=true;
    seriesUI.layer.hidden=false;
    const loading=seriesUI.layer.querySelector('.pts-series-error');
    loading.textContent='作品を読み込み中…';
    const token=++seriesUI.layerToken;
    seriesStopReading();seriesHideList();
    seriesUI.episode=null;
    seriesUI.layer.querySelector('.pts-series-image').replaceChildren();
    seriesUpdateEpisodeUI();
    try{
      const body=await fetchJson('/ajax/illust/'+encodeURIComponent(item.id));
      if(token!==seriesUI.layerToken||!seriesUI.layerOpen)return;
      if(!contentMatches(body))throw new Error('現在の表示条件に合わないか、種別・年齢情報を確認できません');
      const info=parseArtworkSeries(body);
      if(!info||info.id!==source.id||String(body.id??item.id)!==item.id)
        throw new Error('指定したシリーズの漫画を確認できません');
      const count=Math.max(1,Number(body.pageCount)||1);
      let pairs=[];
      if(count>1){
        const pages=await fetchJson('/ajax/illust/'+encodeURIComponent(item.id)+'/pages');
        if(token!==seriesUI.layerToken||!seriesUI.layerOpen)return;
        if(!Array.isArray(pages)||pages.length<1)
          throw new Error('漫画のページ一覧を取得できません');
        pairs=pages.map(p=>pickPair(p.urls)).filter(p=>p.r||p.o);
      }else pairs=[pickPair(body.urls)];
      if(!pairs.length)throw new Error('画像URLがありません');
      const e={id:item.id,index:item.index,order:item.order,
        title:body.title||item.title||'',series:info,pairs,
        tags:normTags(body.tags),userId:body.userId==null?null:String(body.userId),
        rawType:1,xRestrict:contentEnum(body.xRestrict),bookmarked:!!body.bookmarkData||
          knownBookmarkedIds.has(String(item.id)),tasteLearned:false,
        bookmarkBtn:seriesUI.layer.querySelector('.pts-series-save')};
      seriesUI.episode=e;seriesUI.pageIndex=0;
      seriesUI.reading={id:e.id,last:performance.now(),
        elapsed:0,recorded:false,score:0,maxPage:0,imageReady:false};
      seriesUI.clock=setInterval(seriesTickReading,250);
      seriesUpdateEpisodeUI();
      await seriesShowPage(0);
    }catch(err){
      if(token===seriesUI.layerToken)loading.textContent=
        '作品を開けません: '+String(err?.message||err);
    }
  }
  async function seriesStepEpisode(step){
    const e=seriesUI.episode;
    if(!e||!seriesUI.layerOpen||seriesUI.sheetOpen)return;
    const cache=seriesCacheFor(e.series.id);
    const index=e.index+step;
    if(index<0||(cache.total!=null&&index>=cache.total))return;
    let row=cache.rows.get(index);
    if(!row){
      const ok=await seriesFetchPage(cache,seriesPageForIndex(cache,index));
      if(!ok)return;
      row=cache.rows.get(index);
    }
    if(!row||seriesUI.episode!==e)return;
    // 専用レイヤーからの話移動でも同じ処理を使用する。
    seriesUI.sheetOpen=true;
    await seriesOpenEpisode(row);
  }
  function seriesCloseLayer(){
    if(!seriesUI.layerOpen)return;
    seriesUI.layerOpen=false;
    seriesUI.layerToken++;
    seriesStopReading();
    seriesHideList();
    seriesUI.episode=null;
    if(seriesUI.layer){
      seriesUI.layer.hidden=true;
      seriesUI.layer.querySelector('.pts-series-image').replaceChildren();
    }
    if(activeView)activeView.last=performance.now();
    syncDock();
  }
  async function seriesBookmarkEpisode(byLike){
    const e=seriesUI.episode;
    if(!e||!seriesUI.layerOpen||seriesUI.sheetOpen)return;
    const button=seriesUI.layer.querySelector('.pts-series-save');
    if(e.bookmarkPromise)return;
    if(byLike&&!e.likedThisSession){
      e.likedThisSession=true;
      learnFromWork(e.tags,e.userId,e.rawType,LEARN_LIKE_WEIGHT);
      e.tasteLearned=true;
    }
    if(e.bookmarked)return; // いいねの学習のみ（重複ブックマークPOSTはしない）
    button.disabled=true;
    try{
      await ensureBookmarked(e);
      if(seriesUI.episode===e)seriesUpdateEpisodeUI();
    }catch(err){
      if(seriesUI.episode===e){
        seriesUI.layer.querySelector('.pts-series-error').textContent=
          '保存失敗: '+String(err?.message||err);
        button.disabled=false;
      }
    }
  }
  function installSeriesLayer(){
    if(!overlay||seriesUI.layer)return;
    const root=document.createElement('section');
    root.className='pts-series-layer';root.hidden=true;
    root.innerHTML=
      '<header><span class="pts-series-episode-title"></span></header>'+
      '<div class="pts-series-image"></div>'+
      '<div class="pts-series-error" role="status"></div>'+
      '<div class="pts-series-controls">'+
      '<button type="button" class="pts-series-to-list">一覧へ</button>'+
      '<button type="button" class="pts-series-to-feed">フィードへ</button>'+
      '<button type="button" class="pts-series-prev-episode">前話</button>'+
      '<button type="button" class="pts-series-next-episode">次話</button>'+
      '<button type="button" class="pts-series-prev-page">前ページ</button>'+
      '<span class="pts-series-page-info">…</span>'+
      '<button type="button" class="pts-series-next-page">次ページ</button>'+
      '<button type="button" class="pts-series-save">♡ ブックマーク</button>'+
      '<button type="button" class="pts-series-like">いいね</button>'+
      '</div>';
    overlay.appendChild(root);seriesUI.layer=root;
    const sel=c=>root.querySelector('.'+c);
    sel('pts-series-to-list').onclick=()=>void seriesShowList();
    sel('pts-series-to-feed').onclick=seriesCloseLayer;
    sel('pts-series-prev-episode').onclick=()=>void seriesStepEpisode(-1);
    sel('pts-series-next-episode').onclick=()=>void seriesStepEpisode(1);
    sel('pts-series-prev-page').onclick=()=>void seriesShowPage(seriesUI.pageIndex-1);
    sel('pts-series-next-page').onclick=()=>void seriesShowPage(seriesUI.pageIndex+1);
    sel('pts-series-save').onclick=()=>void seriesBookmarkEpisode(false);
    sel('pts-series-like').onclick=()=>void seriesBookmarkEpisode(true);
    let start=null;
    root.addEventListener('touchstart',ev=>{
      if(ev.touches.length!==1||ev.target.closest('button'))return;
      start={x:ev.touches[0].clientX,y:ev.touches[0].clientY};
    },{passive:true});
    root.addEventListener('touchend',ev=>{
      if(!start||ev.changedTouches.length!==1)return;
      const dx=ev.changedTouches[0].clientX-start.x,
        dy=ev.changedTouches[0].clientY-start.y;
      start=null;
      if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.3)
        void seriesShowPage(seriesUI.pageIndex+(dx<0?1:-1));
    },{passive:true});
    document.addEventListener('keydown',ev=>{
      if(contentFilterDialog?.open)return;
      if(!seriesUI.layerOpen&&!seriesUI.sheetOpen)return;
      if(ev.key==='Escape'){
        if(seriesUI.sheetOpen)seriesHideList();else seriesCloseLayer();
        ev.preventDefault();ev.stopImmediatePropagation();
        return;
      }
      if(seriesUI.sheetOpen||!seriesUI.layerOpen||
        ev.target?.closest?.('input,textarea,[contenteditable]'))return;
      if(ev.key==='ArrowLeft'||ev.key==='ArrowRight'){
        void seriesShowPage(seriesUI.pageIndex+(ev.key==='ArrowRight'?1:-1));
        ev.preventDefault();ev.stopImmediatePropagation();
      }
    },true);
    const style=document.createElement('style');
    style.textContent=[
      '#pts-overlay .pts-series-layer[hidden]{display:none!important}',
      '#pts-overlay .pts-series-layer{position:absolute;inset:0;z-index:74;background:#050508;color:#fff;display:flex;flex-direction:column;overflow:hidden}',
      '#pts-overlay .pts-series-layer header{flex:0 0 auto;padding:calc(12px + env(safe-area-inset-top)) 14px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#pts-overlay .pts-series-image{flex:1;min-height:0;display:flex;justify-content:center;align-items:center;overflow:hidden}',
      '#pts-overlay .pts-series-image img{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain}',
      '#pts-overlay .pts-series-error{font-size:12px;color:#ffb8b8;text-align:center;min-height:18px}',
      '#pts-overlay .pts-series-controls{flex:0 0 auto;display:flex;overflow-x:auto;gap:8px;align-items:center;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:#17171b}',
      '#pts-overlay .pts-series-controls button{white-space:nowrap;min-height:44px;color:white;background:#383840;border:1px solid #ffffff40;border-radius:9px;padding:8px 12px}',
      '#pts-overlay .pts-series-controls button:disabled{opacity:.4}',
      '#pts-overlay .pts-series-page-info{white-space:nowrap;font-size:12px}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function syncDock() {
    if (!overlay) return;
    syncSeriesBar();
    syncContentFilterButton();
    const returnButton = overlay.querySelector('.pts-return-grid');
    if (returnButton) returnButton.hidden = !gridReturnState ||
      searchGrid.open || overlay.style.display === 'none';
    syncFollowButton();
  }
  function noteSessionVisit(s) {
    if (!s || !s.id) return;
    const id = String(s.id);
    if (sessionBackTarget === id) { sessionBackTarget = ''; return; }
    if (sessionTrail.at(-1)?.id === id) return;
    sessionTrail.push({ id, title: s.title || id, thumb: s.thumb || '' });
    if (sessionTrail.length > 50) sessionTrail.shift();
  }
  function viewingMetrics(v) {
    const s = v.slide;
    const duration = Math.max(LEARN_ANIMATION_MIN_MS,
      (s.frames || []).reduce((sum, f) => sum + (Number(f.delay) || 100), 0));
    const pages = Math.max(1, s.pairs?.length || 1);
    const expected = s.kind === 'multi'
      ? Math.min(LEARN_MULTI_MAX_MS, pages * LEARN_PAGE_MS)
      : s.kind === 'ugoira' ? duration * LEARN_ANIMATION_CYCLES : LEARN_SINGLE_MS;
    const ratio = Math.min(LEARN_RATIO_CAP, v.elapsed / expected);
    // ページ到達だけでは加点しない。実際に見た時間との積で評価する。
    const progress = s.kind === 'multi' && pages > 1
      ? Math.min(1, (v.maxPage || 0) / (pages - 1)) : 0;
    const loops = s.kind === 'ugoira'
      ? Math.min(LEARN_LOOP_CAP, v.played / duration, v.loops + 1) : 0;
    return {ratio, score: ratio * LEARN_DWELL_WEIGHT +
      progress * Math.min(1, ratio) * LEARN_PAGE_WEIGHT + loops * LEARN_LOOP_WEIGHT};
  }

  function learnViewing(v) {
    if (!v?.readySeen) return;
    const s = v.slide;
    if (!s.tags?.length && !s.userId) return;
    const metrics = viewingMetrics(v);
    const record = sessionWork(s.id);
    const delta = Math.min(LEARN_VIEW_BUDGET - record.learned,
      Math.max(0, metrics.score - v.scored));
    if (delta <= 0) return;
    v.scored = metrics.score;
    record.learned += delta;
    learnFromWork(s.tags, s.userId, s.rawType, delta, true, false);
    if (!viewSaveTimer) viewSaveTimer = setTimeout(() => {
      viewSaveTimer = null;
      saveProfile();
    }, LEARN_SAVE_INTERVAL_MS);
  }

  function finishViewing(v, manual) {
    if (!v || v.finished) return;
    v.finished = true;
    if (v.counting && !document.hidden && !searchGrid.open) {
      const dt = Math.max(0, Math.min(LEARN_TICK_MAX_MS, performance.now() - v.last));
      v.elapsed += dt;
      if (v.slide.kind === 'ugoira' && v.slide.animTimer) v.played += dt;
    }
    learnViewing(v);
    if (!v.readySeen || !manual) return;
    const s = v.slide;
    const events = sessionLearning().events;
    events.push({engaged: !!(s.likedThisSession || s.bookmarked ||
      sessionWork(s.id).opened || viewingMetrics(v).ratio >= LEARN_ENGAGE_RATIO)});
    if (events.length > LEARN_EVENT_LIMIT) events.shift();
  }

  function onCurrentSlideChanged(s) {
    if (!s || activeView?.slide === s) return;
    const old = activeView;
    const manual = navIntent.reason === 'user' && performance.now() <= navIntent.until;
    if (old && old.mode === mode && old.generation === feedGeneration && slides.includes(old.slide)) {
      finishViewing(old, manual);
    }
    viewedThisSession.add(String(s.id));
    const ready = visibleReady(s) && !document.hidden && !searchGrid.open;
    activeView = {
      slide: s, mode, generation: feedGeneration,
      elapsed: 0, played: 0, loops: 0, scored: 0, maxPage: s.pageIdx || 0,
      last: performance.now(), counting: ready,
      readySeen: ready, recorded: false, finished: false,
      rewatch: !!(manual && sessionWork(s.id).viewed)
    };
    syncDock();
  }
  function tickViewing() {
    if (!activeView) return;
    const v = activeView, now = performance.now();
    const dt = Math.max(0, Math.min(LEARN_TICK_MAX_MS, now - v.last));
    v.last = now;
    const s = v.slide;
    const wasCounting = v.counting;
    v.counting = !!(!contentFilterDialog?.open && overlay && overlay.style.display !== 'none' && !searchGrid.open &&
      !document.hidden && !seriesUI.layerOpen && !seriesUI.sheetOpen && slides[currentIndex()] === s && s.isCurrent && visibleReady(s));
    if (!v.counting) return;
    v.readySeen = true;
    const visibleTime = wasCounting ? dt : 0;
    v.elapsed += visibleTime;
    if (s.kind === 'ugoira' && s.animTimer) v.played += visibleTime;
    if (s.kind === 'multi' && visibleReady(s)) v.maxPage = Math.max(v.maxPage, s.pageIdx || 0);
    if (!v.recorded && v.elapsed >= LEARN_READY_MS) {
      v.recorded = true;
      markSeen(s.id);
      noteSessionVisit(s);
      const record = sessionWork(s.id);
      if (v.rewatch && record.rewatched < LEARN_REWATCH_LIMIT) {
        record.rewatched++;
        learnFromWork(s.tags, s.userId, s.rawType, LEARN_REWATCH_WEIGHT);
      }
      record.viewed = true;
    }
    learnViewing(v);
  }
  function onUgoiraLoop(s) {
    if (!contentFilterDialog?.open && !searchGrid.open && activeView?.slide === s && !document.hidden) {
      activeView.loops++;
    }
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
        learnFromWork(s.tags, s.userId, s.rawType, LEARN_LIKE_WEIGHT);
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

  // シングルタップは画面遷移しない。2回目のタップで即座にいいねする。
  function handleImageTap(e) {
    const holder = e.target.closest?.('.pts-holder');
    if (!holder || e.isPrimary === false || !touchStart) return;
    if (touchStart.pointerId !== e.pointerId ||
        Math.hypot(e.clientX-touchStart.x,e.clientY-touchStart.y)>12) return;
    const slide = slides[currentIndex()];
    if (!slide || holder.closest('.pts-slide') !== slide.sectionEl) return;
    const now=performance.now();
    if (lastTap && lastTap.id===String(slide.id) &&
        now-lastTap.time<=LIKE_TAP_WINDOW &&
        Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<=46) {
      lastTap=null;
      e.stopImmediatePropagation();
      void likeArtwork(slide,e.clientX,e.clientY);
      return;
    }
    lastTap={id:String(slide.id),time:now,x:e.clientX,y:e.clientY};
  }

  // キーボードによる移動はビューア表示中のみ。入力操作・修飾キーを優先。
  function handleViewerKeyboard(e) {
    if (contentFilterDialog?.open) return;
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey ||
        e.metaKey || !overlay || overlay.style.display==='none' ||
        searchGrid.open || seriesUI.sheetOpen || seriesUI.layerOpen) return;
    const focused=document.activeElement;
    const target=e.target?.nodeType===1 ? e.target : focused;
    const editable='input,textarea,select,[contenteditable]:not([contenteditable="false"]),' +
      '[role="textbox"],[role="combobox"]';
    if (target?.closest?.(editable) || focused?.closest?.(editable) ||
        focused?.isContentEditable) return;
    if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return;
    const index=currentIndex(), slide=slides[index];
    if (!slide) return;
    let handled=false;
    if (e.key==='ArrowUp'||e.key==='ArrowDown') {
      const next=index+(e.key==='ArrowDown'?1:-1);
      if (next>=0&&next<slides.length) gotoSlide(next,'user');
      handled=true;
    } else if (slide.kind==='multi'&&slide.pairs?.length>1) {
      const pager=slide.sectionEl?.querySelector('.pts-pager');
      if (!pager) return;
      const width=Math.max(1,pager.clientWidth);
      const page=Math.max(0,Math.min(slide.pairs.length-1,
        Math.round(pager.scrollLeft/width)));
      const next=page+(e.key==='ArrowRight'?1:-1);
      if (next>=0&&next<slide.pairs.length) {
        loadHorizontalNeighbors(slide,next);
        pager.scrollTo({left:next*width,behavior:'smooth'});
      }
      handled=true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function bindExperienceGestures() {
    feedEl.addEventListener('pointerdown', e => {
      if (!e.target.closest?.('.pts-holder')) return;

      if (!e.isPrimary) {
        touchStart = null;
        lastTap = null;
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
    }, true);
  }


  function showSessionHistory() {
    const panel = overlay.querySelector('.pts-history-panel');
    const list = panel.querySelector('.pts-history-list');
    list.replaceChildren();
    for (const item of [...sessionTrail].reverse()) {
      const btn = document.createElement('button');
      const available = slides.some(s => String(s.id) === item.id && contentMatches(s));
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
      routeAutoStartSuppressed = true;
      btn.dataset.confirm = '0'; closeViewer(); return;
    }
    btn.dataset.confirm = '1'; btn.textContent = '本当に閉じる？';
    clearTimeout(closeConfirmTimer);
    closeConfirmTimer = setTimeout(() => {
      btn.dataset.confirm = '0'; btn.textContent = '閉じる';
    }, 2500);
  }

  function installExperienceCSS() {
    const style = document.createElement('style');

    style.textContent = `
      #pts-overlay .pts-bar{
        position:absolute;top:0;left:0;right:0;z-index:40;
        display:flex;align-items:center;gap:8px;
        box-sizing:border-box;
        padding:calc(8px + env(safe-area-inset-top)) 10px 8px;
        color:#fff;background:linear-gradient(#000d,#0007);
        pointer-events:auto;overflow:visible;white-space:normal
      }
      #pts-overlay .pts-global-search{
        display:flex;flex:1;min-width:0;gap:6px;height:38px
      }
      #pts-overlay .pts-global-search input{
        flex:1;min-width:0;width:100%;box-sizing:border-box;
        background:#25252d;color:#fff;
        border:1px solid #ffffff35;border-radius:10px;
        padding:0 12px;font-size:14px;outline:none
      }
      #pts-overlay .pts-global-search input:focus{
        border-color:#ffffff8a
      }
      #pts-overlay .pts-global-search button{
        flex:0 0 auto;min-width:56px;padding:0 10px;
        border:1px solid #ffffff30;border-radius:10px;
        background:#444c;color:white;font-size:13px
      }
      #pts-overlay .pts-counter{
        flex:0 0 auto;max-width:29%;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;
        font-size:11px;opacity:.72
      }

      #pts-overlay .pts-dock{
        position:absolute;bottom:0;left:0;right:0;z-index:30;
        display:flex;flex-wrap:nowrap;align-items:center;gap:7px;
        overflow-x:auto;overflow-y:hidden;scrollbar-width:none;
        -webkit-overflow-scrolling:touch;
        overscroll-behavior-x:contain;touch-action:pan-x;
        padding:8px 10px calc(8px + env(safe-area-inset-bottom));
        box-sizing:border-box;
        background:linear-gradient(transparent,#000e 18%,#000f);
      }
      #pts-overlay .pts-dock::-webkit-scrollbar{
        display:none
      }
      #pts-overlay .pts-dock button{
        flex:0 0 auto;min-height:48px;
        padding:0 14px;white-space:nowrap;
        border:1px solid #ffffff32;
        background:#303030dd;color:#fff;
        border-radius:11px;font-size:13px;
        touch-action:manipulation
      }
      #pts-overlay .pts-dock .pts-close{
        position:static;right:auto
      }
      #pts-overlay .pts-dock .pts-return-grid[hidden]{
        display:none!important
      }

      #pts-overlay .pts-history-panel[hidden],
      #pts-overlay .pts-search-tags[hidden]{
        display:none!important
      }
      #pts-overlay .pts-history-panel{
        position:absolute;inset:0;z-index:60;
        background:#000d;display:flex;
        align-items:center;justify-content:center;
        padding:12px;box-sizing:border-box
      }
      #pts-overlay .pts-history-sheet{
        width:100%;max-width:900px;height:80dvh;
        background:#151515;color:#fff;
        border:1px solid #555;border-radius:12px;
        display:flex;flex-direction:column;padding:12px;
        box-sizing:border-box
      }

      #pts-overlay .pts-history-head{
        display:flex;align-items:center;
        justify-content:space-between;padding-bottom:10px
      }
      #pts-overlay .pts-history-head button{
        padding:10px;border:0;border-radius:8px;
        background:#444;color:#fff
      }
      #pts-overlay .pts-history-list{
        display:flex;flex-direction:column;gap:6px;
        overflow:auto;min-height:0
      }
      #pts-overlay .pts-history-list button{
        padding:11px;text-align:left;
        background:#303030;color:#fff;
        border:0;border-radius:7px
      }
      #pts-overlay .pts-history-list button:disabled{opacity:.4}

      #pts-overlay .pts-seek{
        position:absolute;left:12px;right:12px;
        top:auto;bottom:calc(80px + env(safe-area-inset-bottom));
        height:32px;z-index:27;background:none;
        touch-action:none;pointer-events:auto
      }
      #pts-overlay .pts-seek::before{
        content:"";position:absolute;left:0;right:0;top:50%;
        height:4px;transform:translateY(-50%);
        background:#ffffff55;border-radius:4px
      }
      #pts-overlay .pts-seek-fill{
        position:absolute;left:0;top:50%;height:4px;
        transform:translateY(-50%);background:#0096fa;
        border-radius:4px
      }
      #pts-overlay .pts-seek-knob{
        position:absolute;top:50%;left:0;
        width:16px;height:16px;margin-left:0;
        transform:translate(-50%,-50%);
        border-radius:50%;background:#fff;
        box-shadow:0 1px 5px #0009
      }
      #pts-overlay .pts-ugoira-status{
        position:absolute;left:50%;top:43%;z-index:17;
        transform:translate(-50%,-50%);
        padding:10px 15px;border-radius:12px;
        background:#000c;color:#fff;font-size:13px;
        text-align:center;pointer-events:none;max-width:85vw
      }
      #pts-overlay .pts-ugoira-status[hidden]{display:none!important}
      #pts-overlay .pts-tween-btn{
        position:absolute;top:84px;right:14px;z-index:27;
        appearance:none;border:0;border-radius:999px;
        background:#0009;color:#fff;font-size:12px;
        padding:6px 11px;pointer-events:auto;cursor:pointer
      }
      #pts-overlay .pts-tween-btn.pts-tween-on{background:#0096fad9}
      #pts-overlay .pts-tween-btn[hidden]{display:none!important}
      #pts-overlay .pts-ugoira-error{color:#ffd6d6}

      #pts-overlay .pts-search-tags{
        position:absolute;left:0;right:0;z-index:22;
        top:calc(65px + env(safe-area-inset-top));
        display:flex;gap:6px;padding:4px 10px;
        overflow-x:auto;scrollbar-width:none;
        background:linear-gradient(#0009,#0002)
      }
      #pts-overlay .pts-search-tags::-webkit-scrollbar{display:none}
      #pts-overlay .pts-search-tags button{
        flex-shrink:0;white-space:nowrap;color:#fff;
        background:#333c;border:1px solid #ffffff30;
        border-radius:999px;padding:7px 11px;font-size:12px
      }

      #pts-overlay .pts-img{
        display:block;width:100%;height:100%;
        max-width:100%;max-height:100%;
        object-fit:contain!important;animation:none!important
      }
      #pts-overlay .pts-holder .pts-ugoira-canvas{
        display:block;position:absolute;inset:0;width:100%;height:100%;
        object-fit:contain;pointer-events:none
      }
      #pts-overlay .pts-holder.pts-ugoira-active > .pts-img{
        visibility:hidden
      }
      #pts-overlay .pts-holder{touch-action:pan-x pan-y}
      #pts-overlay .pts-slide.pts-current .pts-holder{
        animation:ptsIn .16s ease-out
      }
      @keyframes ptsIn{from{opacity:.83}to{opacity:1}}
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
        #pts-overlay .pts-holder{animation:none!important}
        #pts-overlay .pts-like-heart{animation-duration:.2s}
      }
  `;

    document.head.appendChild(style);
  }

  // 作者フォローはpixivの既存Web API。既フォロー状態は作者情報から検証する。
  const followState = {
    account: '', cache: new Map(), pending: new Map(), sending: new Set()
  };

  function followAccountSync() {
    const account = getMyUserId();
    if (followState.account !== account) {
      followState.account = account;
      followState.cache.clear();
      followState.pending.clear();
      followState.sending.clear();
    }
    return account;
  }

  function followButtonState(s) {
    const account = followAccountSync();
    const id = String(s?.userId || '');
    if (!s || !/^[1-9]\d*$/.test(id)) return 'no-author';
    if (!account) return 'login-required';
    if (account === id) return 'self';
    if (followState.sending.has(id)) return 'sending';
    if (!followState.cache.has(id)) return 'unknown';
    return followState.cache.get(id) === true ? 'following' :
      followState.cache.get(id) === false ? 'not-following' : 'error';
  }

  function syncFollowButton() {
    const button = overlay?.querySelector('.pts-follow-author');
    if (!button) return;
    const slide = slides[currentIndex()];
    const id = String(slide?.userId || '');
    const state = followButtonState(slide);
    const labels = {
      'no-author': '作者情報を取得中',
      'login-required': 'フォロー（ログインが必要）',
      self: '自分の作品',
      sending: 'フォロー処理中…',
      unknown: 'フォロー確認中…',
      following: '✓ フォロー済み',
      'not-following': '作者をフォロー',
      error: 'フォロー状態を再確認'
    };
    button.textContent = labels[state];
    button.disabled = searchGrid.open ||
      !['not-following', 'error'].includes(state);
    if (state === 'unknown') {
      void checkFollowStatus(id);
    }
  }

  async function readFollowStatus(authorId) {
    const response = await fetch(
      '/ajax/user/' + encodeURIComponent(authorId) + '?full=1',
      {credentials:'same-origin',cache:'no-store'}
    );
    if (!response.ok) throw new Error('作者情報の取得失敗（HTTP '+response.status+'）');
    const json = await response.json();
    if (json?.error !== false || typeof json?.body?.isFollowed !== 'boolean') {
      throw new Error('フォロー状態を確認できません');
    }
    return json.body.isFollowed;
  }

  async function checkFollowStatus(authorId, force = false) {
    const account = followAccountSync();
    if (!account || !/^[1-9]\d*$/.test(authorId) ||
        account === authorId) return null;
    if (!force && followState.cache.has(authorId))
      return followState.cache.get(authorId);
    if (followState.pending.has(authorId))
      return followState.pending.get(authorId);
    const promise = (async () => {
      try {
        const following = await readFollowStatus(authorId);
        if (getMyUserId() === account) {
          followState.cache.set(authorId, following);
        }
        return following;
      } catch (e) {
        if (getMyUserId() === account) {
          followState.cache.set(authorId, null);
          console.warn('[PTS follow]', e);
        }
        return null;
      } finally {
        if (getMyUserId() === account) {
          followState.pending.delete(authorId);
          // 描画更新に再照会を走らせない。失敗時はユーザー操作で再試行。
          const shown = slides[currentIndex()];
          if (String(shown?.userId || '') === authorId) syncFollowButton();
        }
      }
    })();
    followState.pending.set(authorId, promise);
    return promise;
  }

  async function followCurrentAuthor() {
    const slide = slides[currentIndex()];
    if (!slide || searchGrid.open || !overlay ||
        overlay.style.display === 'none') return;
    if (!slide.userId && !slide.resolved) {
      try { await resolveSlide(slide); } catch (_) {}
    }
    if (slides[currentIndex()] !== slide || searchGrid.open) return;
    const id = String(slide.userId || '');
    if (!/^[1-9]\d*$/.test(id)) {
      window.alert('作者IDを取得できませんでした。');
      return;
    }
    const account = followAccountSync();
    if (!account) {
      window.alert('作者をフォローするにはpixivへのログインが必要です。');
      return;
    }
    if (account === id || followState.sending.has(id)) return;
    const state = await checkFollowStatus(id, true);
    if (state === true || state === null) {
      syncFollowButton();
      if (state === null) window.alert('フォロー状態を確認できません。再試行してください。');
      return;
    }
    if (slides[currentIndex()] !== slide || searchGrid.open ||
        getMyUserId() !== account) return;
    followState.sending.add(id);
    syncFollowButton();
    try {
      const token = await getCsrfToken();
      if (!token) throw new Error('CSRFトークンを取得できません');
      // pixiv Webの作者フォロー操作。成功とは限らないため必ずGETで検証する。
      const body = new URLSearchParams({
        mode:'add', type:'user', user_id:id,
        tag:'', restrict:'0', format:'json'
      });
      const response = await fetch('/bookmark_add.php', {
        method:'POST',credentials:'same-origin',
        headers:{'x-csrf-token':token,'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
        body:body.toString()
      });
      if (!response.ok) {
        if ([401,403].includes(response.status)) {
          csrfToken=null;csrfTokenSource='';csrfPreferHome=true;
        }
        throw new Error('フォローAPI HTTP '+response.status);
      }
      // 当該Web APIの応答形式には差異があるため、状態確認結果を唯一の成功根拠とする。
      const verified = await readFollowStatus(id);
      if (getMyUserId() !== account) return;
      if (verified !== true) throw new Error(
        'フォロー済み状態を確認できません。pixiv側の認証／追加認証を確認してください'
      );
      followState.cache.set(id, true);
    } catch (e) {
      followState.cache.delete(id);
      console.warn('[PTS follow] フォロー失敗', e);
      window.alert('作者をフォローできませんでした: ' +
        String(e?.message || e).slice(0,160));
    } finally {
      if (getMyUserId() === account) followState.sending.delete(id);
      syncFollowButton();
    }
  }

  function installExperienceUI() {
    if (experienceInstalled || !overlay) return;
    experienceInstalled = true;

    const dock = document.createElement('nav');
    dock.className = 'pts-dock';
    dock.setAttribute('aria-label', 'ビューア操作');
    overlay.appendChild(dock);

    const addButton = (className, label, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      button.addEventListener('click', handler);
      dock.appendChild(button);
      return button;
    };

    addButton('pts-history-button', '履歴', showSessionHistory);

    // 診断・更新の既存イベントを保持してDOM移動。
    for (const selector of [
      '.pts-diagnostic',
      '.pts-rescan'
    ]) {
      const button = overlay.querySelector(
        '.pts-bar ' + selector
      );
      if (button) dock.appendChild(button);
    }

    const oldClose = overlay.querySelector('.pts-close');
    if (oldClose) {
      const close = oldClose.cloneNode(true);
      close.textContent = '閉じる';
      oldClose.replaceWith(close);
      close.addEventListener('click', confirmCloseViewer);
      dock.appendChild(close);
    }

    dock.prepend(addButton('pts-content-filter', contentFilterLabel(), () => showContentFilterDialog(false)));
    addButton('pts-follow-author', '作者をフォロー',
      () => { void followCurrentAuthor(); });
    addButton('pts-return-grid', '検索結果へ戻る',
      returnToSearchGrid).hidden = true;

    const bar = overlay.querySelector('.pts-bar');
    const form = document.createElement('form');
    form.className = 'pts-global-search';
    form.setAttribute('role', 'search');

    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'pixivで検索';
    input.autocomplete = 'off';
    input.enterKeyHint = 'search';
    input.setAttribute('aria-label', 'pixiv検索ワード');
    input.value = getSearchPageConfig()?.word || '';

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = '検索';

    form.append(input, submit);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const word = input.value.trim();
      if (!word) return;
      openSearchGrid(word);
    });

    bar.prepend(form);

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

    bindExperienceGestures();
    document.addEventListener('keydown', handleViewerKeyboard, true);

    document.addEventListener('keydown', e => {
      if (contentFilterDialog?.open) return;
      if (
        e.key !== 'Escape' ||
        overlay.style.display === 'none'
      ) return;

      // シリーズ一覧・専用閲覧レイヤー側のEscape操作を優先する。
      if (seriesUI.sheetOpen || seriesUI.layerOpen) return;
      // 検索入力中のEscapeは検索欄側に任せる。
      if (e.target.closest?.('.pts-global-search')) return;

      e.stopImmediatePropagation();
      e.preventDefault();
      if (searchGrid.open) closeSearchGrid();
      else confirmCloseViewer();
    }, true);

    if (!activeTick) {
      activeTick = setInterval(tickViewing, 250);
    }

    installExperienceCSS();
    installSearchGridUI();
    syncDock();
  }

  /* ---------- v3.13.7: 検索グリッド（フィードとは独立） ---------- */
  const searchGrid = {
    open: false, token: 0, controller: null, busy: false,
    finished: false, page: 1, config: null, tagsReady: false,
    items: [], ids: new Set(), root: null, scroll: null,
    cards: null, chips: null, title: null, status: null, retry: null
  };

  // グリッドで開いた作品からのみ有効な「検索結果へ戻る」。
  // card/取得済みitemsはcloseSearchGridでは破棄しない。
  let gridReturnState = null;
  let gridTap = null;

  function syncSearchGridBookmark(id) {
    const g = searchGrid;
    id = String(id);
    const item = g.items.find(it => String(it.id) === id);
    if (item) item.bookmarked = true;
    const slide = slides.find(it => String(it.id) === id);
    if (slide) slide.bookmarked = true;
    const card = [...(g.cards?.children || [])]
      .find(el => el.dataset.ptsId === id);
    if (card) {
      card.classList.add('pts-grid-bookmarked');
      const button = card.querySelector('.pts-grid-save');
      if (button) {
        button.textContent = '✓';
        button.disabled = true;
        button.setAttribute('aria-label', '保存済み');
      }
    }
  }

  function reconcileSearchGridBookmarks() {
    for (const it of searchGrid.items) {
      const id = String(it.id);
      if (it.bookmarked || knownBookmarkedIds.has(id) ||
          slides.some(s => String(s.id) === id && s.bookmarked)) {
        syncSearchGridBookmark(id);
      }
    }
  }

  function returnToSearchGrid() {
    const g = searchGrid, back = gridReturnState;
    if (!back || g.open || !overlay || overlay.style.display === 'none' ||
        !g.root || !g.config || !g.rankContext ||
        g.rankContext.queryKey !== back.queryKey ||
        !searchContextValid(g.rankContext)) return false;
    const current = slides[currentIndex()];
    if (current?.kind === 'ugoira') stopUgoira(current);
    reconcileSearchGridBookmarks();
    g.open = true;
    g.root.hidden = false;
    overlay.classList.add('pts-grid-open');
    g.scroll.scrollTop = back.scrollTop;
    if (activeView) activeView.last = performance.now();
    syncDock();
    // 開いていた時点の読み込み進捗を引き継ぐ。再検索はしない。
    return true;
  }


  function clearGridTap() {
    if (gridTap?.timer) clearTimeout(gridTap.timer);
    gridTap = null;
  }

  function closeSearchGrid(resume = true) {
    const wasOpen = searchGrid.open;
    clearGridTap();
    searchGrid.token++;
    searchGrid.controller?.abort();
    searchGrid.controller = null;
    searchGrid.busy = false;
    searchGrid.open = false;

    if (searchGrid.root) searchGrid.root.hidden = true;
    overlay?.classList.remove('pts-grid-open');

    if (wasOpen && activeView) {
      activeView.last = performance.now();
    }

    if (wasOpen && resume) {
      const s = slides[currentIndex()];
      if (s?.isCurrent && s.kind === 'ugoira' &&
          s.frameUrls?.length) {
        startUgoira(s);
      }
    }
    syncDock();
  }

  function openSearchGrid(value) {
    const word = String(value || '').trim();
    if (!word || !overlay || !searchGrid.root) return;

    gridReturnState = null;
    closeSearchGrid(false);
    syncDock();

    const current = slides[currentIndex()];
    if (current?.kind === 'ugoira') stopUgoira(current);

    const from = getSearchPageConfig();
    searchGrid.config = {
      word,
      order: from?.order || 'popular_d',
      searchMode: from?.searchMode || 'all',
      matchMode: from?.matchMode || 's_tag'
    };

    searchGrid.page = 1;
    searchGrid.finished = false;
    searchGrid.searchBoosted = false;
    searchGrid.fixedIds = new Set();
    searchGrid.rankContext = getSearchRankContext(searchGrid.config, 1);
    searchGrid.items = [];
    searchGrid.ids.clear();
    searchGrid.tagsReady = false;
    searchGrid.cards.replaceChildren();
    searchGrid.chips.replaceChildren();
    searchGrid.scroll.scrollTop = 0;

    searchGrid.title.textContent = `「${word}」の検索結果`;
    searchGrid.status.textContent = '読み込み中…';
    searchGrid.retry.hidden = true;
    searchGrid.open = true;
    searchGrid.root.hidden = false;

    if (overlay) {
      overlay.classList.add('pts-grid-open');
    }

    const input = overlay.querySelector('.pts-global-search input');
    if (input) input.value = word;

    const token = searchGrid.token;
    void (async () => {
      for (let n = 0; n < 2 && searchGrid.open &&
          searchGrid.token === token && !searchGrid.finished &&
          !searchGrid.items.length; n++) {
        const ok = await searchGridLoadMore();
        if (!ok) break;
      }
    })();
  }


  // v3.13.18: 検索APIヒットの証拠・ページ進捗を queryKey 単位で共有する。
  function searchNormalize(value) {
    return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
  }

  // 検索API候補専用。illustTypeが欠落したときはrawTypeを使い、
  // どちらも不明ならnullのままとする（ugoira加点なし）。
  // 通常候補と同じ厳密な種別正規化を使う。
  function searchIllustType(candidate) {
    return contentType(candidate);
  }

  function normalizeSearchCandidate(candidate) {
    const normalized = normalizeCandidate(candidate);
    normalized.illustType = searchIllustType(candidate);
    return normalized;
  }

  function legacySearchWordTier(it, word) {
    const query = searchNormalize(word);
    if (!query) return 0;
    const tags = normTags(it.tags).map(searchNormalize);
    if (tags.includes(query)) return 2;
    return tags.some(t => t.includes(query)) ? 1 : 0;
  }

  const searchRankPools = new Map();
  let searchPoolGeneration = 0;

  // APIリクエストで結果集合を決める条件を一箇所で定義する。
  // ページ番号は共有結果集合の資格とは別に管理する。
  function searchApiConditions(config) {
    return {
      word: String(config.word || ''),
      order: String(config.order || 'popular_d'),
      mode: contentSourceMode(config.contentFilter || contentFilter, String(config.searchMode || 'all')),
      type: contentSourceType(config.contentFilter || contentFilter),
      s_mode: String(config.matchMode || 's_tag')
    };
  }

  function searchQueryKey(config) {
    return JSON.stringify([searchApiConditions(config), config.contentFilter || contentFilter]);
  }

  function getSearchRankContext(config, startPage = 1) {
    const queryKey = searchQueryKey(config);
    let ctx = searchRankPools.get(queryKey);
    const page = Math.max(1, Number(startPage) || 1);
    if (!ctx) {
      const queryTokens = [...new Set(
        searchNormalize(config.word).split(/\s+/u).filter(Boolean)
      )];
      ctx = {
        queryKey, word: config.word, queryTokens,
        config: Object.freeze({
          word: String(config.word || ''),
          order: String(config.order || 'popular_d'),
          searchMode: String(config.searchMode || 'all'),
          matchMode: String(config.matchMode || 's_tag'),
          contentFilter: {...contentFilter}
        }),
        queryType: queryTokens.length > 1 ? 'multi-token' : 'single-token',
        relatedTags: new Set(), searchOrderById: new Map(),
        searchHitIds: new Set(), generation: ++searchPoolGeneration,
        records: new Map(), fetchedPages: new Set(),
        nextPage: page, finished: false, busy: null, firstBody: null,
        total: null, failure: null
      };
      // モバイル端末のメモリを圧迫しないよう、過去の検索プールを制限。
      if (searchRankPools.size >= 8) {
        searchRankPools.delete(searchRankPools.keys().next().value);
      }
      searchRankPools.set(queryKey, ctx);
    } else if (page < ctx.nextPage && !ctx.fetchedPages.has(page)) {
      ctx.nextPage = page;
      ctx.finished = false;
    }
    return ctx;
  }

  function searchContextValid(ctx) {
    return !!ctx && searchRankPools.get(ctx.queryKey) === ctx;
  }

  // 共有API取得はルートのAbortSignalから独立。各ルートは自分の反映だけ中止する。
  async function loadSearchApiBatch(ctx, config, isCurrent, signal) {
    const routeValid = () => isCurrent() && searchContextValid(ctx) &&
      !signal?.aborted && searchQueryKey(config) === ctx.queryKey;
    if (!routeValid()) return { stale: true };

    if (!ctx.busy) {
      const job = (async () => {
        let fetched = 0, first = null, error = null;
        for (let attempt = 0; attempt < SEARCH_BATCH_PAGES;) {
          if (!searchContextValid(ctx)) return { stale: true };
          if (ctx.finished) break;
          const page = ctx.nextPage;
          if (page > 1000) { ctx.finished = true; break; }
          if (ctx.fetchedPages.has(page)) { ctx.nextPage++; continue; }
          let body;
          try {
            // ここにはフィード/グリッド固有のsignalを渡さない。
            body = await fetchJson(searchApiUrl(ctx.config, page));
          } catch (e) {
            error = e;
            break;
          }
          if (!searchContextValid(ctx)) return { stale: true };
          const data = body?.illustManga?.data;
          if (!Array.isArray(data)) {
            error = new Error('検索API候補配列なし (p=' + page + ')');
            break;
          }
          if (!first) first = body;
          if (!ctx.firstBody) ctx.firstBody = body;
          for (const tag of searchRelatedTags(body)) ctx.relatedTags.add(tag);
          for (const raw of data) {
            const it = normalizeSearchCandidate(raw);
            const id = String(it.id || '');
            if (!/^\d+$/.test(id) || ctx.searchHitIds.has(id)) continue;
            ctx.searchHitIds.add(id);
            ctx.searchOrderById.set(id, ctx.searchOrderById.size);
            ctx.records.set(id, {
              ...it, isSearchApiHit: true, queryKey: ctx.queryKey
            });
          }
          ctx.fetchedPages.add(page);
          ctx.nextPage = page + 1;
          ctx.total = Number(body?.illustManga?.total);
          fetched++;
          attempt++;
          if (!data.length || (Number.isFinite(ctx.total) &&
              ctx.total >= 0 && page * 36 >= ctx.total)) ctx.finished = true;
        }
        if (!searchContextValid(ctx)) return { stale: true };
        ctx.failure = error;
        return { fetched, error, body: first || ctx.firstBody, stale: false };
      })();
      ctx.busy = job;
    }

    const sharedJob = ctx.busy;
    try {
      const outcome = await sharedJob;
      return routeValid() ? outcome : { stale: true };
    } finally {
      if (ctx.busy === sharedJob) ctx.busy = null;
    }
  }

  // 検索専用。関連度は最大400点に収め、1000点刻みのtierを維持する。
  const SEARCH_WORD_TAG_WEIGHT = 40;
  const SEARCH_RELATED_TAG_WEIGHT = 24;

  function searchRelatedTags(body) {
    const lists = [body?.relatedTags, body?.illustManga?.relatedTags,
      body?.tagSuggestions, body?.suggestTags];
    return [...new Set(lists.flatMap(items =>
      Array.isArray(items) ? items.map(it => typeof it === 'string'
        ? it : it?.tag ?? it?.name ?? it?.word) : []
    ).filter(t => typeof t === 'string' && t.trim()).map(t =>
      t.normalize('NFKC').trim().toLocaleLowerCase()))];
  }

  function searchWordRelevance(it, word, relatedTags = []) {
    const query = String(word || '').normalize('NFKC')
      .trim().toLocaleLowerCase();
    if (!query) return 0;
    const tags = [...new Set(normTags(it.tags).map(t =>
      String(t).normalize('NFKC').toLocaleLowerCase()))];
    const matches = tags.filter(t => t.includes(query)).length;
    const related = tags.filter(t => t !== query && relatedTags.includes(t)).length;
    return Math.min(400,
      Math.min(8, matches) * SEARCH_WORD_TAG_WEIGHT +
      Math.min(8, related) * SEARCH_RELATED_TAG_WEIGHT
    );
  }


  // 辞書式比較。分散は同点集合内の動的選択だけで適用する。
  function compareSearchRank(a, b, includeApiOrder = true) {
    const tier = b.tier - a.tier;
    if (tier) return tier;
    const taste = b.taste - a.taste;
    if (taste) return taste;
    for (let i = 0; i < 4; i++) {
      const direct = b.directRelevanceKey[i] - a.directRelevanceKey[i];
      if (direct) return direct;
    }
    return includeApiOrder ? a.apiOrder - b.apiOrder : 0;
  }

  // 第1層の資格・第2層のtierは、検索APIから証拠を得たctxだけで計算。
  function searchRankRow(ctx, candidate) {
    const id = candidateId(candidate);
    if (!ctx || !ctx.searchHitIds.has(id) ||
      candidate.isSearchApiHit !== true ||
      candidate.queryKey !== ctx.queryKey) return null;
    const cached = ctx.records.get(id) || candidate;
    const normalizedType = searchIllustType(cached) ??
      searchIllustType(candidate);
    const it = {
      ...cached, ...candidate,
      title: candidate.title || cached.title || '',
      tags: normTags(candidate.tags).length ? candidate.tags : cached.tags,
      userId: candidate.userId ?? cached.userId,
      illustType: normalizedType
    };
    const match = searchDiagnosticMatch(it, ctx.word);
    return {
      it: candidate, meta: it, id, tier: match.tier,
      taste: tasteScore(it),
      directRelevanceKey: [
        match.coverageCount, match.exactTagTokenCount,
        match.titleTokenCount, match.partialTagTokenCount
      ],
      apiOrder: ctx.searchOrderById.get(id) ?? Number.MAX_SAFE_INTEGER
    };
  }

  function searchTiePenalty(row, previous, source = null, repeated = 0) {
    const last = previous.at(-1), second = previous.at(-2);
    const a = String(row.meta.userId || '');
    let penalty = 0;
    if (a && a === String(last?.userId || '')) penalty += 12;
    if (a && a === String(second?.userId || '')) penalty += 5;
    if (last && String(last.id) !== String(source?.id || '')) {
      penalty += Math.min(8, commonIdentityTags(row.meta, last) * 4);
    }
    if (second && String(second.id) !== String(source?.id || '')) {
      penalty += Math.min(4, commonIdentityTags(row.meta, second) * 2);
    }
    if (source) {
      const shared = commonIdentityTags(row.meta, source);
      penalty += Math.min(12, shared * 5);
      if (shared) penalty += Math.min(6, repeated * 1.5);
    }
    return penalty;
  }

  // モデルAの並べ替え本体。診断も同じ計算済み順位行を使う。
  function orderSearchRankRows(input, options = {}) {
    const { previous = [], source = null,
      limit = Infinity, diversify = true } = options;
    const rows = input.slice().sort(compareSearchRank);
    if (!diversify) return rows.slice(0, limit).map(row => row.it);
    const result = [], used = previous.slice(-2);
    let repeated = 0;
    for (let start = 0; start < rows.length;) {
      let end = start + 1;
      while (end < rows.length &&
        compareSearchRank(rows[start], rows[end], false) === 0) end++;
      const tie = rows.slice(start, end);
      while (tie.length && result.length < limit) {
        let best = 0, lowest = Infinity;
        for (let i = 0; i < tie.length; i++) {
          const penalty = searchTiePenalty(tie[i], used, source, repeated);
          if (penalty < lowest || (penalty === lowest &&
              tie[i].apiOrder < tie[best].apiOrder)) {
            lowest = penalty;
            best = i;
          }
        }
        const chosen = tie.splice(best, 1)[0];
        result.push(chosen.it);
        used.push(chosen.meta);
        if (source && commonIdentityTags(chosen.meta, source)) repeated++;
      }
      if (result.length >= limit) break;
      start = end;
    }
    return result;
  }

  function searchRankCandidates(ctx, candidates, options = {}) {
    const ids = new Set(), rows = [];
    for (const candidate of candidates || []) {
      const id = candidateId(candidate);
      if (ids.has(id)) continue;
      const row = searchRankRow(ctx, candidate);
      if (!row || (options.onlyMatching && row.tier === 0)) continue;
      ids.add(id);
      rows.push(row);
    }
    return orderSearchRankRows(rows, options);
  }

  async function prepareSearchRankCandidates(ctx, excludeIds, isCurrent, signal) {
    if (!isCurrent() || !searchContextValid(ctx) || signal?.aborted) return null;
    const excluded = new Set((excludeIds || []).map(String));
    const raw = [...ctx.records.values()].filter(it =>
      !excluded.has(String(it.id)) && !isSeen(it.id) &&
      !knownBookmarkedIds.has(String(it.id)) &&
      !it.bookmarked
    );
    const prepared = await prepareCandidates(raw, {
      excludeIds: [...excluded, ...seenTimes.keys()],
      enrichTop: 0, rank: tasteScore, isCurrent
    });
    if (!isCurrent() || !searchContextValid(ctx) || signal?.aborted) return null;
    return prepared.filter(it => ctx.searchHitIds.has(String(it.id)) &&
      !isSeen(it.id) &&
      !knownBookmarkedIds.has(String(it.id)) && !it.bookmarked
    ).map(it => ({
      ...it, isSearchApiHit: true, queryKey: ctx.queryKey
    }));
  }

  function markSearchSlides(items, ctx) {
    if (!searchContextValid(ctx)) return [];
    return items.filter(slide => {
      const id = String(slide.id);
      if (!ctx.searchHitIds.has(id) || !ctx.records.has(id)) return false;
      slide.isSearchApiHit = true;
      slide.queryKey = ctx.queryKey;
      return true;
    });
  }

  async function fetchBookmarkRelatedCandidates(id) {
    const epoch = contentFilterEpoch;
    const anchor = slides.find(s => String(s.id) === String(id));
    const filter = {...contentFilter};
    if (filter.type === 'all' && contentType(anchor) !== null) filter.type = contentType(anchor) === 1 ? 'manga' : 'illust';
    if (filter.age === 'all' && contentEnum(anchor?.xRestrict) !== null) filter.age = Number(anchor.xRestrict) > 0 ? 'r18' : 'safe';
    // recommend の既存取得に discovery を1回だけ追加する。
    const related = (async () => {
      const body = await fetchJson(
        `/ajax/illust/${encodeURIComponent(id)}/recommend/init?limit=60&lang=ja`
      );

      let candidates = customCandidateArray(body);

      if (!candidates.length && Array.isArray(body?.nextIds) &&
          body.nextIds.length) {
        const ids = body.nextIds.slice(0, 60).map(String);
        const more = await fetchJson(
          '/ajax/illust/recommend/illusts?illustIds=' +
          encodeURIComponent(ids.join(',')) + '&lang=ja'
        );
        candidates = customCandidateArray(more);
      }

      return candidates;
    })();
    const results = await Promise.allSettled([
      related,
      fetchJson(contentDiscoveryUrl(filter))
        .then(customCandidateArray)
    ]);
    if (results.every(result => result.status === 'rejected')) {
      throw results[0].reason;
    }
    if (epoch !== contentFilterEpoch) return [];
    return results.flatMap(result =>
      result.status === 'fulfilled' ? result.value : []
    );
  }


  function searchContextForSlide(s) {
    // 固有の検索条件に紐づいた作品を別検索へ誤帰属させない。
    if (s?.queryKey) return searchRankPools.get(s.queryKey) || null;
    if (!searchConfig) return null;
    return getSearchRankContext(searchConfig, searchConfig.page);
  }

  function searchConfigForContext(ctx) {
    return ctx ? {...ctx.config} : null;
  }

  // 差し込み・テール双方で使う共通の資格判定/順位。通常の検索API経路だけで補充。
  async function searchBookmarkCandidates(
    ctx, config, excludedIds, source, previous, isCurrent, signal
  ) {
    if (!ctx || !isCurrent()) return null;
    let result = [];
    for (let n = 0; n <= 2; n++) {
      const available = await prepareSearchRankCandidates(
        ctx, excludedIds, isCurrent, signal
      );
      if (!available || !isCurrent()) return null;
      result = searchRankCandidates(ctx, available, {
        previous, source, onlyMatching: true,
        limit: INSERT_RECOMMENDATION_LIMIT
      });
      if (result.length >= INSERT_RECOMMENDATION_LIMIT || ctx.finished ||
        n === 2) break;
      const fetched = await loadSearchApiBatch(ctx, config, isCurrent, signal);
      if (!isCurrent() || fetched.stale) return null;
      if (fetched.error || !fetched.fetched) break;
    }
    return result;
  }


  function reorderSearchFeedTail(anchor, word) {
    if (mode !== 'search' || !slides.includes(anchor) || !feedEl) return;
    const ctx = searchContextForSlide(anchor);
    if (!ctx) return;
    const pos = slides.indexOf(anchor), slots = [];
    for (let i = pos + 1; i < slides.length; i++) {
      const s = slides[i];
      if (!s.isCurrent && !s.searchFixed &&
        s.seriesParentId !== String(anchor.id) &&
        !viewedThisSession.has(String(s.id)) &&
        s.isSearchApiHit === true && s.queryKey === ctx.queryKey) {
        slots.push(i);
      }
    }
    if (!slots.length) return;
    const sorted = searchRankCandidates(ctx,
      slots.map(i => slides[i]), {previous:[anchor],source:anchor}
    );
    if (sorted.length !== slots.length) return; // 資格を再検証、既存は落とさない
    slots.forEach((i,j) => { slides[i] = sorted[j]; });
    const top = feedEl.scrollTop;
    // 固定済みノードには触れず、実際に可動だったスロットだけを操作。
    const movable = new Set(slots);
    for (let i = slides.length - 1; i > pos; i--) {
      if (!movable.has(i)) continue;
      const node = slides[i].sectionEl;
      const following = slides[i + 1]?.sectionEl || null;
      if (node && node.nextElementSibling !== following) {
        feedEl.insertBefore(node, following);
      }
    }
    feedEl.scrollTop = top;
  }


  async function improveSearchFeedAfterBookmark(s) {
    if (!s || mode !== 'search' || !slides.includes(s) ||
      s.searchImprovePromise) return;
    const generation = feedGeneration;
    const ctx = searchContextForSlide(s);
    const config = searchConfigForContext(ctx);
    if (!ctx || !config) return;
    const valid = () => generation === feedGeneration &&
      mode === 'search' && slides.includes(s) &&
      searchContextValid(ctx);
    const work = (async () => {
      try {
        const excluded = [
          s.id, s.seriesNextId, ...slides.map(x => x.id),
          ...searchGrid.items.map(x => x.id)
        ];
        const chosen = await searchBookmarkCandidates(
          ctx, config, excluded, s, [s], valid
        );
        if (!valid() || chosen === null) return;
        s.searchInsertedIds = new Set(chosen.map(it => String(it.id)));
        if (chosen.length) {
          const current = slides[currentIndex()];
          const oldTop = feedEl.scrollTop;
          const height = Math.max(1, feedEl.clientHeight);
          let pos = slides.indexOf(s);
          if (slides[pos + 1]?.seriesParentId === String(s.id)) pos++;
          if (!valid()) return;
          insertSlidesAfter(pos,
            markSearchSlides(candidatesToSlides(chosen), ctx));
          if (current && current !== s && slides.includes(current)) {
            feedEl.scrollTop =
              slides.indexOf(current) * height + oldTop % height;
          }
        }
      } catch (e) {
        console.warn('[PTS search] 検索API差し込み失敗', e);
      } finally {
        if (valid()) {
          reorderSearchFeedTail(s, config.word);
          markCurrentFromScroll();
        }
      }
    })();
    s.searchImprovePromise = work;
    return work;
  }

  // 共通プールの未表示候補を現在の表示済みセットから除外して評価。
  async function buildSearchRankedBatch(
    ctx, previous = [], excludeIds = [], isCurrent = () => true, signal
  ) {
    const candidates = await prepareSearchRankCandidates(
      ctx, excludeIds, isCurrent, signal
    );
    if (!candidates || !isCurrent()) return null;
    return searchRankCandidates(ctx, candidates, { previous });
  }

  function searchGridThumbnail(it) {
    // APIが正方形URLを明示していれば優先。URLを推測で生成しない。
    const candidates = [it.urls?.square1200, it.square1200,
      it.urls?.square, it.url, it.urls?.small,
      it.urls?.regular, it.urls?.thumb];
    return candidates.find(url => typeof url === 'string' && url) || '';
  }

  function renderGridTags(body) {
    const bar = searchGrid.chips;
    bar.replaceChildren();
    const tags = findSearchTagCandidates(body, searchGrid.config.word);
    for (const tag of tags) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = `#${tag}`;
      chip.addEventListener('click', () => openSearchGrid(tag));
      bar.appendChild(chip);
    }
    bar.hidden = !tags.length;
  }

  function installGridSaveCSS() {
    if (document.getElementById('pts-grid-save-style')) return;
    const style = document.createElement('style');
    style.id = 'pts-grid-save-style';
    style.textContent = `
  #pts-overlay .pts-grid-item{position:relative;overflow:hidden}
  #pts-overlay .pts-grid-open{
    display:block;width:100%;height:100%;padding:0;margin:0;
    border:0;background:transparent;touch-action:manipulation
  }
  #pts-overlay .pts-grid-open img{
    display:block;width:100%;height:100%;object-fit:cover
  }
  #pts-overlay .pts-grid-save{
    position:absolute;top:6px;right:6px;z-index:2;
    min-width:30px;min-height:30px;border:1px solid #ffffff55;
    border-radius:999px;background:#000b;color:#fff;
    font-size:15px;touch-action:manipulation
  }
  #pts-overlay .pts-grid-bookmarked .pts-grid-save{
    background:#993653ee
  }
  #pts-overlay .pts-grid-heart{
    position:absolute;left:50%;top:50%;z-index:3;
    pointer-events:none;font-size:44px;
    animation:ptsHeart .85s ease-out forwards
  }
  `;
    document.head.appendChild(style);
  }

  function createSearchGridCard(it) {
    installGridSaveCSS();
    const id = String(it.id);
    const card = document.createElement('div');
    card.className = 'pts-grid-item';
    card.dataset.ptsId = id;

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'pts-grid-open';
    thumb.setAttribute('aria-label', it.title || `作品 ${id}`);

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    const src = searchGridThumbnail(it);
    const fallback = it.url || it.urls?.small || '';
    if (src) img.src = src;
    if (fallback && fallback !== src) {
      img.addEventListener('error', () => {
        img.src = fallback;
      }, { once: true });
    }
    thumb.appendChild(img);

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'pts-grid-save';
    save.textContent = '♡';
    save.setAttribute('aria-label', '作品を保存');
    save.addEventListener('click', e => {
      e.stopPropagation();
      clearGridTap();
      void saveGridArtwork(it, card, false);
    });

    thumb.addEventListener('click', () => {
      const now = performance.now();
      if (gridTap && gridTap.id === id && now - gridTap.time <= LIKE_TAP_WINDOW) {
        clearGridTap();
        void saveGridArtwork(it, card, true);
        return;
      }
      clearGridTap();
      const token = searchGrid.token;
      gridTap = {
        id, time: now,
        timer: setTimeout(() => {
          gridTap = null;
          if (searchGrid.open && token === searchGrid.token) {
            openGridArtwork(it);
          }
        }, LIKE_TAP_WINDOW)
      };
    });

    card.append(thumb, save);
    return card;
  }

  function appendGridCards(items, afterId = null) {
    const g = searchGrid;
    const fragment = document.createDocumentFragment();
    const accepted = [];

    for (const it of items) {
      if (!contentMatches(it)) continue;
      const id = String(it.id);
      const ctx = g.rankContext;
      if (!ctx || !searchContextValid(ctx) ||
          !ctx.searchHitIds.has(id) || !ctx.records.has(id) ||
          it.isSearchApiHit !== true || it.queryKey !== ctx.queryKey ||
          !/^\d+$/.test(id) || g.ids.has(id) ||
          isSeen(id) || knownBookmarkedIds.has(id) ||
          it.bookmarked) continue;

      g.ids.add(id);
      accepted.push(it);
      fragment.appendChild(createSearchGridCard(it));
    }

    if (!accepted.length) return;
    if (!g.fixedIds) g.fixedIds = new Set();
    accepted.forEach(it => g.fixedIds.add(String(it.id)));

    const anchor = afterId == null ? null :
      [...g.cards.children].find(el =>
        el.dataset.ptsId === String(afterId));

    if (anchor) {
      const index = g.items.findIndex(it =>
        String(it.id) === String(afterId));
      g.cards.insertBefore(fragment, anchor.nextSibling);
      g.items.splice(index + 1, 0, ...accepted);
    } else {
      g.cards.appendChild(fragment);
      g.items.push(...accepted);
    }
  }

  async function saveGridArtwork(it, card, byLike = false) {
    if (!searchGrid.open || card.dataset.saving === '1') return;

    const token = searchGrid.token;
    const badge = card.querySelector('.pts-grid-save');
    card.dataset.saving = '1';
    badge.disabled = true;
    badge.textContent = '…';

    if (byLike) {
      const heart = document.createElement('span');
      heart.className = 'pts-grid-heart';
      heart.textContent = '❤️';
      card.appendChild(heart);
      setTimeout(() => heart.remove(), 1100);
    }

    try {
      const s = candidatesToSlides([it])[0];
      if (!s) return;

      if (byLike) {
        learnFromWork(s.tags, s.userId, s.rawType, LEARN_LIKE_WEIGHT);
        s.tasteLearned = true;
      }

      const newlySaved = await ensureBookmarked(s);
      if (!searchGrid.open || token !== searchGrid.token) return;

      badge.textContent = '✓';
      card.classList.add('pts-grid-bookmarked');

      if (newlySaved || (byLike &&
          card.dataset.improved !== '1')) {
        await improveSearchGridAfterBookmark(it, card, token);
      }
    } catch (e) {
      console.warn('[PTS grid] 保存失敗', e);
      if (searchGrid.open && token === searchGrid.token) {
        badge.textContent = '♡';
      }
    } finally {
      delete card.dataset.saving;
      badge.disabled = card.classList.contains('pts-grid-bookmarked');
    }
  }


  // 画面に一度でも現れたカードは固定。表示中・既読・保存済みも移動しない。
  function lockVisibleSearchGridCards() {
    const g = searchGrid;
    if (!g.open || !g.cards) return;
    if (!g.fixedIds) g.fixedIds = new Set();
    // グリッドに一度追加されたカードは画面外も含めすべて固定。
    for (const el of g.cards.children) {
      g.fixedIds.add(String(el.dataset.ptsId));
    }
  }

  function reorderSearchGridTail(anchorId, word) {
    const g = searchGrid;
    if (!g.open || !g.cards) return;
    const ctx = g.rankContext;
    if (!ctx || !searchContextValid(ctx)) return;
    lockVisibleSearchGridCards();
    const pos = g.items.findIndex(it => String(it.id) === String(anchorId));
    if (pos < 0) return;
    const slots = [];
    for (let i = pos + 1; i < g.items.length; i++) {
      const it = g.items[i], id = String(it.id);
      if (!g.fixedIds.has(id) && !viewedThisSession.has(id) &&
        !isSeen(id) && !knownBookmarkedIds.has(id) &&
        it.isSearchApiHit === true && it.queryKey === ctx.queryKey) {
        slots.push(i);
      }
    }
    if (!slots.length) return;
    const sorted = searchRankCandidates(ctx, slots.map(i => g.items[i]),
      {previous: g.items.slice(Math.max(0,pos-1),pos+1),
       source:g.items[pos]});
    if (sorted.length !== slots.length) return;
    slots.forEach((i,j) => { g.items[i] = sorted[j]; });
    const nodes = new Map([...g.cards.children].map(
      el => [el.dataset.ptsId,el]
    ));
    const top = g.scroll.scrollTop;
    // 固定ノードを再接続しない。可動スロットのノードだけ操作。
    const movable = new Set(slots);
    for (let i = g.items.length - 1; i > pos; i--) {
      if (!movable.has(i)) continue;
      const node = nodes.get(String(g.items[i].id));
      const following = g.items[i + 1]
        ? nodes.get(String(g.items[i + 1].id)) : null;
      if (node && node.nextElementSibling !== following) {
        g.cards.insertBefore(node, following || null);
      }
    }
    g.scroll.scrollTop = top;
  }


  async function improveSearchGridAfterBookmark(it, card, token) {
    const g = searchGrid;
    if (card.dataset.improved === '1' || !g.config?.word) return;
    const ctx = g.rankContext;
    if (!ctx) return;
    card.dataset.improved = '1';
    const id = String(it.id);
    const valid = () => g.open && g.token === token &&
      g.rankContext === ctx && searchContextValid(ctx);
    try {
      const excluded = [
        id, ...g.ids, ...slides.map(s => s.id)
      ];
      const pos = g.items.findIndex(x => String(x.id) === id);
      const anchor = pos >= 0 ? g.items[pos] : it;
      const previous = pos >= 0
        ? g.items.slice(Math.max(0,pos-1),pos+1) : [anchor];
      const selected = await searchBookmarkCandidates(
        ctx, g.config, excluded, anchor, previous, valid, g.controller?.signal
      );
      if (!valid() || selected === null) return;
      lockVisibleSearchGridCards();
      if (!valid()) return;
      appendGridCards(selected, id);
    } catch (e) {
      console.warn('[PTS grid] 検索API差し込み失敗', e);
      delete card.dataset.improved;
    } finally {
      if (valid()) {
        reorderSearchGridTail(id, g.config.word);
        g.status.textContent = g.items.length + '件表示中';
      }
    }
  }

  async function searchGridLoadMore() {
    const g = searchGrid;
    if (!g.open || g.busy || g.finished || !g.config) return false;
    g.busy = true;
    g.retry.hidden = true;
    g.status.textContent = '読み込み中…';
    const token = g.token, config = g.config;
    const controller = new AbortController();
    g.controller = controller;
    const ctx = getSearchRankContext(config, g.page);
    g.rankContext = ctx;
    const valid = () => g.open && token === g.token &&
      g.config === config && searchContextValid(ctx);
    try {
      const loaded = await loadSearchApiBatch(
        ctx, config, valid, controller.signal
      );
      if (!valid() || loaded.stale) return false;
      if (!g.tagsReady && ctx.firstBody) {
        renderGridTags(ctx.firstBody);
        g.tagsReady = true;
      }
      const ranked = await buildSearchRankedBatch(
        ctx, g.items.slice(-2), [...g.ids], valid, controller.signal
      );
      if (!valid() || !ranked || controller.signal.aborted) return false;
      // 表示済みカードは移動せず、新規取得候補だけを末尾へ追加。
      if (!valid()) return false;
      appendGridCards(ranked);
      lockVisibleSearchGridCards();
      g.page = ctx.nextPage;
      g.finished = ctx.finished;
      if (loaded.error) {
        g.status.textContent =
          '読み込み失敗: ' + (loaded.error.message || loaded.error);
        g.retry.textContent = '再試行';
        g.retry.hidden = false;
      } else if (ctx.finished) {
        g.status.textContent = g.items.length ? g.items.length + '件' :
          contentEmptyMessage();
      } else {
        g.status.textContent = g.items.length + '件表示中';
        if (g.scroll.scrollHeight <= g.scroll.clientHeight + 4) {
          g.retry.textContent = '続きを取得';
          g.retry.hidden = false;
        }
      }
      return !loaded.error;
    } catch (e) {
      if (valid()) {
        g.status.textContent = '読み込み失敗: ' + (e.message || e);
        g.retry.textContent = '再試行';
        g.retry.hidden = false;
        console.warn('[PTS grid]', e);
      }
      return false;
    } finally {
      if (token === g.token) {
        g.busy = false;
        g.controller = null;
      }
    }
  }

  function openGridArtwork(it) {
    if (!searchGrid.open || !feedEl || !contentMatches(it)) return;

    const id = String(it?.id || '');
    if (!/^\d+$/.test(id)) return;

    const word = searchGrid.config?.word || '';
    const gridContext = searchGrid.rankContext;
    if (!gridContext || !searchContextValid(gridContext) ||
      !gridContext.searchHitIds.has(id) || !gridContext.records.has(id) ||
      !searchGrid.ids.has(id) || it.isSearchApiHit !== true ||
      it.queryKey !== gridContext.queryKey) return;
    const returnSnapshot = {
      queryKey: gridContext.queryKey,
      scrollTop: searchGrid.scroll.scrollTop
    };
    closeSearchGrid();

    let idx = slides.findIndex(s => String(s.id) === id);

    if (idx < 0) {
      const selected = candidatesToSlides([it])[0];
      if (!selected) return;

      selected.gridSearchWord = word;
      if (!markSearchSlides([selected], gridContext).length) return;

      if (slides.length) {
        insertSlidesAfter(
          Math.min(currentIndex(), slides.length - 1),
          [selected]
        );
      } else {
        addItems([selected]);
      }

      idx = slides.indexOf(selected);
    }

    if (mode === 'custom') customSeenIds.add(id);
    else {
      slides[idx].gridSearchWord = word;
      if (!markSearchSlides([slides[idx]], gridContext).length) return;
    }

    navIntent = { reason: 'other', until: 0 };
    feedEl.scrollTop = idx * feedEl.clientHeight;
    markCurrentFromScroll();
    gridReturnState = returnSnapshot;
    syncDock();
    void resolveSlide(slides[idx]);
  }

  function installSearchGridCSS() {
    const style = document.createElement('style');
    style.textContent = `
  #pts-overlay .pts-search-grid[hidden]{display:none!important}
  #pts-overlay.pts-grid-open .pts-feed{visibility:hidden;pointer-events:none}
  #pts-overlay.pts-grid-open .pts-search-tags{display:none!important}
  #pts-overlay .pts-search-grid{
    position:absolute;top:calc(63px + env(safe-area-inset-top));
    bottom:calc(73px + env(safe-area-inset-bottom));left:0;right:0;
    z-index:25;background:#0d0d11;color:#fff;
    display:flex;flex-direction:column
  }
  #pts-overlay .pts-grid-heading{
    display:flex;align-items:center;gap:8px;padding:10px 12px 4px;flex-shrink:0
  }
  #pts-overlay .pts-grid-title{
    flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:700
  }
  #pts-overlay .pts-grid-back,#pts-overlay .pts-grid-retry{
    flex:0 0 auto;background:#2a2a30;color:#fff;border:1px solid #ffffff30;border-radius:999px;padding:7px 10px;cursor:pointer;touch-action:manipulation
  }
  #pts-overlay .pts-grid-chips{
    display:flex;gap:6px;overflow-x:auto;padding:4px 10px 10px;
    flex-shrink:0;scrollbar-width:none;-webkit-overflow-scrolling:touch
  }
  #pts-overlay .pts-grid-chips[hidden]{display:none!important}
  #pts-overlay .pts-grid-chips button{
    flex:0 0 auto;white-space:nowrap;background:#35353c;color:#fff;
    border:1px solid #ffffff30;border-radius:999px;padding:7px 11px
  }
  #pts-overlay .pts-grid-scroll{
    flex:1;min-height:0;overflow-y:auto;padding:0 10px 10px;-webkit-overflow-scrolling:touch
  }
  #pts-overlay .pts-grid-cards{
    display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px
  }
  #pts-overlay .pts-grid-item{
    display:block;aspect-ratio:1/1;min-width:0;width:100%;padding:0;
    border:0;border-radius:2px;overflow:hidden;background:#202025;
    touch-action:manipulation;cursor:pointer
  }
  #pts-overlay .pts-grid-item img{
    display:block;width:100%;height:100%;object-fit:cover!important
  }
  #pts-overlay .pts-grid-footer{
    display:flex;flex-wrap:wrap;align-items:center;justify-content:center;
    gap:10px;padding:14px 4px;color:#bbb;font-size:12px
  }
  #pts-overlay .pts-grid-retry[hidden]{display:none!important}
  `;
    document.head.appendChild(style);
  }

  function installSearchGridUI() {
    if (searchGrid.root || !overlay) return;
    const root = document.createElement('section');
    root.className = 'pts-search-grid';
    root.hidden = true;
    root.setAttribute('aria-label', '検索グリッド');
    root.innerHTML = `
      <div class="pts-grid-heading">
        <span class="pts-grid-title"></span>
        <button type="button" class="pts-grid-back">フィードに戻る</button>
      </div>
      <div class="pts-grid-chips" hidden></div>
      <div class="pts-grid-scroll">
        <div class="pts-grid-cards"></div>
        <div class="pts-grid-footer">
          <span class="pts-grid-status"></span>
          <button type="button" class="pts-grid-retry" hidden>再試行</button>
        </div>
      </div>
    `;
    overlay.appendChild(root);
    Object.assign(searchGrid, {
      root, scroll: root.querySelector('.pts-grid-scroll'),
      cards: root.querySelector('.pts-grid-cards'),
      chips: root.querySelector('.pts-grid-chips'),
      title: root.querySelector('.pts-grid-title'),
      status: root.querySelector('.pts-grid-status'),
      retry: root.querySelector('.pts-grid-retry')
    });
    root.querySelector('.pts-grid-back').addEventListener('click', closeSearchGrid);
    searchGrid.retry.addEventListener('click', () => void searchGridLoadMore());
    searchGrid.scroll.addEventListener('scroll', () => {
      const el = searchGrid.scroll;
      lockVisibleSearchGridCards();
      if (el.scrollHeight - el.scrollTop - el.clientHeight <
        el.clientHeight * 1.5) void searchGridLoadMore();
    }, { passive: true });
    installSearchGridCSS();
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

  // 検索専用。1回の追加読み込みで最大3ページ取得。
  const SEARCH_BATCH_PAGES = 3;

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
      chip.textContent = `#${tag}`;

      chip.addEventListener('click', () => {
        window.location.assign(
          '/tags/' + encodeURIComponent(tag) + '/artworks'
        );
      });

      bar.appendChild(chip);
    }

    bar.hidden = false;
  }


  async function searchLoadMore() {
    if (mode !== 'search' || !searchConfig || searchBusy ||
      searchFinished || overlay?.style.display === 'none') return;
    if (Date.now() - searchLastFailure < 4000) return;
    searchBusy = true;
    const generation = feedGeneration;
    const config = searchConfig;
    const ctx = getSearchRankContext(config, searchPage);
    const valid = () => generation === feedGeneration &&
      mode === 'search' && searchConfig === config &&
      searchContextValid(ctx);
    try {
      const loaded = await loadSearchApiBatch(ctx, config, valid);
      if (!valid() || loaded.stale) return; // 取得後の世代検証
      if (!searchTagCandidates.length && ctx.firstBody) {
        searchTagCandidates = findSearchTagCandidates(ctx.firstBody, config.word);
        renderSearchTagCandidates();
      }
      const ids = new Set(slides.map(s => String(s.id)));
      const ranked = await buildSearchRankedBatch(
        ctx, slides.slice(-2), [...ids], valid
      );
      if (!valid() || !ranked) return; // 候補準備後の世代検証
      const selected = ranked.filter(it => {
        const id = String(it.id);
        if (ids.has(id) || isSeen(id) ||
          knownBookmarkedIds.has(id) || it.bookmarked) return false;
        ids.add(id);
        return true;
      });
      if (!valid()) return; // DOM反映直前の世代検証
      const first = slides.length === 0;
      if (selected.length) {
        addItems(markSearchSlides(candidatesToSlides(selected), ctx));
        if (first) markCurrentFromScroll();
      }
      searchPage = ctx.nextPage;
      searchFinished = ctx.finished;
      searchLastFailure = loaded.error ? Date.now() : 0;
      if (loaded.error) console.warn('[PTS search]', loaded.error);
      if (!slides.length && (ctx.finished || loaded.error)) {
        const counter = overlay?.querySelector('.pts-counter');
        if (counter) counter.textContent = loaded.error
          ? '検索取得失敗: ' + (loaded.error.message || loaded.error)
          : contentEmptyMessage();
      }
    } catch (e) {
      if (valid()) {
        searchLastFailure = Date.now();
        console.warn('[PTS search]', e);
      }
    } finally {
      if (generation === feedGeneration) { searchBusy = false; showContentEmpty(); }
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

  let csrfTokenSource = '';
  let csrfReadPromise = null;
  let csrfPreferHome = false;
  let lastBookmarkAttempt = null;
  let bookmarkToastTimer = null;

  function bookmarkSafeMessage(value) {
    let text = String(value ?? '');
    if (csrfToken) text = text.split(csrfToken).join('[非表示]');
    return text
      .replace(/(?:csrf[_-]?token|token|authorization)\s*[:=]\s*["']?[\w+\-/.]{8,}/ig,
        'token=[非表示]')
      .replace(/[A-Za-z0-9_\-]{32,}/g, '[非表示]')
      .replace(/[\r\n\t]+/g, ' ').slice(0, 120);
  }

  function recordBookmarkAttempt(result, stage, httpStatus, apiMessage) {
    lastBookmarkAttempt = {
      at: new Date().toLocaleString('ja-JP'), result, stage,
      httpStatus: httpStatus ?? null,
      apiMessage: bookmarkSafeMessage(apiMessage),
      tokenSource: csrfTokenSource || '未取得',
      tokenLength: csrfToken?.length || 0
    };
    updateBookmarkDiagnosticUI();
  }

  function bookmarkDiagnosticText() {
    const a = lastBookmarkAttempt;
    if (!a) return '9. ブックマーク送信: 未施行 (POST診断は実行しません)';
    const http = a.httpStatus == null
      ? '未到達' : String(a.httpStatus);
    return '9. ブックマーク送信: ' +
      `${a.result} / 段階=${a.stage} / HTTP=${http}` +
      ` / API=${a.apiMessage || 'なし'}` +
      ` / token取得元=${a.tokenSource} (${a.tokenLength}文字)` +
      ` / ${a.at}`;
  }

  function updateBookmarkDiagnosticUI() {
    const el = overlay?.querySelector('.pts-bookmark-last');
    if (el) el.textContent = bookmarkDiagnosticText();
  }

  function showBookmarkError(message) {
    const toast = overlay?.querySelector('.pts-bookmark-toast');
    if (!toast) return;
    toast.textContent = '保存に失敗しました: ' +
      bookmarkSafeMessage(message);
    toast.hidden = false;
    toast.classList.add('is-visible');
    clearTimeout(bookmarkToastTimer);
    bookmarkToastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
      toast.hidden = true;
    }, 4500);
  }

  class BookmarkError extends Error {
    constructor(stage, httpStatus, apiMessage) {
      super(bookmarkSafeMessage(apiMessage)
        || bookmarkStageLabel(stage));
      this.name = 'BookmarkError';
      this.stage = stage;
      this.httpStatus = httpStatus ?? null;
      this.apiMessage = bookmarkSafeMessage(apiMessage);
    }
  }

  function bookmarkStageLabel(stage) {
    return {
      token: 'トークン取得失敗',
      network: '通信エラー',
      http: 'HTTPエラー',
      response: '応答解析失敗',
      api: 'APIエラー'
    }[stage] || '保存に失敗しました';
  }

  function bookmarkFailure(
    stage, message, httpStatus = null, apiMessage = ''
  ) {
    const err = new Error(bookmarkSafeMessage(message));
    err.bookmarkStage = stage;
    err.httpStatus = httpStatus;
    err.apiMessage = bookmarkSafeMessage(apiMessage);
    return err;
  }

  function csrfValid(value) {
    return typeof value === 'string' &&
      /^[A-Za-z0-9_-]{10,128}$/.test(value);
  }

  function csrfParse(text) {
    try { return JSON.parse(text); }
    catch (e) { return null; }
  }

  function csrfFromDocument(doc, html, prefix) {
    const global = csrfParse(
      doc.querySelector('meta[name="global-data"]')
        ?.getAttribute('content') || ''
    );
    const globalToken =
      global?.token ||
      global?.csrfToken ||
      global?.userData?.token;
    if (csrfValid(globalToken)) {
      return {
        value: globalToken,
        source: prefix + '.global-data'
      };
    }

    const next = csrfParse(
      doc.querySelector('#__NEXT_DATA__')?.textContent || ''
    );
    const props = next?.props?.pageProps;

    let state = props?.serverSerializedPreloadedState;
    if (typeof state === 'string') {
      state = csrfParse(state);
    }

    const nextToken =
      state?.api?.token ||
      state?.api?.csrfToken ||
      props?.api?.token ||
      props?.csrfToken ||
      props?.token;

    if (csrfValid(nextToken)) {
      return {
        value: nextToken,
        source: prefix + '.__NEXT_DATA__'
      };
    }

    const matched = String(html || '').match(
      /["']token["']\s*:\s*["']([A-Za-z0-9_-]{10,128})["']/i
    );

    return csrfValid(matched?.[1])
      ? { value: matched[1], source: prefix + '.regex' }
      : null;
  }

  function gotoSlide(i, reason = 'other') {
    if (!feedEl || i < 0 || i >= slides.length || !contentMatches(slides[i])) return;

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
    if (csrfReadPromise) return csrfReadPromise;

    csrfReadPromise = (async () => {
      const page = () =>
        (csrfFromDocument(document, document.documentElement.outerHTML, 'page') ||
          csrfFromDocument(document, '', 'page'));

      const home = async () => {
        try {
          const res = await fetch('https://www.pixiv.net/', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store'
          });
          if (!res.ok) return null;
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          return csrfFromDocument(doc, html, 'home');
        } catch (e) {
          return null;
        }
      };

      // 直前にCSRF拒否された場合はトップページを先に確認。
      const hit = csrfPreferHome
        ? (await home() || page())
        : (page() || await home());

      csrfPreferHome = false;
      csrfToken = hit?.value || null;
      csrfTokenSource = hit?.source || '未取得';

      return csrfToken;
    })();

    try {
      return await csrfReadPromise;
    } finally {
      csrfReadPromise = null;
    }
  }

  function installBookmarkFeedback() {
    if (!overlay || overlay.querySelector('.pts-bookmark-toast')) return;

    const toast = document.createElement('div');
    toast.className = 'pts-bookmark-toast';
    toast.setAttribute('role', 'alert');
    toast.hidden = true;
    overlay.appendChild(toast);

    const panel = overlay.querySelector(
      '.pts-diag-panel .pts-diag-toolbar'
    );
    if (!panel) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pts-bookmark-diag';
    button.textContent = 'ブックマークの状態';
    button.addEventListener('click', () => {
      const el = overlay.querySelector('.pts-bookmark-last');
      if (!el) return;
      el.textContent = bookmarkDiagnosticText();
    });
    panel.appendChild(button);

    const last = document.createElement('div');
    last.className = 'pts-bookmark-last';
    last.textContent = bookmarkDiagnosticText();
    last.style.cssText =
      'white-space:normal;font:12px/1.5 monospace;' +
      'padding:8px 4px;color:#ddd;overflow-wrap:anywhere;';
    panel.after(last);

    const style = document.createElement('style');
    style.textContent = `
    #pts-overlay .pts-bookmark-toast[hidden]{
      display:none!important
    }
    #pts-overlay .pts-bookmark-toast{
      position:absolute;left:50%;
      bottom:calc(90px + env(safe-area-inset-bottom));
      transform:translateX(-50%);z-index:100;
      width:max-content;max-width:calc(100% - 24px);
      box-sizing:border-box;padding:12px 16px;
      background:#541923ee;border:1px solid #ff9baa;
      border-radius:12px;color:#fff;
      font-size:13px;line-height:1.5;
      text-align:center;pointer-events:none;
      box-shadow:0 4px 20px #000b;
      opacity:0;transition:opacity .25s ease;
    }
    #pts-overlay .pts-bookmark-toast.is-visible{
      opacity:1;
    }
    `;
    document.head.appendChild(style);
    updateBookmarkDiagnosticUI();
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
    if (s.bookmarkPromise) return s.bookmarkPromise;

    if (s.bookmarked || knownBookmarkedIds.has(id)) {
      s.bookmarked = true;
      knownBookmarkedIds.add(id);
      paintBookmarkBtn(s);
      syncSearchGridBookmark(id);
      return false;
    }

    const promise = (async () => {
      let stage = 'token';
      let status = null;
      try {
        const token = await getCsrfToken();
        if (!token) {
          throw bookmarkFailure('token', 'トークン取得失敗');
        }

        stage = 'network';
        let res;
        try {
          res = await fetch('/ajax/illusts/bookmarks/add', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json; charset=UTF-8',
              'x-csrf-token': token
            },
            body: JSON.stringify({ illust_id: id, restrict: 0 })
          });
        } catch (error) {
          if (csrfToken) {
            csrfToken = null;
            csrfTokenSource = '';
          }
          throw bookmarkFailure(
            'network', '通信エラー', null, bookmarkSafeMessage(error)
          );
        }

        status = res.status;
        stage = 'http';

        if (res.status === 401 || res.status === 403) {
          csrfPreferHome = true;
          csrfToken = null;
          csrfTokenSource = '';
        }

        stage = 'response';

        let json;
        try {
          json = await res.json();
        } catch (e) {
          throw bookmarkFailure(
            res.ok ? 'response' : 'http',
            res.ok ? 'JSON解析失敗' : `HTTP ${status}`,
            status, ''
          );
        }

        const message =
          json?.body?.bookmarked ? '' :
          json?.error?.message || json?.message || '';

        if (!res.ok) {
          throw bookmarkFailure(
            'http', `HTTP ${status}`, status, message
          );
        }

        stage = 'api';

        if (!json || typeof json !== 'object' ||
          json.error !== false) {
          throw bookmarkFailure(
            'api',
            message || 'API成功応答を確認できません',
            status, message
          );
        }

        recordBookmarkAttempt('成功', '完了', status, '');

        s.bookmarked = true;
        knownBookmarkedIds.add(id);
        paintBookmarkBtn(s);
        syncSearchGridBookmark(id);

        if (!s.tasteLearned && s.tags?.length) {
          learnFromWork(s.tags, s.userId, s.rawType, LEARN_BOOKMARK_WEIGHT);
          s.tasteLearned = true;
        }

        if (
          mode === 'search' &&
          slides.includes(s) &&
          !searchGrid.open
        ) {
          void improveSearchFeedAfterBookmark(s);
        }

        return true;
      } catch (err) {
        const step = err.bookmarkStage || stage;
        const http = err.httpStatus ?? status;
        const api = bookmarkSafeMessage(err.apiMessage);

        recordBookmarkAttempt(
          '失敗', step, http, api || err.message
        );

        if (step === 'http' && (http === 401 || http === 403)) {
          csrfPreferHome = true;
          csrfToken = null;
          csrfTokenSource = '';
        }

        const detail =
          step === 'token' ? 'トークン取得失敗'
          : step === 'http'
            ? `HTTP ${http}${api ? ' / ' + api : ''}`
            : step === 'api'
              ? `API: ${api || err.message}`
              : step === 'network' ? '通信エラー'
              : step === 'response' ? '応答形式エラー'
              : bookmarkSafeMessage(err.message);

        showBookmarkError(detail);
        throw err;
      }
    })();

    s.bookmarkPromise = promise;

    try {
      return await promise;
    } finally {
      if (s.bookmarkPromise === promise) {
        s.bookmarkPromise = null;
      }
    }
  }

  // ブックマークした作品のおすすめを、その作品の直後に最大12件差し込む
  async function insertSeriesAfter(s) {
    // シリーズ続編は検索APIヒット資格がないため検索系では追加しない。
    if (mode === 'search' || !s || s.seriesInsertStarted ||
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

      if (!next || !contentMatches(next) ||
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
      item.rawType = contentEnum(next.illustType);
      item.xRestrict = contentEnum(next.xRestrict);
      item.contentFilterEpoch = contentFilterEpoch;
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
    if (!s || s.recommendInsertStarted || !slides.includes(s)) return;

    s.recommendInsertStarted = true;
    const generation = feedGeneration;

    try {
      if (!s.resolved && !s.tags?.length) {
        await resolveSlide(s);
      }

      if (generation !== feedGeneration || !slides.includes(s)) return;

      const candidates = await fetchBookmarkRelatedCandidates(s.id);

      const ranked = await prepareCandidates(candidates, {
        excludeIds: [s.id, s.seriesNextId, ...seenTimes.keys()]
          .filter(Boolean),
        enrichTop: 16
      });

      if (generation !== feedGeneration ||
        !feedEl || !slides.includes(s)) return;

      const existing = new Set(slides.map(x => String(x.id)));

      const available = ranked.filter(it => {
        const id = String(it.id);
        if (existing.has(id) || isSeen(id) ||
          knownBookmarkedIds.has(id) ||
          it.bookmarked) return false;
        existing.add(id);
        return true;
      });

      let pos = slides.indexOf(s);
      const next = slides[pos + 1];
      const seriesNext = next?.seriesParentId === String(s.id)
        ? next : null;

      const sorted = diversifyBookmarkRecommendations(
        available, s, seriesNext ? [s, seriesNext] : [s],
        INSERT_RECOMMENDATION_LIMIT
      );

      const selected = sorted.slice(0, 12);
      if (!selected.length) return;

      const current = slides[currentIndex()];
      const oldTop = feedEl.scrollTop;
      const height = Math.max(1, feedEl.clientHeight);

      if (seriesNext) pos++;
      insertSlidesAfter(pos, candidatesToSlides(selected));

      if (current && current !== s && slides.includes(current)) {
        feedEl.scrollTop =
          slides.indexOf(current) * height + oldTop % height;
      }

      markCurrentFromScroll();
    } catch (e) {
      console.warn('[PTS] 関連差し込み失敗:', e);
      s.recommendInsertStarted = false;
    }
  }


  // スライドの後片付け（タイマー・通信・Blobを残さない。長時間閲覧でのメモリ圧迫対策）
  function cleanupSlide(s) {
    stopUgoira(s);
    s.ugoiraPlayer=null;
    s.animSeekMs=null;
    s.ugoiraCanvas?.remove();
    s.ugoiraCanvas=null;
    s.sectionEl?.querySelector('.pts-holder')?.classList.remove('pts-ugoira-active');
    if (s.loadWatch) { clearTimeout(s.loadWatch); s.loadWatch = null; }
    if (s.ugoiraAbort) { try { s.ugoiraAbort.abort(); } catch (e) {} s.ugoiraAbort = null; }
    if (s.resolveAbort) { try { s.resolveAbort.abort(); } catch (e) {} }
    dropUgoiraTween(s);
    if (s.tweenBtn) s.tweenBtn.hidden = true;
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

      dropUgoiraTween(s);
      s.frameUrls = null;
      s.ugoiraPlayer = null;
      s.animSeekMs = null;
      s.ugoiraCanvas?.remove();
      s.ugoiraCanvas = null;
      s.sectionEl?.querySelector('.pts-holder')?.classList.remove('pts-ugoira-active');
      s.frames = null;
      s.pairs = null;
      s.zipUrl = null;
      s.zipSmall = null;
      s.zipFull = null;
      s.hiDone = false;
      s.animIdx = 0;
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
    cancelSearchDiagnostic();
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
    diagAppend(seq,bookmarkDiagnosticText());
    diagAppend(seq,ugoiraTweenDiagnosticText());
    diagAppend(seq,
      `ログインID検出: ${getMyUserId() ? 'OK' : '失敗'}` +
      ` / 取得元=${loginIdDetection.source}` +
      ` / 保存値=${loginIdDetection.saved ? 'あり' : 'なし'}` +
      (loginIdDetection.saveError ? ' / 保存失敗' : '')
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
  /* ---------- 検索ランキング診断（閲覧状態には書き込まない） ---------- */
  const SEARCH_DIAG_PAGES = 3;
  const SEARCH_DIAG_BANDS = [5, 3, 7];
  const SEARCH_DIAG_LAMBDAS = [3, 1, 5];
  const SEARCH_DIAG_RELEVANCE_CAP = 400;
  let searchDiagnostic = null;
  let searchDiagnosticGeneration = 0;

  function searchApiUrl(config, page) {
    const conditions = searchApiConditions(config);
    const params = new URLSearchParams({...conditions, p: String(page)});
    return '/ajax/search/artworks/' +
      encodeURIComponent(conditions.word) + '?' + params;
  }

  function searchDiagnosticContext() {
    const config = searchGrid.open ? searchGrid.config :
      mode === 'search' ? searchConfig : null;
    if (!config || !overlay || overlay.style.display === 'none') return null;
    return {search: {word: config.word, order: config.order || 'popular_d',
      searchMode: config.searchMode, matchMode: config.matchMode},
    grid: searchGrid.open, token: searchGrid.token, feed: feedGeneration,
    route: location.href};
  }


  // 診断と本番で共用する4段階tierと直接一致の証拠。
  function searchDiagnosticMatch(it, word) {
    const query = searchNormalize(word);
    const tokens = [...new Set(query.split(/\s+/u).filter(Boolean))];
    const title = searchNormalize(it.title), tags = normTags(it.tags).map(searchNormalize);
    const tokenEvidence = tokens.map(token => ({
      token, exactTags: tags.filter(t => t === token),
      partialTags: tags.filter(t => t !== token && t.includes(token)),
      titleContains: title.includes(token)
    }));
    const coverageCount = tokenEvidence.filter(e =>
      e.exactTags.length || e.partialTags.length || e.titleContains).length;
    const exactTagTokenCount = tokenEvidence.filter(e => e.exactTags.length).length;
    const titleTokenCount = tokenEvidence.filter(e => e.titleContains).length;
    const partialTagTokenCount = tokenEvidence.filter(e => e.partialTags.length).length;
    const titleContainsQuery = !!query && title.includes(query);
    const exactTagMatches = tags.filter(t => t === query);
    const partialTagMatches = tags.filter(t => t !== query && t.includes(query));
    const multi = tokens.length > 1;
    const tier = multi ? (coverageCount === tokens.length ?
      (exactTagTokenCount ? 3 : 2) : coverageCount ? 1 : 0) :
      (titleContainsQuery && exactTagMatches.length ? 3 : exactTagMatches.length ? 2 :
       titleContainsQuery || partialTagMatches.length ? 1 : 0);
    return {
      tier, tierReason: (multi ? 'multi-token' : 'single-token') + ':tier-' + tier,
      appliedRule: multi ? 'multi-token' : 'single-token', titleContainsQuery,
      titleExactQuery: !!query && title === query, exactTagMatches, partialTagMatches,
      coverageCount, coverageTotal: tokens.length,
      coverageRatio: tokens.length ? coverageCount / tokens.length : 0,
      exactTagTokenCount, titleTokenCount, partialTagTokenCount,
      directRelevanceKey: [coverageCount, exactTagTokenCount,
        titleTokenCount, partialTagTokenCount],
      tokenEvidence, ruleVersion: '3.13.18'
    };
  }

  // Raw/Softは実験専用。履歴・tasteScore本体は変更しない。
  function searchDiagnosticTasteVariants(taste) {
    const tagCap = 30, authorCap = 27;
    const soft = (v, cap) => v <= cap
      ? v : cap + cap * (1 - Math.exp(-(v-cap)/cap));
    const common = taste.ugoira + taste.r18 +
      taste.other;
    return {
      raw: Math.max(0, taste.tagRaw + taste.authorRaw + common),
      soft: Math.max(0,
        soft(taste.tagRaw, tagCap) + soft(taste.authorRaw, authorCap) + common),
      rule: 'diagnostic-only; raw uncapped; soft=cap+cap*(1-exp(-(raw-cap)/cap)); negative feedback removed'
    };
  }

  function searchDiagnosticSaturation(rows) {
    // 同じ作品が複数ページに現れても飽和率を二重計上しない。
    const seen = new Set();
    const uniqueRows = rows.filter(row => {
      const id = String(row.api.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const n = uniqueRows.length;
    const totals = uniqueRows.map(r => r.taste.total);
    const top = n ? Math.max(...totals) : null;
    const topTied = top === null ? 0 : totals.filter(v => v === top).length;
    const tag = uniqueRows.filter(r => r.taste.tagRaw >= 30).length;
    const author = uniqueRows.filter(r => r.taste.authorRaw >= 27).length;
    const both = uniqueRows.filter(r => r.taste.tagRaw >= 30 &&
      r.taste.authorRaw >= 27).length;
    return {
      sampleSize: n, rawApiRows: rows.length, maxObservedTotal: top,
      maxObservedTotalTieCount: topTied,
      maxObservedTotalTieRate: n ? topTied / n : 0,
      exactly25Count: totals.filter(v => v === 25).length,
      tagCap: 30, tagAtOrOverCap: tag, tagSaturationRate: n ? tag / n : 0,
      authorCap: 27, authorAtOrOverCap: author,
      authorSaturationRate: n ? author / n : 0,
      bothAtOrOverCap: both,
      anyComponentSaturationCount: tag + author - both,
      anyComponentSaturationRate: n ? (tag + author - both) / n : 0,
      note: 'Observed maximum is not a theoretical cap; totals reflect positive signals'
    };
  }


  function rankSearchDiagnostic(result) {
    const rows = result.candidates;
    const tie = (a, b) => a.api.apiOrder - b.api.apiOrder;
    const tier = (a, b) => b.match.tier - a.match.tier;
    const taste = (a, b) => b.taste.total - a.taste.total;
    const rel = (a, b) => b.relevance.legacyTotal - a.relevance.legacyTotal;
    const direct = (a, b) => {
      for (let i = 0; i < 4; i++) {
        const d = b.match.directRelevanceKey[i] -
          a.match.directRelevanceKey[i];
        if (d) return d;
      }
      return 0;
    };
    // A-directは本番と同一の単一比較関数を使う。
    const productionModel = row => ({
      tier: row.match.tier, taste: row.taste.total,
      directRelevanceKey: row.match.directRelevanceKey,
      apiOrder: row.api.apiOrder
    });
    const models = {
      rankA: (a, b) => tier(a,b) || taste(a,b) || rel(a,b) || tie(a,b),
      rankADirect: (a,b) => compareSearchRank(productionModel(a), productionModel(b)),
      rankALegacy: (a,b) => tier(a,b) || taste(a,b) || rel(a,b) || tie(a,b),
      rankATasteRaw: (a,b) => tier(a,b) ||
        b.tasteVariants.raw - a.tasteVariants.raw || direct(a,b) || tie(a,b),
      rankATasteSoft: (a,b) => tier(a,b) ||
        b.tasteVariants.soft - a.tasteVariants.soft || direct(a,b) || tie(a,b)
    };
    for (const width of SEARCH_DIAG_BANDS) models['rankB' + width] = (a,b) =>
      tier(a,b) || Math.floor(b.taste.total / width) - Math.floor(a.taste.total / width) ||
      rel(a,b) || taste(a,b) || tie(a,b);
    for (const weight of SEARCH_DIAG_LAMBDAS) models['rankC' + weight] = (a,b) =>
      tier(a,b) || (b.taste.total + weight * b.relevance.legacyTotal / SEARCH_DIAG_RELEVANCE_CAP) -
      (a.taste.total + weight * a.relevance.legacyTotal / SEARCH_DIAG_RELEVANCE_CAP) || tie(a,b);
    result.modelRanks = {};
    for (const [name, compare] of Object.entries(models)) {
      result.modelRanks[name] = rows.slice().sort(compare).map((row, i) => {
        row[name] = i + 1;
        return {apiOrder: row.api.apiOrder, id: row.api.id, rank: i + 1};
      });
    }

    // 同じ候補・同じ事前計算済みtaste値で診断A-directと
    // 本番モデルAの分散前後を比較する。再計算しない。
    const firstById = new Map();
    for (const row of rows) {
      const id = String(row.api.id);
      if (!id || firstById.has(id)) continue;
      firstById.set(id, row);
    }
    const eligibleRows = [...firstById.values()].filter(row => {
      const e = row.feedEligibility;
      return !e.alreadyDisplayed && !e.seen &&
        !e.stronglySkipped && !e.knownBookmarked &&
        !e.apiBookmarked && !e.feedbackExcluded;
    });
    const preparedRows = eligibleRows.map(row => ({
      id: String(row.api.id),
      it: { id: String(row.api.id) },
      meta: { id: String(row.api.id),
        userId: row.api.userId, tags: row.api.tags },
      tier: row.match.tier,
      taste: row.taste.total,
      directRelevanceKey: row.match.directRelevanceKey,
      apiOrder: row.api.apiOrder
    }));
    const before = orderSearchRankRows(preparedRows, {diversify:false});
    const after = orderSearchRankRows(preparedRows, {diversify:true});
    const rankList = arr => arr.map((it,i) => ({
      id: String(it.id), rank: i + 1
    }));
    result.modelRanks.rankADirectBeforeDiversity = rankList(before);
    result.modelRanks.rankADirectAfterDiversity = rankList(after);

    // 診断rankADirectの同一適格作品集合を、同一の計算済みtasteで比較。
    // 全API行の順位からの抽出だと別スナップショット/重複行に依存する。
    const directSubset = eligibleRows.slice().sort((a,b) =>
      compareSearchRank(productionModel(a), productionModel(b))
    ).map(row => String(row.api.id));
    const beforeIds = before.map(it => String(it.id));
    const afterIds = after.map(it => String(it.id));
    const sameInputOrder =
      JSON.stringify(directSubset) === JSON.stringify(beforeIds);
    result.productionComparable = {
      queryKey: searchQueryKey(result.search),
      eligibleCount: preparedRows.length,
      tasteSource: 'diagnostic precomputed taste.total (no recomputation)',
      diagnosticADirectEligibleIds: directSubset,
      beforeDiversityIds: beforeIds,
      afterDiversityIds: afterIds,
      sameInputOrder,
      scope: 'same eligible unique search API hits, same taste values'
    };
    if (!sameInputOrder) result.errors.push({
      page: null, code: 'a-direct-production-comparator-mismatch'
    });
    result.saturation = searchDiagnosticSaturation(rows);
    result.counts = {
      candidates: rows.length,
      uniqueIds: new Set(rows.map(r => r.api.id)).size,
      duplicates: rows.filter(r => r.api.duplicateOf !== null).length
    };
  }

  function searchDiagnosticJson() {
    if (searchDiagnostic?.result) searchDiagnostic.result.contextCurrent =
      JSON.stringify(searchDiagnostic.context) === JSON.stringify(searchDiagnosticContext());
    return searchDiagnostic?.result ? JSON.stringify(searchDiagnostic.result,
      (key, value) => typeof value === 'number' && !Number.isFinite(value) ? null : value, 2) : '';
  }

  function renderSearchDiagnostic() {
    const out = overlay?.querySelector('.pts-diag-output');
    if (out && searchDiagnostic?.result) out.value = searchDiagnosticJson();
  }

  function cancelSearchDiagnostic(reason = 'cancelled') {
    const run = searchDiagnostic;
    if (!run?.running) return;
    run.running = false;
    run.controller.abort();
    run.result.errors.push({page: run.page, code: reason});
    run.result.status = run.result.completedPages.length ? 'partial' : 'failed';
    renderSearchDiagnostic();
  }

  async function runSearchDiagnostic() {
    cancelSearchDiagnostic('superseded');
    const context = searchDiagnosticContext();
    const generation = ++searchDiagnosticGeneration;
    const search = context?.search || null;
    const result = {schemaVersion: '1.1.0', scriptVersion: '3.13.22',
      capturedAt: new Date().toISOString(), diagnosticId: 'search-' + Date.now() + '-' + generation,
      search, requestedPages: Array.from({length: SEARCH_DIAG_PAGES}, (_, i) => i + 1),
      completedPages: [], apiTotal: null, relatedTags: [],
      queryTokens: search ? searchDiagnosticMatch({}, search.word).tokenEvidence.map(e => e.token) : [],
      tokenizationRule: 'NFKC; trim; locale lowercase; whitespace split; unique tokens',
      counts: {}, status: 'failed', errors: [], candidates: []};
    const run = {result, context, generation, controller: new AbortController(), running: true, page: null};
    searchDiagnostic = run;
    const current = () => run === searchDiagnostic && run.running &&
      generation === searchDiagnosticGeneration &&
      JSON.stringify(context) === JSON.stringify(searchDiagnosticContext());
    const timer = setInterval(() => {
      if (run.running && !current()) cancelSearchDiagnostic('context-changed');
    }, 100);
    const displayed = new Set([...slides, ...searchGrid.items].map(it => String(it.id)));
    const ids = new Map();
    try {
      if (!context) { result.errors.push({page: null, code: 'no-active-search'}); return; }
      for (const page of result.requestedPages) {
        run.page = page;
        if (!current()) { cancelSearchDiagnostic('context-changed'); break; }
        const body = await fetchJson(searchApiUrl(search, page), run.controller.signal);
        if (!current()) { cancelSearchDiagnostic('context-changed'); break; }
        const data = body?.illustManga?.data;
        if (!Array.isArray(data)) throw new Error('invalid-candidates');
        result.apiTotal = body.illustManga.total == null ? null : Number(body.illustManga.total);
        result.relatedTags = [...new Set([...result.relatedTags, ...searchRelatedTags(body)])];
        for (const [index, raw] of data.entries()) {
          const it = normalizeSearchCandidate(raw);
          const apiOrder = result.candidates.length;
          const taste = {};
          tasteScore(it, taste);
          const sum = taste.tagCapped + taste.authorCapped + taste.ugoira + taste.r18 +
            taste.other;
          if (Math.abs(sum - taste.total) > 1e-9 || !Number.isFinite(sum))
            result.errors.push({page, apiOrder, code: 'taste-sum-mismatch'});
          result.candidates.push({api: {id: String(it.id), apiPage: page,
            apiIndexInPage: index, apiOrder, title: typeof raw.title === 'string' ? raw.title : null,
            tags: it.tags, userId: it.userId, illustType: it.illustType,
            bookmarked: it.bookmarked, bookmarkStateKnown: it.bookmarkStateKnown,
            dataAvailability: {title: typeof raw.title === 'string', tags: raw.tags != null,
              userId: raw.userId != null, illustType: raw.illustType != null},
            duplicateOf: ids.has(it.id) ? ids.get(it.id) : null},
          match: searchDiagnosticMatch(it, search.word), legacy: {matchTier: legacySearchWordTier(it, search.word)},
          taste, tasteVariants: searchDiagnosticTasteVariants(taste), relevance: null,
          feedEligibility: {alreadyDisplayed: displayed.has(it.id), seen: isSeen(it.id),
            knownBookmarked: knownBookmarkedIds.has(it.id),
            apiBookmarked: it.bookmarked},
          humanEvaluation: {relevance: null, taste: null, centralityReason: null, notes: null}});
          if (!ids.has(it.id)) ids.set(it.id, apiOrder);
        }
        result.completedPages.push(page);
        renderSearchDiagnostic();
      }
    } catch (e) {
      // レスポンス本文・URL・例外メッセージは出力しない。
      if (run.running) result.errors.push({page: run.page,
        code: e?.name === 'AbortError' ? 'aborted' : 'request-or-processing-failed'});
    } finally {
      clearInterval(timer);
      for (const row of result.candidates) {
        const tags = [...new Set(row.api.tags.map(t => t.normalize('NFKC').toLocaleLowerCase()))];
        const query = search.word.normalize('NFKC').trim().toLocaleLowerCase();
        const exactTagContribution = Math.min(8, tags.filter(t => t.includes(query)).length) * SEARCH_WORD_TAG_WEIGHT;
        const relatedTagsUsed = tags.filter(t => t !== query && result.relatedTags.includes(t));
        const relatedTagContribution = Math.min(8, relatedTagsUsed.length) * SEARCH_RELATED_TAG_WEIGHT;
        row.relevance = {legacyTotal: searchWordRelevance(row.api, search.word, result.relatedTags),
          exactTagContribution, relatedTagContribution,
          capped: exactTagContribution + relatedTagContribution > SEARCH_DIAG_RELEVANCE_CAP,
          relatedTagsUsed, exactTagContributionRule: 'legacy substring tag matches'};
      }
      result.status = result.completedPages.length === SEARCH_DIAG_PAGES && !result.errors.length ?
        'complete' : result.completedPages.length ? 'partial' : 'failed';
      run.running = false;
      if (search) rankSearchDiagnostic(result);
      if (run === searchDiagnostic) renderSearchDiagnostic();
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
          <button type="button" class="pts-search-diag-run">検索ランキング診断を実行</button>
          <button type="button" class="pts-search-diag-copy">診断JSONをコピー</button>
          <button type="button" class="pts-search-diag-save">診断JSONをファイル保存</button>
          <button type="button" class="pts-search-diag-cancel">診断をキャンセル</button>
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
    panel.querySelector('.pts-search-diag-run').onclick = () => { void runSearchDiagnostic(); };
    panel.querySelector('.pts-search-diag-cancel').onclick = () => cancelSearchDiagnostic();
    panel.querySelector('.pts-search-diag-copy').onclick = () => {
      renderSearchDiagnostic();
      if (searchDiagnostic && !searchDiagnostic.running) void copyDiagnosticReport();
    };
    panel.querySelector('.pts-search-diag-save').onclick = () => {
      if (searchDiagnostic?.running) return;
      const json = searchDiagnosticJson();
      if (!json) return;
      const url = URL.createObjectURL(new Blob([json], {type: 'application/json;charset=utf-8'}));
      const a = document.createElement('a');
      a.href = url; a.download = searchDiagnostic.result.diagnosticId + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

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
        flex-wrap: wrap;
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
    if (!contentFilterConfirmed) { showContentFilterDialog(true); return; }

    buildOverlay();
    installDiagnosticUI();
    installBookmarkFeedback();
    installExperienceUI();
    installSeriesUI();
    installSeriesLayer();
    bindUserNavigationIntent();


    viewedThisSession.clear();
    navIntent = { reason: 'other', until: 0 };

    sessionTrail.length = 0;
    activeView = null;

    searchConfig = getSearchPageConfig();
    mode = searchConfig ? 'search' : 'custom';
    gridReturnState = null;

    overlay.style.display = 'block';
    keepAwake(true);

    if (mode === 'search') {
      void startSearchFeed();
    } else {
      renderSearchTagCandidates();
      void startCustomFeed();
    }
  }

  function closeViewer() {
    if (contentFilterDialog) { contentFilterDialog.close(); contentFilterDialog.remove(); contentFilterDialog=null; }
    if (!overlay) return;
    tickViewing();
    finishViewing(activeView, false);
    clearTimeout(viewSaveTimer);
    viewSaveTimer = null;
    saveProfile();
    gridReturnState = null;
    closeSearchGrid(false);
    seriesCloseLayer();
    seriesHideList();
    closeDiagnosticPanel();
    clearTimeout(bookmarkToastTimer);
    const toast = overlay.querySelector('.pts-bookmark-toast');
    if (toast) {
      toast.classList.remove('is-visible');
      toast.hidden = true;
    }
    lastTap = null;
    touchStart = null;
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
    resetSessionLearning();
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
      if (routeAutoStartSuppressed) return;
      requestAnimationFrame(() => {
        const current =
          location.pathname + location.search;

        if (current !== route) return;
        if (routeAutoStartSuppressed) return;
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
      if (routeAutoStartSuppressed) return;
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
  // SPA遷移も監視するが、ユーザーが閉じた後は手動起動のみ。
  installRouteAutoStart();
})();
