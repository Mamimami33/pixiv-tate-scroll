// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      2.4.0
// @description  今開いているpixivのページに並んでいる作品を、1枚ずつ大きい画像でTikTok風に縦スクロールして眺めるビューアです。
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
  let slides = []; // {id, thumb, title, author, page, full, imgEl, titleEl, authorEl}
  let resolving = false;
  let pageLoadBusy = false;
  let pageLoadMisses = 0;

  /* ---------- ページ内スキャン（3段構え） ---------- */

  // 画像URLから作品IDを抜く： .../<ID>_p0_square1200.jpg のような形
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

  function scanPage() {
    const seen = new Set(slides.map((s) => s.id));
    const items = [];
    const push = (id, thumb, title) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      items.push({
        id,
        thumb: thumb || '',
        full: null,
        title: title || '',
        author: '',
        page: `https://www.pixiv.net/artworks/${id}`,
        imgEl: null, titleEl: null, authorEl: null,
      });
    };

    // 第1段：ページ内の全画像から、URLに含まれる作品IDで拾う（カードの構造に依存しない）
    document.querySelectorAll('img').forEach((img) => {
      if (overlay && overlay.contains(img)) return;
      const src = pickBestSrc(img);
      const id = idFromImgUrl(src);
      if (id) push(id, src, (img.alt || '').trim());
    });

    // 第2段：作品リンクから拾う（画像と別構造のカード用）
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

    // 第3段：どちらの方法でもほとんど拾えない場合は、ページ内の埋め込みデータからIDだけ拾う
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

  /* ---------- 大きい画像とタイトルの解決 ---------- */

  function upgradeUrl(url) {
    if (!url) return '';
    let u = url.replace(/^https:\/\/i\.pximg\.net\/c\/[^/]+\//, 'https://i.pximg.net/');
    u = u.replace(/_(square1200|custom1200)\.(\w+)$/, '_p0_master1200.jpg');
    return u;
  }

  async function resolveFull(s) {
    try {
      const res = await fetch(`/ajax/illust/${s.id}`, { credentials: 'same-origin' });
      const json = await res.json();
      if (!json.error && json.body) {
        if (!s.title && json.body.title) {
          s.title = json.body.title;
          if (s.titleEl) s.titleEl.textContent = s.title;
        }
        if (json.body.userName) {
          s.author = json.body.userName;
          if (s.authorEl) s.authorEl.textContent = s.author;
        }
        if (json.body.urls) {
          return json.body.urls.regular || json.body.urls.original || upgradeUrl(s.thumb);
        }
      }
    } catch (e) { /* fall through */ }
    return upgradeUrl(s.thumb);
  }

  async function resolveQueue() {
    if (resolving) return;
    resolving = true;
    try {
      for (const s of slides) {
        if (s.full) continue;
        s.full = await resolveFull(s);
        if (s.imgEl && s.full) {
          if (s.imgEl.dataset.thumb === '1') {
            s.imgEl.src = s.full;
            s.imgEl.dataset.thumb = '';
          }
          const pre = new Image();
          pre.src = s.full;
        }
      }
    } finally {
      resolving = false;
    }
  }

  /* ---------- 表示 ---------- */

  function renderSlide(s, idx) {
    const sec = document.createElement('section');
    sec.className = 'pts-slide';

    const img = document.createElement('img');
    img.className = 'pts-img';
    const first = s.full || upgradeUrl(s.thumb);
    img.src = first || s.thumb;
    img.dataset.thumb = s.full ? '' : '1';
    img.alt = s.title || '';
    img.loading = idx < 2 ? 'eager' : 'lazy';
    img.addEventListener('error', () => {
      if (s.thumb && !img.src.includes(s.thumb)) img.src = s.thumb;
    });
    s.imgEl = img;
    sec.appendChild(img);

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

    feedEl.appendChild(sec);
  }

  function updateCounter() {
    const c = overlay.querySelector('.pts-counter');
    if (slides.length === 0) {
      c.textContent = 'このページに作品が見つかりませんでした';
    } else {
      c.textContent = `${slides.length} 件`;
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
    feedEl.innerHTML = '';
    addItems(scanPage());
  }

  function appendNew() {
    if (!overlay || overlay.style.display === 'none') return;
    addItems(scanPage());
  }

  /* ---------- 背後ページの無限読み込みと連動 ---------- */

  function pageLoadMore() {
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

  function openViewer() {
    buildOverlay();
    overlay.style.display = 'block';
    buildFeed();
    setTimeout(() => pageLoadMore(), 800);
    setTimeout(() => pageLoadMore(), 2500);
  }

  function closeViewer() {
    overlay.style.display = 'none';
  }

  function buildOverlay() {
    if (overlay) return;
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
      .pts-slide{position:relative;height:100%;scroll-snap-align:start;scroll-snap-stop:always;
        display:flex;align-items:center;justify-content:center;background:#000;}
      .pts-img{max-width:100%;max-height:100%;object-fit:contain;}
      .pts-meta{position:absolute;left:0;right:0;bottom:0;padding:28px 16px 18px;color:#fff;pointer-events:none;
        background:linear-gradient(transparent,rgba(0,0,0,.7));}
      .pts-title{font-size:15px;font-weight:700;line-height:1.4;}
      .pts-author{font-size:13px;opacity:.85;margin-top:2px;}
      .pts-open{position:absolute;right:14px;bottom:64px;background:rgba(255,255,255,.16);color:#fff;
        text-decoration:none;font-size:12px;padding:8px 12px;border-radius:999px;}
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
