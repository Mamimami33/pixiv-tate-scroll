// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      2.3.0
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
  let slides = []; // {id, thumb, title, page, full, imgEl}
  let resolving = false;
  let pageLoadBusy = false;
  let pageLoadMisses = 0;

  /* ---------- ページ内スキャン ---------- */

  function scanPage() {
    const seen = new Set(slides.map((s) => s.id));
    const items = [];
    document.querySelectorAll('a[href*="/artworks/"]').forEach((a) => {
      if (overlay && overlay.contains(a)) return;
      const m = (a.getAttribute('href') || '').match(/\/artworks\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      const img = a.querySelector('img') || (a.parentElement && a.parentElement.querySelector('img'));
      if (!img) return;
      const thumb = pickBestSrc(img);
      if (!thumb || !thumb.includes('i.pximg.net')) return;
      seen.add(id);
      items.push({
        id,
        thumb,
        full: null,
        title: (img.alt || '').trim(),
        page: `https://www.pixiv.net/artworks/${id}`,
        imgEl: null,
      });
    });
    return items;
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
    return candidates[0] || '';
  }

  // サムネイルURLから大きい画像の候補を作る（/c/サイズ指定/ を外し、square/custom は master に）
  function upgradeUrl(url) {
    let u = url.replace(/^https:\/\/i\.pximg\.net\/c\/[^/]+\//, 'https://i.pximg.net/');
    u = u.replace(/_(square1200|custom1200)\.(\w+)$/, '_p0_master1200.jpg');
    return u;
  }

  /* ---------- 大きい画像の解決（pixiv内部APIで正確なURLを取る） ---------- */

  async function resolveFull(slide) {
    try {
      const res = await fetch(`/ajax/illust/${slide.id}`, { credentials: 'same-origin' });
      const json = await res.json();
      if (!json.error && json.body && json.body.urls) {
        return json.body.urls.regular || json.body.urls.original || upgradeUrl(slide.thumb);
      }
    } catch (e) { /* fall through */ }
    return upgradeUrl(slide.thumb);
  }

  // 未解決のスライドを順番に解決して、表示中の画像を差し替える
  async function resolveQueue() {
    if (resolving) return;
    resolving = true;
    try {
      for (const s of slides) {
        if (s.full) continue;
        s.full = await resolveFull(s);
        if (s.imgEl && s.imgEl.dataset.thumb === '1') {
          s.imgEl.src = s.full;
          s.imgEl.dataset.thumb = '';
        }
        // 先読み：解決済みの画像はブラウザキャッシュに載せる
        const pre = new Image();
        pre.src = s.full;
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
    // まずサムネ由来の大きい候補を出し、正確なURLが分かり次第差し替える
    img.src = s.full || upgradeUrl(s.thumb);
    img.dataset.thumb = s.full ? '' : '1';
    img.alt = s.title || '';
    img.loading = idx < 2 ? 'eager' : 'lazy';
    img.addEventListener('error', () => {
      if (!img.src.includes(s.thumb)) img.src = s.thumb;
    });
    s.imgEl = img;
    sec.appendChild(img);

    if (s.title) {
      const meta = document.createElement('div');
      meta.className = 'pts-meta';
      const t = document.createElement('div');
      t.className = 'pts-title';
      t.textContent = s.title;
      meta.appendChild(t);
      sec.appendChild(meta);
    }

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
      c.textContent = 'このページに作品が見つかりませんでした。検索結果・ランキング・ディスカバリー等で開いてください';
    } else {
      c.textContent = `${slides.length} 件`;
    }
  }

  function addItems(items) {
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
