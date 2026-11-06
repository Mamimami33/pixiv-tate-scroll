// ==UserScript==
// @name         pixiv縦スクロール
// @namespace    muse.mamiya
// @version      1.1.0
// @description  pixivのブックマーク／ディスカバリーをTikTok風の縦スクロール（全画面スナップ）で眺めるビューアを、pixivのページ上に重ねて表示します。
// @match        https://www.pixiv.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ブックマークレット等で二重に読み込まれた場合は、既存ボタンを押して終わる
  if (window.__ptsLoaded) {
    const existing = document.getElementById('pts-launch');
    if (existing) existing.click();
    return;
  }
  window.__ptsLoaded = true;

  const LIMIT = 100;
  let overlay = null;
  let feedEl = null;
  let works = [];        // 取得済みブックマーク（生データ）
  let slides = [];       // 表示用スライド {img, title, author, page, rating}
  let offset = 0;
  let total = Infinity;
  let loading = false;
  let filterAllAgesOnly = true; // true=全年齢のみ / false=R-18も表示
  let userId = null;
  let source = 'bookmarks'; // 'bookmarks' | 'discovery'

  function detectUserId() {
    // 自分のブックマークページURLから取る
    const m = location.pathname.match(/\/users\/(\d+)\/bookmarks/);
    if (m) return m[1];
    // ページ内のプロフィールリンク等から推測
    const a = document.querySelector('a[href^="/users/"]');
    if (a) {
      const mm = a.getAttribute('href').match(/\/users\/(\d+)/);
      if (mm) return mm[1];
    }
    return null;
  }

  async function fetchMore() {
    if (loading) return;
    if (source === 'bookmarks' && offset >= total) return;
    loading = true;
    try {
      let list = [];
      if (source === 'bookmarks') {
        const url = `/ajax/user/${userId}/bookmarks/artworks?tag=&offset=${offset}&limit=${LIMIT}&rest=show&lang=ja`;
        const res = await fetch(url, { credentials: 'same-origin' });
        const json = await res.json();
        if (json.error) throw new Error(json.message || 'api error');
        total = json.body.total;
        list = json.body.works || [];
        offset += list.length;
      } else {
        // ディスカバリー（おすすめ）：呼ぶたびに新しいセットが返る
        const mode = filterAllAgesOnly ? 'safe' : 'all';
        const url = `/ajax/discovery/artworks?mode=${mode}&limit=${LIMIT}&lang=ja`;
        const res = await fetch(url, { credentials: 'same-origin' });
        const json = await res.json();
        if (json.error) throw new Error(json.message || 'api error');
        list = (json.body.illusts || []).map((it) => ({
          id: it.id,
          title: it.title,
          url: it.url,
          userName: it.userName,
          xRestrict: it.xRestrict,
          illustType: it.illustType,
        }));
        total = Infinity;
      }
      works = works.concat(list);
      await appendSlides(list);
    } catch (e) {
      console.warn('[pixiv縦スクロール] 取得失敗', e);
    } finally {
      loading = false;
    }
  }

  async function resolveImage(work) {
    // イラスト・マンガは /ajax/illust/<id> から regular を取る。失敗したらサムネイルで代用。
    try {
      const res = await fetch(`/ajax/illust/${work.id}`, { credentials: 'same-origin' });
      const json = await res.json();
      if (!json.error && json.body && json.body.urls) {
        return json.body.urls.regular || json.body.urls.original || work.url;
      }
    } catch (e) { /* fall through */ }
    return work.url;
  }

  async function appendSlides(list) {
    for (const w of list) {
      const rating = (w.xRestrict && w.xRestrict > 0) ? 'r18' : 'all';
      if (filterAllAgesOnly && rating !== 'all') continue;
      const img = await resolveImage(w);
      slides.push({
        img,
        title: w.title || '',
        author: w.userName || '',
        page: `https://www.pixiv.net/artworks/${w.id}`,
        rating,
        ugoira: w.illustType === 1,
      });
      renderSlide(slides[slides.length - 1], slides.length - 1);
    }
    updateCounter();
  }

  function renderSlide(s, idx) {
    const sec = document.createElement('section');
    sec.className = 'pts-slide';
    sec.dataset.index = idx;

    const img = document.createElement('img');
    img.className = 'pts-img';
    img.src = s.img;
    img.alt = s.title;
    img.loading = idx < 2 ? 'eager' : 'lazy';
    sec.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'pts-meta';
    const badge = s.rating === 'r18' ? '<span class="pts-badge">R-18</span>' : '';
    const ugo = s.ugoira ? '<span class="pts-badge pts-badge-ugo">うごイラ（静止画）</span>' : '';
    meta.innerHTML = `${badge}${ugo}<div class="pts-title"></div><div class="pts-author"></div>`;
    meta.querySelector('.pts-title').textContent = s.title;
    meta.querySelector('.pts-author').textContent = s.author;
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

  function rebuildFeed() {
    slides = [];
    feedEl.innerHTML = '';
    // フィルター変更時は取得済み分から作り直す
    (async () => {
      for (const w of works) {
        const rating = (w.xRestrict && w.xRestrict > 0) ? 'r18' : 'all';
        if (filterAllAgesOnly && rating !== 'all') continue;
        const img = await resolveImage(w);
        slides.push({
          img,
          title: w.title || '',
          author: w.userName || '',
          page: `https://www.pixiv.net/artworks/${w.id}`,
          rating,
          ugoira: w.illustType === 1,
        });
        renderSlide(slides[slides.length - 1], slides.length - 1);
      }
      updateCounter();
    })();
  }

  function updateCounter() {
    const c = overlay.querySelector('.pts-counter');
    if (!c) return;
    if (source === 'bookmarks') {
      c.textContent = `${slides.length} 件表示 / ブックマーク ${total === Infinity ? '…' : total} 件`;
    } else {
      c.textContent = `${slides.length} 件表示 / ディスカバリー`;
    }
  }

  function resetAll() {
    works = [];
    slides = [];
    offset = 0;
    total = Infinity;
    if (feedEl) feedEl.innerHTML = '';
  }

  function setSource(next) {
    if (source === next) return;
    if (next === 'bookmarks' && !userId) {
      userId = detectUserId();
      if (!userId) {
        alert('ユーザーIDが分かりませんでした。自分のブックマークページ（/users/○○/bookmarks/artworks）を開いてから切り替えてください。');
        overlay.querySelector('.pts-source').value = source;
        return;
      }
    }
    source = next;
    resetAll();
    updateCounter();
    fetchMore();
  }

  function openViewer() {
    userId = detectUserId();
    // ブックマークページ以外ではディスカバリーを初期ソースにする
    if (!/users\/\d+\/bookmarks/.test(location.pathname)) source = 'discovery';
    buildOverlay();
    overlay.querySelector('.pts-source').value = source;
    overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';
    if (works.length === 0) fetchMore();
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
        <select class="pts-source">
          <option value="bookmarks">ブックマーク</option>
          <option value="discovery">ディスカバリー</option>
        </select>
        <span class="pts-counter">読み込み中…</span>
        <label class="pts-filter">
          <input type="checkbox" class="pts-filter-check" checked>
          <span>全年齢のみ</span>
        </label>
        <button class="pts-close" title="閉じる">✕</button>
      </div>
      <div class="pts-feed"></div>
    `;
    feedEl = overlay.querySelector('.pts-feed');
    overlay.querySelector('.pts-close').addEventListener('click', closeViewer);
    overlay.querySelector('.pts-source').addEventListener('change', (e) => {
      setSource(e.target.value);
    });
    overlay.querySelector('.pts-filter-check').addEventListener('change', (e) => {
      filterAllAgesOnly = e.target.checked;
      if (source === 'discovery') {
        // ディスカバリー側のmode自体を切り替えるので取り直す
        resetAll();
        fetchMore();
      } else {
        rebuildFeed();
        // フィルターOFFで表示件数が少ない場合は先読みを進める
        if (!filterAllAgesOnly) fetchMore();
      }
    });
    // 終端近くまで来たら次ページを取得
    feedEl.addEventListener('scroll', () => {
      const remain = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
      if (remain < feedEl.clientHeight * 3) fetchMore();
    }, { passive: true });
    // キーボード操作
    document.addEventListener('keydown', (e) => {
      if (!overlay || overlay.style.display === 'none') return;
      if (e.key === 'Escape') closeViewer();
      if (e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        feedEl.scrollBy({ top: feedEl.clientHeight, behavior: 'smooth' });
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        feedEl.scrollBy({ top: -feedEl.clientHeight, behavior: 'smooth' });
      }
    });

    const style = document.createElement('style');
    style.textContent = `
      #pts-overlay{position:fixed;inset:0;background:#000;z-index:99999;display:none;}
      .pts-bar{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:center;gap:12px;
        padding:10px 14px;color:#fff;background:linear-gradient(rgba(0,0,0,.65),transparent);font-size:13px;}
      .pts-counter{opacity:.9}
      .pts-source{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:8px;padding:6px 8px;font-size:13px;}
      .pts-source option{color:#000;}
      .pts-filter{margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
      .pts-close{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:999px;width:32px;height:32px;cursor:pointer;font-size:15px;}
      .pts-feed{height:100%;overflow-y:auto;scroll-snap-type:y mandatory;scrollbar-width:none;}
      .pts-feed::-webkit-scrollbar{display:none;}
      .pts-slide{position:relative;height:100%;scroll-snap-align:start;scroll-snap-stop:always;
        display:flex;align-items:center;justify-content:center;background:#000;}
      .pts-img{max-width:100%;max-height:100%;object-fit:contain;}
      .pts-meta{position:absolute;left:0;right:0;bottom:0;padding:28px 16px 18px;color:#fff;pointer-events:none;
        background:linear-gradient(transparent,rgba(0,0,0,.7));}
      .pts-title{font-size:16px;font-weight:700;line-height:1.4;}
      .pts-author{font-size:13px;opacity:.85;margin-top:2px;}
      .pts-badge{display:inline-block;background:#e6007e;color:#fff;font-size:11px;font-weight:700;
        border-radius:4px;padding:2px 6px;margin:0 6px 6px 0;}
      .pts-badge-ugo{background:#555;}
      .pts-open{position:absolute;right:14px;bottom:64px;background:rgba(255,255,255,.16);color:#fff;
        text-decoration:none;font-size:12px;padding:8px 12px;border-radius:999px;backdrop-filter:blur(4px);}
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }

  // 起動ボタン
  const btn = document.createElement('button');
  btn.id = 'pts-launch';
  btn.textContent = '縦スクロール';
  btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99998;background:#0096fa;color:#fff;border:0;' +
    'border-radius:999px;padding:12px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);';
  btn.addEventListener('click', openViewer);
  document.body.appendChild(btn);
})();
