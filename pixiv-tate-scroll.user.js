// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      3.0.0
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
  let resolving = false;
  let pageLoadBusy = false;
  let pageLoadMisses = 0;
  let mode = 'page'; // 'page' | 'related'
  let observer = null;

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
      resolved: false, kind: 'single', // 'single' | 'multi' | 'ugoira'
      pages: null, frames: null, zipUrl: null,
      sectionEl: null, mainImg: null, titleEl: null, authorEl: null, pageChip: null,
      animTimer: null, animIdx: 0, frameUrls: null,
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
    try {
      const body = await fetchJson(`/ajax/illust/${s.id}`);
      if (body.title && !s.title) { s.title = body.title; if (s.titleEl) s.titleEl.textContent = s.title; }
      if (body.userName) { s.author = body.userName; if (s.authorEl) s.authorEl.textContent = s.author; }
      const pageCount = body.pageCount || 1;
      if (body.illustType === 1) {
        // うごイラ
        s.kind = 'ugoira';
        try {
          const meta = await fetchJson(`/ajax/illust/${s.id}/ugoira_meta`);
          s.zipUrl = meta.src;
          s.frames = meta.frames;
        } catch (e) { /* 静止画フォールバック */ }
        s.pages = [body.urls.original || body.urls.regular || upgradeUrl(s.thumb)];
      } else if (pageCount > 1) {
        s.kind = 'multi';
        try {
          const pages = await fetchJson(`/ajax/illust/${s.id}/pages`);
          s.pages = pages.map((p) => p.urls.original || p.urls.regular);
        } catch (e) {
          s.pages = [body.urls.original || upgradeUrl(s.thumb)];
          s.kind = 'single';
        }
      } else {
        s.kind = 'single';
        s.pages = [body.urls.original || body.urls.regular || upgradeUrl(s.thumb)];
      }
    } catch (e) {
      s.kind = 'single';
      s.pages = [upgradeUrl(s.thumb) || s.thumb];
    }
    s.resolved = true;
    applyResolved(s);
  }

  async function resolveQueue() {
    if (resolving) return;
    resolving = true;
    try {
      for (const s of slides) {
        if (!s.resolved) await resolveSlide(s);
      }
    } finally {
      resolving = false;
    }
  }

  /* ---------- うごイラ（ZIP展開してアニメーション） ---------- */

  async function unzipFrames(zipUrl, frames) {
    const buf = await (await fetch(zipUrl)).arrayBuffer();
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
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      const mime = /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg';
      urls.push(URL.createObjectURL(new Blob([bytes], { type: mime })));
    }
    return urls;
  }

  function startUgoira(s) {
    if (s.animTimer || !s.frameUrls) return;
    const step = () => {
      if (!s.frameUrls) return;
      const url = s.frameUrls[s.animIdx % s.frameUrls.length];
      if (url && s.mainImg) s.mainImg.src = url;
      const delay = (s.frames[s.animIdx % s.frames.length].delay) || 100;
      s.animIdx++;
      s.animTimer = setTimeout(step, delay);
    };
    step();
  }

  function stopUgoira(s) {
    if (s.animTimer) { clearTimeout(s.animTimer); s.animTimer = null; }
  }

  async function prepareUgoira(s) {
    if (s.frameUrls || !s.zipUrl || !s.frames) return;
    try {
      s.frameUrls = await unzipFrames(s.zipUrl, s.frames);
      if (s.sectionEl && s.sectionEl.dataset.visible === '1') startUgoira(s);
    } catch (e) {
      // 失敗したら静止画のまま
    }
  }

  /* ---------- 表示 ---------- */

  function applyResolved(s) {
    if (!s.sectionEl) return;
    const holder = s.sectionEl.querySelector('.pts-holder');
    if (!holder) return;
    holder.innerHTML = '';
    if (s.kind === 'multi' && s.pages && s.pages.length > 1) {
      const pager = document.createElement('div');
      pager.className = 'pts-pager';
      s.pages.forEach((u, i) => {
        const pg = document.createElement('div');
        pg.className = 'pts-page';
        const im = document.createElement('img');
        im.className = 'pts-img';
        im.src = u;
        im.loading = i === 0 ? 'eager' : 'lazy';
        im.alt = s.title || '';
        pg.appendChild(im);
        pager.appendChild(pg);
      });
      pager.addEventListener('scroll', () => {
        const idx = Math.round(pager.scrollLeft / pager.clientWidth);
        if (s.pageChip) s.pageChip.textContent = `${idx + 1} / ${s.pages.length}`;
      }, { passive: true });
      holder.appendChild(pager);
      if (s.pageChip) {
        s.pageChip.style.display = 'block';
        s.pageChip.textContent = `1 / ${s.pages.length}`;
      }
      s.mainImg = pager.querySelector('img');
    } else {
      const im = document.createElement('img');
      im.className = 'pts-img';
      im.src = (s.pages && s.pages[0]) || s.thumb;
      im.alt = s.title || '';
      im.addEventListener('error', () => {
        if (s.thumb && !im.src.includes(s.thumb)) im.src = s.thumb;
      });
      holder.appendChild(im);
      s.mainImg = im;
      if (s.kind === 'ugoira') prepareUgoira(s);
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
    ph.src = upgradeUrl(s.thumb) || s.thumb;
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
    if (observer) observer.observe(sec);
  }

  /* ---------- 関連作品への切り替え ---------- */

  async function switchToRelated(slide, btn) {
    if (btn) { btn.textContent = '読み込み中…'; btn.disabled = true; }
    try {
      const body = await fetchJson(`/ajax/illust/${slide.id}/recommend/init?limit=60&lang=ja`);
      const items = (body.illusts || [])
        .map((it) => newSlide(String(it.id), it.url || '', it.title || '', it.userName || ''))
        .filter((it) => it.id !== slide.id);
      if (items.length === 0) throw new Error('no related');
      const idx = slides.indexOf(slide);
      slides = slides.slice(0, idx + 1);
      while (feedEl.children.length > idx + 1) {
        feedEl.removeChild(feedEl.lastChild);
      }
      mode = 'related';
      addItems(items);
      if (btn) btn.textContent = '関連に切替済み';
    } catch (e) {
      if (btn) { btn.textContent = '関連が取れませんでした'; btn.disabled = false; }
    }
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
    resolveQueue();
  }

  function buildFeed() {
    slides = [];
    mode = 'page';
    pageLoadMisses = 0;
    feedEl.innerHTML = '';
    addItems(scanPage());
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

  function setupObserver() {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        const sec = en.target;
        sec.dataset.visible = en.isIntersecting ? '1' : '';
        const s = slides.find((x) => x.sectionEl === sec);
        if (!s) return;
        if (en.isIntersecting) {
          if (s.kind === 'ugoira') {
            if (s.frameUrls) startUgoira(s);
            else if (s.resolved) prepareUgoira(s);
          }
        } else {
          stopUgoira(s);
        }
      });
    }, { root: null, threshold: 0.6 });
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
    setupObserver();
    overlay = document.createElement('div');
    overlay.id = 'pts-overlay';
    overlay.innerHTML = `
      <div class="pts-bar">
        <span class="pts-counter">…</span>
        <button class="pts-rescan">再スキャン</button>
        <button class="pts-close" title="閉じる">✕</button>
      </div>
      <div class="pts-feed"></div>
    `;
    feedEl = overlay.querySelector('.pts-feed');
    overlay.querySelector('.pts-close').addEventListener('click', closeViewer);
    overlay.querySelector('.pts-rescan').addEventListener('click', buildFeed);
    feedEl.addEventListener('scroll', () => {
      const remain = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
      if (remain < feedEl.clientHeight * 2) pageLoadMore();
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
      .pts-rescan{margin-left:auto;background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:999px;
        padding:7px 12px;cursor:pointer;font-size:12px;}
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
