// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      2.0.1
// @description  今開いているpixivのページに並んでいる作品を、TikTok風の縦スクロール（全画面スナップ）で眺めるビューアです。ブックマーク連携なし・ページ内スキャン方式。
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

  // ページ内から作品を集める（a[href*="/artworks/"] とその中の画像）
  function scanPage() {
    const seen = new Set();
    const items = [];
    const anchors = document.querySelectorAll('a[href*="/artworks/"]');
    anchors.forEach((a) => {
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
      // タイトル・作者は近くのテキストから拾える範囲で
      const card = a.closest('li, div');
      const title = (img.alt || '').trim();
      items.push({
        id,
        thumb,
        full: upgradeUrl(thumb),
        title,
        page: `https://www.pixiv.net/artworks/${id}`,
      });
    });
    return items;
  }

  function pickBestSrc(img) {
    const candidates = [];
    // 遅延読み込みでは data-src に本命が入っていることが多い
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
    // プレースホルダ（data: 等）を避け、pximg のものを優先
    for (const c of candidates) {
      if (c && c.includes('i.pximg.net')) return c;
    }
    return candidates[0] || '';
  }

  // square1200 / custom1200 サムネイル → master1200 に変換を試みる（ダメなら表示時にサムネへ差し戻す）
  function upgradeUrl(url) {
    const m = url.match(/^https:\/\/i\.pximg\.net\/c\/[^/]+\/(img-master\/.+?)_(?:square1200|custom1200)\.(\w+)$/);
    if (m) {
      return `https://i.pximg.net/${m[1]}_p0_master1200.jpg`;
    }
    return url;
  }

  function renderSlide(s, idx) {
    const sec = document.createElement('section');
    sec.className = 'pts-slide';

    const img = document.createElement('img');
    img.className = 'pts-img';
    img.src = s.full;
    img.alt = s.title || '';
    img.loading = idx < 2 ? 'eager' : 'lazy';
    img.addEventListener('error', () => {
      if (img.src !== s.thumb) img.src = s.thumb;
    });
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

  function buildFeed() {
    slides = scanPage();
    feedEl.innerHTML = '';
    slides.forEach((s, i) => renderSlide(s, i));
    const c = overlay.querySelector('.pts-counter');
    if (slides.length === 0) {
      c.textContent = 'このページに作品が見つかりませんでした。検索結果・ランキング・作品ページ等で開いてください';
    } else {
      c.textContent = `${slides.length} 件`;
    }
  }

  function openViewer() {
    buildOverlay();
    overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';
    buildFeed();
    // 遅延読み込みで後から増えるページ対策：少し置いて再スキャンし、増えた分を足す
    setTimeout(() => appendNew(), 1200);
    setTimeout(() => appendNew(), 3000);
  }

  function appendNew() {
    if (!overlay || overlay.style.display === 'none') return;
    const known = new Set(slides.map((s) => s.id));
    const items = scanPage().filter((it) => !known.has(it.id));
    if (items.length === 0) return;
    items.forEach((s) => {
      slides.push(s);
      renderSlide(s, slides.length - 1);
    });
    const c = overlay.querySelector('.pts-counter');
    c.textContent = `${slides.length} 件`;
  }

  function closeViewer() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
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
