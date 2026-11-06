// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      3.4.1
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
  let curObs = null;
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

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const json = await res.json();
    if (json.error) throw new Error(json.message || 'api error');
    return json.body;
  }

  async function resolveSlide(s) {
    if (s.resolved || s.resolving) return;
    s.resolving = true;
    try {
      const body = await fetchJson(`/ajax/illust/${s.id}`);
      s.rawType = body.illustType;
      if (body.title && !s.title) { s.title = body.title; if (s.titleEl) s.titleEl.textContent = s.title; }
      if (body.userName) { s.author = body.userName; if (s.authorEl) s.authorEl.textContent = s.author; }
      const pageCount = body.pageCount || 1;
      if (body.illustType === 2) {
        // pixivの種別コード: 0=イラスト / 1=マンガ / 2=うごイラ
        s.kind = 'ugoira';
        try {
          const meta = await fetchJson(`/ajax/illust/${s.id}/ugoira_meta`);
          s.zipUrl = meta.src || meta.originalSrc || null;
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
      s.kind = 'single';
      s.resolveError = (e && e.message) ? e.message : String(e);
      const u = upgradeUrl(s.thumb) || s.thumb;
      s.pairs = [{ r: u, o: u }];
    }
    s.resolved = true;
    s.resolving = false;
    applyResolved(s);
    upgradeSlide(s);
  }

  // 表示レベルに応じて画像を差し替える：表示中は元画像（quality=orig時）、近くは1200px
  function levelUrl(s, pair) {
    if (!pair) return s.thumb;
    if (s.isCurrent && quality === 'orig') return pair.o || pair.r;
    return pair.r || pair.o;
  }

  function upgradeSlide(s) {
    if (!s.resolved || !s.pairs) return;
    const holder = s.sectionEl && s.sectionEl.querySelector('.pts-holder');
    if (!holder) return;
    if (s.kind === 'multi') {
      const imgs = holder.querySelectorAll('.pts-page img');
      imgs.forEach((im, i) => {
        const pair = s.pairs[i];
        if (!pair) return;
        const target = levelUrl(s, pair);
        if (target && im.getAttribute('src') !== target && !im.src.includes(target)) im.src = target;
      });
      s.mainImg = imgs[0] || s.mainImg;
    } else {
      const pair = s.pairs[0];
      const target = levelUrl(s, pair);
      if (s.mainImg && target) {
        const cur = s.mainImg.getAttribute('src') || '';
        if (!cur.includes(target)) s.mainImg.src = target;
      }
      if (s.kind === 'ugoira') prepareUgoira(s);
    }
  }


  /* ---------- うごイラ（ZIP展開してアニメーション） ---------- */

  // raw deflate 解凍（SafariのDecompressionStreamがdeflate-raw非対応のため自前実装。検証済み）
  function inflateRaw(bytes) {
    let pos = 0;
    const bit = () => { const b = (bytes[pos >> 3] >> (pos & 7)) & 1; pos++; return b; };
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
            const len = LEN_BASE[li] + bits(LEN_EXT[li]);
            const dsym = decode(distHuff);
            const dist = DIST_BASE[dsym] + bits(DIST_EXT[dsym]);
            const start = out.length - dist;
            for (let i = 0; i < len; i++) out.push(out[start + i]);
          }
        }
      }
    }
    return new Uint8Array(out);
  }

  async function unzipFrames(zipUrl, frames) {
    let res;
    try {
      res = await fetch(zipUrl);
    } catch (e) {
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
    for (const f of frames) {
      const ent = byName.get(f.file);
      if (!ent) { urls.push(null); continue; }
      const raw = new Uint8Array(buf, ent.dataOff, ent.compSize);
      let bytes = raw;
      if (ent.method === 8) {
        bytes = inflateRaw(raw);
      }
      const mime = /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg';
      urls.push(URL.createObjectURL(new Blob([bytes], { type: mime })));
    }
    return urls;
  }

  function startUgoira(s) {
    if (s.animTimer || !s.frameUrls) return;
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
    s.animIdx = idx;
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
    if (s.isCurrent) setChip(s, 'うごイラ準備中…');
    try {
      // 第1候補：ZIPを自前で展開する（pixiv公式と同じ方式）
      if (s.zipUrl) {
        try {
          s.frameUrls = await unzipFrames(s.zipUrl, s.frames);
        } catch (e) {
          throw new Error('ZIP展開失敗: ' + (e && e.message ? e.message : e));
        }
        const valid = s.frameUrls.filter(Boolean).length;
        if (valid === 0) throw new Error('フレーム0枚');
        if (s.isCurrent) startUgoira(s);
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
      if (s.isCurrent) setChip(s, 'うごイラ: ' + (e && e.message ? e.message : e));
      s.ugoiraError = (e && e.message) ? e.message : String(e);
    } finally {
      s.preparingUgoira = false;
    }
  }

  /* ---------- 表示 ---------- */

  function applyResolved(s) {
    if (!s.sectionEl) return;
    const holder = s.sectionEl.querySelector('.pts-holder');
    if (!holder) return;
    holder.innerHTML = '';
    if (s.kind === 'multi' && s.pairs && s.pairs.length > 1) {
      const pager = document.createElement('div');
      pager.className = 'pts-pager';
      s.pairs.forEach((pair, i) => {
        const pg = document.createElement('div');
        pg.className = 'pts-page';
        const im = document.createElement('img');
        im.className = 'pts-img';
        im.src = i === 0 ? (pair.r || pair.o) : (pair.r || pair.o);
        im.loading = i === 0 ? 'eager' : 'lazy';
        im.alt = s.title || '';
        pg.appendChild(im);
        pager.appendChild(pg);
      });
      pager.addEventListener('scroll', () => {
        const idx = Math.round(pager.scrollLeft / pager.clientWidth);
        if (s.pageChip) s.pageChip.textContent = `${idx + 1} / ${s.pairs.length}`;
      }, { passive: true });
      holder.appendChild(pager);
      if (s.pageChip) {
        s.pageChip.style.display = 'block';
        s.pageChip.textContent = `1 / ${s.pairs.length}`;
      }
      s.mainImg = pager.querySelector('img');
    } else {
      const im = document.createElement('img');
      im.className = 'pts-img';
      const pair = s.pairs && s.pairs[0];
      im.src = (pair && (pair.r || pair.o)) || s.thumb;
      im.alt = s.title || '';
      im.addEventListener('error', () => {
        if (s.thumb && !im.src.includes(s.thumb)) im.src = s.thumb;
      });
      holder.appendChild(im);
      s.mainImg = im;
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
    // 仮表示は軽いサムネイル。本番画像は見える位置に来てから読み込む
    ph.src = s.thumb || upgradeUrl(s.thumb);
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

    feedEl.appendChild(sec);
    if (nearObs) nearObs.observe(sec);
    if (curObs) curObs.observe(sec);
  }

  /* ---------- 関連作品への切り替え ---------- */

  let relatedNextIds = [];
  let relatedLoading = false;

  async function switchToRelated(slide, btn) {
    if (btn) { btn.textContent = '読み込み中…'; btn.disabled = true; }
    try {
      const body = await fetchJson(`/ajax/illust/${slide.id}/recommend/init?limit=60&lang=ja`);
      let illusts = body.illusts || [];
      relatedNextIds = (body.nextIds || []).map(String);
      // illustsが空でも候補IDがあればそちらから取る
      if (illusts.length === 0 && relatedNextIds.length > 0) {
        const batch = relatedNextIds.splice(0, 60);
        const b2 = await fetchJson(`/ajax/illust/recommend/illusts?illustIds=${batch.join(',')}&lang=ja`);
        illusts = b2.illusts || [];
        if (b2.nextIds) relatedNextIds = relatedNextIds.concat(b2.nextIds.map(String));
      }
      const items = illusts
        .map((it) => newSlide(String(it.id), it.url || '', it.title || '', it.userName || ''))
        .filter((it) => it.id !== slide.id);
      if (items.length === 0) throw new Error('関連0件');
      const idx = slides.indexOf(slide);
      slides = slides.slice(0, idx + 1);
      while (feedEl.children.length > idx + 1) {
        const removed = feedEl.lastChild;
        if (nearObs) nearObs.unobserve(removed);
        if (curObs) curObs.unobserve(removed);
        feedEl.removeChild(removed);
      }
      mode = 'related';
      addItems(items);
      if (btn) btn.textContent = '関連に切替済み';
    } catch (e) {
      if (btn) { btn.textContent = '失敗: ' + ((e && e.message) || e); btn.disabled = false; }
    }
  }

  // 関連モードの続き読み込み（候補IDが残っている間は末尾に足していく）
  async function relatedLoadMore() {
    if (mode !== 'related' || relatedLoading || relatedNextIds.length === 0) return;
    relatedLoading = true;
    try {
      const batch = relatedNextIds.splice(0, 60);
      const body = await fetchJson(`/ajax/illust/recommend/illusts?illustIds=${batch.join(',')}&lang=ja`);
      if (body.nextIds) relatedNextIds = relatedNextIds.concat(body.nextIds.map(String));
      const items = (body.illusts || [])
        .map((it) => newSlide(String(it.id), it.url || '', it.title || '', it.userName || ''))
        .filter((it) => !slides.some((s) => s.id === it.id));
      addItems(items);
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
          if (s.kind === 'ugoira') {
            if (s.frameUrls) startUgoira(s);
            else if (s.resolved) prepareUgoira(s);
          }
        }
      } else if (s.isCurrent) {
        s.isCurrent = false;
        stopUgoira(s);
        if (s.resolved) upgradeSlide(s);
      }
    });
    // 次の1枚の元画像を先読みしておく（スワイプした瞬間に綺麗な画像が出る）
    if (quality === 'orig') {
      const nx = slides[idx + 1];
      if (nx && nx.resolved && nx.kind !== 'ugoira' && nx.pairs && nx.pairs[0] && nx.pairs[0].o) {
        const pre = new Image();
        pre.src = nx.pairs[0].o;
      }
    }
  }

  function buildFeed() {
    slides = [];
    mode = 'page';
    pageLoadMisses = 0;
    feedEl.innerHTML = '';
    addItems(scanPage());
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
        if (s && !s.resolved) resolveSlide(s);
        else if (s) upgradeSlide(s);
      });
    }, { root: null, rootMargin: '300% 0px 300% 0px', threshold: 0 });

    // 表示中になったら元画像に引き上げ、うごイラは再生する
    curObs = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const s = slides.find((x) => x.sectionEl === en.target);
        if (!s) return;
        if (en.isIntersecting) {
          s.isCurrent = true;
          if (s.resolved) upgradeSlide(s);
          if (s.kind === 'ugoira') {
            if (s.frameUrls) startUgoira(s);
            else if (s.resolved) prepareUgoira(s);
          }
        } else {
          s.isCurrent = false;
          stopUgoira(s);
        }
      });
    }, { root: null, threshold: 0.5 });
  }

  function openViewer() {
    buildOverlay();
    overlay.style.display = 'block';
    buildFeed();
    setTimeout(() => pageLoadMore(), 800);
    setTimeout(() => pageLoadMore(), 2500);
  }

  function closeViewer() {
    overlay.style.display = 'none';
    slides.forEach((s) => stopUgoira(s));
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
      slides.forEach((s) => { if (s.resolved) upgradeSlide(s); });
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
      .pts-close{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:999px;width:32px;height:32px;cursor:pointer;font-size:15px;}
      .pts-feed{height:100%;overflow-y:auto;scroll-snap-type:y mandatory;scrollbar-width:none;}
      .pts-feed::-webkit-scrollbar{display:none;}
      .pts-slide{position:relative;height:100%;scroll-snap-align:start;scroll-snap-stop:always;background:#000;}
      .pts-holder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;}
      .pts-img{max-width:100%;max-height:100%;object-fit:contain;}
      .pts-pager{display:flex;height:100%;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;width:100%;}
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
