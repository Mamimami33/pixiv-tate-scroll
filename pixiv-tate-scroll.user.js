// ==UserScript==
// @name         pixiv 高画質化・フレーム補間専用
// @namespace    mamiya.pixiv.enhance.only
// @version      4.0.0-alpha.1
// @description  pixiv作品ページで画像のAI超解像と、うごイラの動き補間だけを行う。縦スクロール・検索・推薦なし。
// @match        https://www.pixiv.net/artworks/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';
  if (window.__ptsEnhanceOnlyLoaded) return;
  window.__ptsEnhanceOnlyLoaded = true;

  // Explicit user operation only. No polling, feed discovery, bookmark, ranking or telemetry.
  const ZIP_MAX_BYTES = 64 * 1024 * 1024;
  const MAX_IMAGE_FILE_BYTES = 18 * 1024 * 1024;
  let overlay = null;
  let stage = null;
  let slides = [];
  let searchGrid = {open:false};
  let preferOriginalUgoira = true;
  let currentRequest = null;
  let operationId = 0;
  let sessionBlocked = false;
  let currentImage = null;
  let currentImageURL = '';
  let enhancedImage = null;
  let showEnhanced = true;
  let userGestureFileInput = null;
  let state = null;
  const byId = id => document.getElementById(id);

  function currentArtworkId() {
    const match = location.pathname.match(/^\/artworks\/(\d+)(?:\/|$)/);
    return match ? match[1] : '';
  }
  function say(message, kind) {
    const element = byId('pts-only-status');
    if (element) {
      element.textContent = String(message || '');
      element.dataset.kind = kind || 'neutral';
    }
  }
  function showBusy(busy) {
    overlay?.classList.toggle('pts-only-busy', !!busy);
    for (const button of overlay?.querySelectorAll('button[data-operation]') || []) {
      button.disabled = !!busy;
    }
  }
  function cancelRequest() {
    operationId++;
    currentRequest?.abort();
    currentRequest = null;
    showBusy(false);
  }
  function releaseImage() {
    if (enhancedImage) {
      enhancedImage.remove(); enhancedImage.width = 0; enhancedImage.height = 0;
    }
    enhancedImage = null;
    if (currentImage) currentImage.remove();
    currentImage = null;
    if (currentImageURL.startsWith('blob:')) URL.revokeObjectURL(currentImageURL);
    currentImageURL = '';
  }
  function stopPlayback() {
    const s = state;
    if (!s) return;
    s.isCurrent = false;
    try { stopUgoira(s); releaseUgoiraCanvas(s); } catch (_) {}
    for (const url of s.frameUrls || []) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    s.frameUrls = null;
    state = null;
  }
  function resetStage() {
    cancelRequest();
    stopPlayback();
    releaseImage();
    if (stage) stage.replaceChildren();
  }
  function createHolder() {
    const section = document.createElement('section');
    section.className = 'pts-only-section';
    const holder = document.createElement('div');
    holder.className = 'pts-holder';
    section.appendChild(holder);
    stage.replaceChildren(section);
    return {section, holder};
  }
  function ensureOpen() {
    createUI();
    overlay.hidden = false;
  }
  function finishError(error) {
    say(error?.message || String(error), 'error');
    console.warn('[PTS enhance]', error);
  }
  async function fetchPixivJson(url, signal) {
    if (sessionBlocked) throw new Error('アクセス制限が発生したため、通信を停止しています');
    const res = await fetch(url, {credentials:'same-origin',signal});
    if (res.status === 429) {
      sessionBlocked = true;
      throw new Error('pixivがHTTP 429を返しました。追加通信は停止します');
    }
    if (!res.ok) throw new Error('pixiv API HTTP '+res.status);
    const data = await res.json();
    if (data?.error || !data?.body) throw new Error(data?.message || '作品情報を取得できません');
    return data.body;
  }
  function imageSourceAllowed(img) {
    return aiCnnCanUseSource(img);
  }
  async function showStaticImage(img, sourceUrl, title) {
    resetStage();
    ensureOpen();
    const {holder} = createHolder();
    const image = img;
    image.className = 'pts-only-image';
    image.alt = title || '画像';
    holder.appendChild(image);
    currentImage = image;
    currentImageURL = sourceUrl || '';
    say('画像を読み込みました。「AI超解像2×」で画質を処理できます');
    updateButtons();
  }
  async function loadImageFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/i.test(file.type))
      throw new Error('PNG/JPEG/WebPを選んでください');
    if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error('画像は18MB以下にしてください');
    resetStage();
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      await showStaticImage(image,url,file.name);
    } catch (err) {
      URL.revokeObjectURL(url); throw err;
    }
  }
  async function loadArtworkImage(id) {
    resetStage();
    ensureOpen();
    if (!id) throw new Error('pixiv作品ページを開いてください');
    const controller = new AbortController();
    currentRequest = controller;
    const idAtStart = ++operationId;
    showBusy(true);
    try {
      say('作品情報を取得しています…');
      const meta = await fetchPixivJson('/ajax/illust/'+id,controller.signal);
      if (idAtStart !== operationId) return;
      if(Number(meta.illustType) === 2) {
        await loadArtworkUgoiraMeta(id,controller.signal,idAtStart);
        return;
      }
      const url = meta.urls?.original || meta.urls?.regular;
      if (!url) throw new Error('この作品の画像URLが取得できません');
      say('元画像を取得しています（CORS非対応なら保存画像を選択）…');
      // Do not bypass browser CORS or route through an external image proxy.
      const response = await fetch(url,{mode:'cors',credentials:'omit',signal:controller.signal});
      if(response.status===429)sessionBlocked=true;
      if(!response.ok)throw new Error('元画像の取得に失敗: HTTP '+response.status);
      const size=Number(response.headers.get('content-length')||0);
      if(size>MAX_IMAGE_FILE_BYTES)throw new Error('画像サイズが18MBを超えています');
      const blob=await response.blob();
      if(blob.size>MAX_IMAGE_FILE_BYTES)throw new Error('画像サイズが18MBを超えています');
      if(idAtStart!==operationId)return;
      const file=new File([blob],id+'.png',{type:blob.type||'image/png'});
      await loadImageFile(file);
    } catch (error) {
      if(error?.name==='AbortError')return;
      say('自動読込できません。画像を保存して「画像を選ぶ」から読み込んでください。 '+String(error?.message||error),'error');
    } finally {
      if(idAtStart === operationId) {
        currentRequest=null;showBusy(false);
      }
    }
  }
  async function loadArtworkUgoiraMeta(id,signal,token) {
    say('うごイラのフレーム情報を取得しています…');
    const meta=await fetchPixivJson('/ajax/illust/'+id+'/ugoira_meta',signal);
    if(token!==operationId)return;
    const frames=meta?.frames;
    if(!Array.isArray(frames) || frames.length<2 || frames.length>120) {
      throw new Error('このうごイラはフレーム数の安全上限（2〜120）外です');
    }
    const zip=meta.originalSrc||meta.src;
    if(!zip)throw new Error('うごイラZIPのURLがありません');
    say('元画質ZIPを1回取得しています…');
    await loadUgoira(zip,frames,signal,token);
  }
  async function loadUgoira(zipUrl,frames,signal,token) {
    let urls;
    try {
      urls=await unzipFrames(zipUrl,frames,signal);
      if(token!==operationId) {
        urls.forEach(url=>{if(url?.startsWith('blob:'))URL.revokeObjectURL(url);});
        return;
      }
      if(urls.filter(Boolean).length<2)throw new Error('有効なフレームが不足しています');
      stopPlayback();releaseImage();
      const {section}=createHolder();
      const s={
        id:currentArtworkId(),kind:'ugoira',sectionEl:section,frameUrls:urls,frames,
        isCurrent:true,ugoiraPlayer:null,ugoiraCanvas:null,animTimer:null,
        animSeekMs:0,seekDragging:false,seekEl:null,seekFill:null,seekKnob:null,
        pageChip:null,motionRenderer:null,motionPair:null
      };
      state=s;slides=[s];
      startUgoira(s);
      say('うごイラを再生中：動き補間はON/OFF可能。中間フレームは端末内で生成します');
      updateButtons();
      urls=null;
    } finally {
      if(urls)urls.forEach(url=>{if(url?.startsWith('blob:'))URL.revokeObjectURL(url);});
    }
  }
  function chooseFile(accept, handler) {
    const input = document.createElement('input');
    input.type='file';input.accept=accept;input.hidden=true;
    overlay.appendChild(input);
    input.addEventListener('change', async()=>{
      try {
        const file=input.files?.[0];
        if(!file)return;
        await handler(file);
      }catch(error){finishError(error);}
      finally {input.remove();}
    },{once:true});
    input.addEventListener('cancel',()=>input.remove(),{once:true});
    input.click();
  }
  function chooseImage() {
    chooseFile('image/png,image/jpeg,image/webp', loadImageFile);
  }
  async function loadUgoiraZipFile(file) {
    if(!file||! /\.zip$/i.test(file.name))throw new Error('ZIPファイルを選んでください');
    if(file.size>ZIP_MAX_BYTES)throw new Error('ZIPは64MB以下にしてください');
    resetStage();
    ensureOpen();
    const url=URL.createObjectURL(file);
    const token=++operationId;
    const signal=(currentRequest=new AbortController()).signal;
    showBusy(true);
    try {
      say('ZIPのフレームを検査しています…');
      const bytes=await file.arrayBuffer();
      const names=listZipImageEntries(bytes);
      if(names.length<2||names.length>120)throw new Error('ZIP内画像は2〜120枚にしてください');
      // ZIPにはtimingが含まれない場合がある。後からpixiv APIの遅延を適用しない。
      const frames=names.map(name=>({file:name,delay:100}));
      say('ZIPを展開しています（既定100ms/フレーム）…');
      await loadUgoira(url,frames,signal,token);
    } finally {
      URL.revokeObjectURL(url);
      if(token===operationId){currentRequest=null;showBusy(false);}
    }
  }
  function listZipImageEntries(buf) {
    const view=new DataView(buf);
    let eocd=-1;
    for(let i=buf.byteLength-22;i>=Math.max(0,buf.byteLength-22-65536);i--){
      if(view.getUint32(i,true)===0x06054b50){eocd=i;break;}
    }
    if(eocd<0)throw new Error('ZIPの終端が見つかりません');
    const count=view.getUint16(eocd+10,true);
    let offset=view.getUint32(eocd+16,true);
    const names=[];
    for(let n=0;n<count;n++){
      if(offset+46>buf.byteLength||view.getUint32(offset,true)!==0x02014b50)break;
      const len=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),
        comment=view.getUint16(offset+32,true);
      if(offset+46+len+extra+comment>buf.byteLength)throw new Error('ZIPヘッダー範囲不正');
      const name=new TextDecoder().decode(new Uint8Array(buf,offset+46,len));
      if(/\.(?:png|jpg|jpeg)$/i.test(name) && !name.startsWith('__MACOSX/'))names.push(name);
      offset+=46+len+extra+comment;
      if(names.length>120)throw new Error('画像数は120枚以下にしてください');
    }
    return names.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  }
  async function applySuperResolution() {
    if (!currentImage || !currentImage.isConnected) {
      say('先に画像を読み込んでください','error');return;
    }
    if(enhancedImage){toggleComparison();return;}
    showBusy(true);
    say('Anime4K CNN x2でGPU推論を実行しています…');
    try {
      // Only existing local or legitimately CORS-enabled images; never export pixiv pixels.
      if(!imageSourceAllowed(currentImage))throw new Error('この画像はCORS制限の対象です。端末から選択してください');
      const canvas=anime4kCnnProcessImage(currentImage);
      if(!currentImage.isConnected){canvas.width=0;canvas.height=0;return;}
      canvas.classList.add('pts-only-enhanced');
      currentImage.parentElement.appendChild(canvas);
      enhancedImage=canvas;showEnhanced=true;
      updateButtons();
      say('AI超解像2×完了。比較ボタンで元画像と切替できます');
    }catch(error){finishError(error);}
    finally {showBusy(false);}
  }
  function toggleComparison() {
    if(!enhancedImage)return;
    showEnhanced=!showEnhanced;
    enhancedImage.hidden=!showEnhanced;
    updateButtons();
    say(showEnhanced?'AI超解像を表示中':'元画像を表示中');
  }
  function toggleMotion() {
    motionInterpolationEnabled=!motionInterpolationEnabled;
    if(!motionInterpolationEnabled && state)releaseUgoiraMotion(state);
    syncMotionButton();updateButtons();
  }
  function updateButtons() {
    const still=!!currentImage,animated=!!state;
    byId('pts-only-upscale').disabled=!still;
    byId('pts-only-compare').disabled=!enhancedImage;
    byId('pts-only-compare').textContent=showEnhanced?'元画像を見る':'AI結果を見る';
    byId('pts-only-motion').disabled=!animated||!motionInterpolationAvailable;
    byId('pts-only-motion').textContent=motionInterpolationEnabled?'動き補間: ON':'動き補間: OFF';
    byId('pts-only-play').disabled=!animated;
    byId('pts-only-play').textContent=state?.animTimer!=null?'一時停止':'再生';
  }
  function togglePlayback() {
    if(!state)return;
    if(state.animTimer!=null) {
      stopUgoira(state);
      say('一時停止中');
    } else {
      state.isCurrent=true;
      startUgoira(state);
      say('再生中');
    }
    updateButtons();
  }
  function closeUI() {
    resetStage();overlay.hidden=true;updateButtons();
  }
  function createUI() {
    if(overlay)return;
    const css=document.createElement('style');css.id='pts-only-style';
    css.textContent="\n#pts-only-overlay{position:fixed;inset:0;z-index:2147481000;background:#08090c;color:#fff;display:flex;flex-direction:column;font:14px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}\n#pts-only-overlay[hidden]{display:none!important}\n#pts-only-overlay button{cursor:pointer;min-height:44px;border-radius:10px;border:1px solid #667;background:#252b3c;color:#fff;padding:8px 12px;touch-action:manipulation}\n#pts-only-overlay button:disabled{opacity:.42;cursor:default}\n#pts-only-overlay header{display:flex;justify-content:space-between;align-items:center;padding:calc(8px + env(safe-area-inset-top)) 12px 8px;gap:12px}\n#pts-only-overlay strong{font-size:15px}\n#pts-only-controls{display:flex;gap:6px;flex-wrap:wrap;padding:7px 12px;justify-content:center}\n#pts-only-stage{min-height:0;flex:1;position:relative;overflow:hidden;background:#000}\n#pts-only-stage .pts-only-section{position:absolute;inset:0}\n#pts-only-stage .pts-holder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}\n#pts-only-stage img.pts-only-image{width:100%;height:100%;object-fit:contain}\n#pts-only-stage canvas.pts-ugoira-canvas,#pts-only-stage canvas.pts-ugoira-motion-canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}\n#pts-only-stage canvas.pts-ugoira-motion-canvas{z-index:2}\n#pts-only-stage canvas.pts-only-enhanced{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:2}\n#pts-only-stage canvas.pts-only-enhanced[hidden]{display:none!important}\n#pts-only-status{padding:9px 12px calc(11px + env(safe-area-inset-bottom));min-height:38px;color:#c7cedb;font-size:12px}\n#pts-only-status[data-kind=\"error\"]{color:#ffd6d6}\n#pts-only-overlay.pts-only-busy #pts-only-status{color:#fff8b0}\n";
    document.head.appendChild(css);
    overlay=document.createElement('div');
    overlay.id='pts-only-overlay';overlay.hidden=true;
    overlay.innerHTML="\n<header><strong>画質向上・フレーム補間</strong><button id=\"pts-only-close\">閉じる</button></header>\n<div id=\"pts-only-controls\">\n<button id=\"pts-only-artwork\" data-operation=\"1\">今の作品を読み込む</button>\n<button id=\"pts-only-file\" data-operation=\"1\">画像を選ぶ</button>\n<button id=\"pts-only-zip\" data-operation=\"1\">うごイラZIPを選ぶ</button>\n</div>\n<div id=\"pts-only-stage\" aria-label=\"処理対象の画像やうごイラ\"></div>\n<div id=\"pts-only-controls\">\n<button id=\"pts-only-upscale\">AI超解像2×</button>\n<button id=\"pts-only-compare\">元画像を見る</button>\n<button id=\"pts-only-motion\">動き補間: OFF</button>\n<button id=\"pts-only-play\">一時停止</button>\n</div>\n<div id=\"pts-only-status\" role=\"status\" aria-live=\"polite\">画像かうごイラを読み込んでください。画像はCORS制限時に保存ファイルを使用します。</div>\n";
    document.body.appendChild(overlay);
    stage=byId('pts-only-stage');
    byId('pts-only-close').onclick=closeUI;
    byId('pts-only-artwork').onclick=()=>{
      const id=currentArtworkId();
      void loadArtworkImage(id);
    };
    byId('pts-only-file').onclick=chooseImage;
    byId('pts-only-zip').onclick=()=>chooseFile('.zip,application/zip',loadUgoiraZipFile);
    byId('pts-only-upscale').onclick=()=>void applySuperResolution();
    byId('pts-only-compare').onclick=toggleComparison;
    byId('pts-only-motion').onclick=toggleMotion;
    byId('pts-only-play').onclick=togglePlayback;
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden&&state&&state.animTimer!=null) {
        stopUgoira(state);
        updateButtons();say('非表示中は停止しました');
      }
    });
    updateButtons();
  }
  function startButton() {
    if(byId('pts-only-launch'))return;
    const button=document.createElement('button');
    button.id='pts-only-launch';button.type='button';
    button.textContent='画質・コマ補間';
    button.title='作品の超解像と、うごイラの動き補間のみ';
    button.addEventListener('click',ensureOpen);
    const style=document.createElement('style');
    style.textContent='#pts-only-launch{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147480000;background:#252534;color:#fff;padding:12px 14px;border:1px solid #777;border-radius:12px;font:600 13px system-ui;box-shadow:0 5px 22px #0008;touch-action:manipulation}';
    document.head.appendChild(style);
    document.body.appendChild(button);
  }

  // The following engines are self-contained and have no streaming or feed APIs.

  const AI_CNN_MODEL_PASSES = ["#define go_0(x_off, y_off) (sampleAt(vec2(x_off, y_off)))\nvec4 hook() {\n    vec4 result = mat4(-0.0057322932, 0.12928207, -0.056848746, 0.18680117, -0.0306273, 0.25602463, 0.053723164, 0.20419341, 0.0018709862, 0.022848232, -0.04105527, 0.10169034, 0.0, 0.0, 0.0, 0.0) * go_0(-1.0, -1.0);\n    result += mat4(0.009471417, -0.12957802, 0.096014425, 0.21836184, 0.00021601951, -0.22997683, 0.23666254, 0.41192335, 0.021762101, 0.0047863554, 0.008233427, 0.108514786, 0.0, 0.0, 0.0, 0.0) * go_0(-1.0, 0.0);\n    result += mat4(-0.01156376, -0.18988979, 0.04614705, -0.044767227, 0.01050636, -0.26426336, 0.23741047, 0.0027636609, -0.027718676, -0.14202335, -0.016650287, -0.06637125, 0.0, 0.0, 0.0, 0.0) * go_0(-1.0, 1.0);\n    result += mat4(0.057809234, -0.11033858, 0.056533534, -0.06292466, 0.13880666, -0.18710336, 0.2441031, -0.25326246, 0.0032683122, -0.026437074, 0.0023248852, 7.640766e-05, 0.0, 0.0, 0.0, 0.0) * go_0(0.0, -1.0);\n    result += mat4(-0.49110603, 0.4429004, -0.44015464, -0.41174838, -0.87738293, 0.7808468, -1.0929365, -0.59699076, -0.18409836, 0.185138, -0.11773224, -0.17097276, 0.0, 0.0, 0.0, 0.0) * go_0(0.0, 0.0);\n    result += mat4(0.10580959, -0.055947904, -0.03431237, -0.080236495, 0.14862584, -0.15393938, -0.18872876, -0.3170681, 0.03559387, -0.003990826, 0.021298569, 0.012844483, 0.0, 0.0, 0.0, 0.0) * go_0(0.0, 1.0);\n    result += mat4(-0.040715586, -0.25781113, 0.08896714, -0.1225879, -0.15790503, -0.54010904, 0.29588607, 0.10401059, 0.003413123, -0.108357325, 0.0112870345, -0.11888622, 0.0, 0.0, 0.0, 0.0) * go_0(1.0, -1.0);\n    result += mat4(0.0049315444, 0.02376202, -0.08224771, 0.121118225, -0.041512914, -0.027994309, -0.585988, -0.069672115, -0.017247835, 0.0056576864, 0.04319012, 0.055003505, 0.0, 0.0, 0.0, 0.0) * go_0(1.0, 0.0);\n    result += mat4(0.37521392, 0.15916082, 0.059708964, 0.19046007, 0.8120325, 0.38343868, 0.3436578, 0.5287958, 0.16570656, 0.06957687, 0.014022592, 0.074799836, 0.0, 0.0, 0.0, 0.0) * go_0(1.0, 1.0);\n    result += vec4(-0.01050964, -0.00939481, 0.17684458, 0.027366742);\n    return result;\n}\n","#define go_0(x_off, y_off) (max((sampleAt(vec2(x_off, y_off))), 0.0))\n#define go_1(x_off, y_off) (max(-(sampleAt(vec2(x_off, y_off))), 0.0))\nvec4 hook() {\n    vec4 result = mat4(-0.011029496, 0.05866063, -0.09460646, -0.017664742, -0.022488879, 0.18384217, -0.00397663, -0.064733066, 0.08466802, 0.10667488, 8.0212536e-05, 0.0908869, 0.13580276, 0.00097438256, 0.12176522, -0.08218466) * go_0(-1.0, -1.0);\n    result += mat4(0.16062798, -0.10190268, 0.03280682, 0.05621916, -0.009684231, -0.08464307, 0.17058301, -0.096469186, 0.1967505, -0.1450099, 0.093607284, -0.28240147, -0.21377413, 0.10079291, -0.1741522, 0.17330575) * go_0(-1.0, 0.0);\n    result += mat4(-0.060160473, 0.06316997, 0.0046929033, -0.049405966, 0.13851729, 0.06830702, -0.0586872, -0.040827133, 0.007052838, -0.03576886, -0.111261636, 0.039155316, -0.07380389, -0.09369825, 0.04471156, 0.09678487) * go_0(-1.0, 1.0);\n    result += mat4(-0.36683616, -0.035950605, -0.24414362, -0.009159744, 0.19335322, -0.099253505, 0.075083904, -0.00076695543, 0.65291303, -0.25599423, 0.19827642, 0.065899536, -0.07423247, -0.068967685, 0.0050554527, -0.060272824) * go_0(0.0, -1.0);\n    result += mat4(-0.020688485, -0.83178276, 0.11104878, 0.26454413, 0.13655476, 0.37675047, -0.22219229, -0.01751935, 0.44552696, 0.92510307, 0.16063261, -0.62011045, 0.19366647, -0.06996067, -0.2504841, 0.00803723) * go_0(0.0, 0.0);\n    result += mat4(0.0051537007, -0.057168536, -0.16110587, 0.25232598, -0.04447099, 0.11997351, 0.14808103, -0.34443566, -0.26212573, -0.21970181, 0.2724405, 0.21050811, -0.07949061, -0.064808235, -0.21208277, -0.0042361654) * go_0(0.0, 1.0);\n    result += mat4(-0.0888952, -0.20169449, 0.19144905, -0.016882861, -0.013283103, 0.07552998, -0.24686803, 0.012453213, -0.065454446, -0.016123284, -0.47316182, 0.070926026, 0.09219782, 0.13118166, 0.074736096, 0.0077910526) * go_0(1.0, -1.0);\n    result += mat4(0.5832154, 0.1138069, -0.039765622, 0.3182784, -0.25497997, 0.0013993139, 0.39285088, -0.48511526, -0.39891505, -0.19094779, -0.082146175, -0.20826934, 0.020590555, -0.0012490178, -0.4398621, 0.14377014) * go_0(1.0, 0.0);\n    result += mat4(0.21917395, 3.4314657e-05, 0.25734863, -0.3433305, 0.015720673, 0.2676127, -0.06807297, 0.15040149, -0.23638041, -0.0050233034, -0.13666134, 0.4542111, -0.033572577, -0.08450588, -0.23341487, 0.053490847) * go_0(1.0, 1.0);\n    result += mat4(-0.17482175, 0.057647135, 0.33135444, 0.0850751, -0.1718849, -0.0854123, 0.036795795, -0.13874969, -0.10903869, -0.19007301, -0.06064334, -0.03786032, -0.036696054, 0.07844446, 0.012523185, -0.01562906) * go_1(-1.0, -1.0);\n    result += mat4(-0.04411997, -0.10331819, 0.10050193, 0.12406485, 0.07431592, 0.30109692, -0.17511666, -0.13263564, -0.10192587, 0.07821255, -0.22415096, 0.25552443, 0.17881326, -0.13914281, 0.109979235, -0.0016463579) * go_1(-1.0, 0.0);\n    result += mat4(-0.01911644, -0.15412527, 0.028903123, 0.20831817, 0.00375175, 0.08110953, 0.074919395, -0.17581624, -0.015677985, 0.06504228, 0.08817818, -0.12518327, -0.09537373, 0.028905088, -0.051288474, 0.054334078) * go_1(-1.0, 1.0);\n    result += mat4(0.2852779, -0.28924024, 0.36805123, 0.21079305, -0.28336474, 0.1679663, -0.08641141, -0.10699407, -0.16090055, 0.1287612, -0.15910125, 0.05734755, 0.15883245, 0.0053026294, 0.080674745, 0.0505137) * go_1(0.0, -1.0);\n    result += mat4(0.17639062, 0.3790122, -0.19588692, -0.020314282, 0.26197383, 0.09014768, 0.19696823, -0.41025418, -0.08308115, -0.33279485, -0.22528782, 0.06172439, -0.1365661, -0.13094363, -0.005086559, 0.089024484) * go_1(0.0, 0.0);\n    result += mat4(0.05262993, 0.0006296959, 0.1657725, -0.32591924, 0.12126701, 0.061543245, -0.10526848, 0.041583937, 0.094976954, 0.09416157, -0.22019257, -0.058390073, -0.2073888, 0.057273377, 0.19558284, 0.004208022) * go_1(0.0, 1.0);\n    result += mat4(0.30005738, 0.18478931, -0.23342943, 0.22455733, -0.016488122, 0.099634305, 0.31620836, -0.15731157, 0.09595808, 0.0013774688, 0.48273298, -0.07027936, -0.18764344, -0.26194447, -0.11794225, -0.012173601) * go_1(1.0, -1.0);\n    result += mat4(0.117986746, -0.13846518, -0.019614812, -0.3011192, 0.5501164, 0.3408611, -0.40090847, 0.15706886, 0.13050972, 0.051776595, 0.20792943, 0.23389706, -0.22965533, -0.053367328, 0.3911586, -0.032988597) * go_1(1.0, 0.0);\n    result += mat4(0.054753624, -0.008485731, -0.2451672, 0.17528129, 0.13657846, 0.010480436, 0.07651423, -0.43316832, 0.12736236, 0.13804524, 0.12529011, -0.30946237, -0.14423579, 0.08403089, 0.24335162, 0.057288036) * go_1(1.0, 1.0);\n    result += vec4(0.012077211, 0.013045883, 0.0380778, -0.02908858);\n    return result;\n}\n","#define go_0(x_off, y_off) (max((sampleAt(vec2(x_off, y_off))), 0.0))\n#define go_1(x_off, y_off) (max(-(sampleAt(vec2(x_off, y_off))), 0.0))\nvec4 hook() {\n    vec4 result = mat4(-0.036115196, -0.06971895, -0.07508942, 0.016036168, 0.12120111, 0.24536026, 0.044755507, -0.20663576, 0.029635755, -0.15427187, 0.027148994, -0.20795093, 0.10170582, 0.077919215, 0.66063017, -0.4632968) * go_0(-1.0, -1.0);\n    result += mat4(-0.0052889925, -0.019060908, -0.08660142, -0.022095207, -0.08097976, -0.015142803, -0.18552722, -0.078493506, -0.16293915, -0.20099808, -0.08370822, 0.3701389, 0.09094984, 0.2487225, 0.24338846, 0.044003833) * go_0(-1.0, 0.0);\n    result += mat4(-0.061406493, -0.017232792, -0.10917424, 0.11203319, 0.040699825, -0.019294346, 0.084953666, -0.018133596, 0.07209552, 0.016069936, 0.17805555, -0.089537814, 0.15809004, 0.1027023, 0.15044671, -0.15530108) * go_0(-1.0, 1.0);\n    result += mat4(0.0948676, -0.040305693, -0.005591629, -0.048048403, -0.07547777, 0.056606572, 0.021390207, 0.32600567, -0.20805131, -0.099587254, 0.029613169, 0.0092129605, -0.29429698, -0.09898621, 0.44470885, -0.89487344) * go_0(0.0, -1.0);\n    result += mat4(-0.122259885, 0.11445877, 0.06666907, 0.1869428, -0.1553992, -0.1658741, 0.2988138, -0.57746625, -0.34609964, 0.11169158, -0.41877756, 0.38075635, 0.21293911, 0.09640372, -0.12754214, -0.08026104) * go_0(0.0, 0.0);\n    result += mat4(0.15128808, 0.050087795, 0.09219755, -0.18080945, 0.0044571217, -0.046019405, -0.1289922, 0.20305426, 0.19601224, 0.04667917, 0.17465587, 0.027672665, 0.18441725, 0.06845396, 0.11288585, -0.23283863) * go_0(0.0, 1.0);\n    result += mat4(-0.072962, -0.06639447, 0.049347494, -0.1386401, 0.10396071, 0.08187777, -0.04280746, 0.07390891, 0.06628344, 0.037797406, 0.021885803, -0.013147403, 0.22376558, 0.36243078, 0.12874891, -0.0023783944) * go_0(1.0, -1.0);\n    result += mat4(0.074945286, 0.16045591, -0.11798349, 0.12910712, 0.054760084, -0.095626175, -0.047832094, 0.03493912, 0.11817307, 0.037452437, -0.14301221, -0.027356789, -0.052390423, 0.11373512, 0.07686775, 0.010008694) * go_0(1.0, 0.0);\n    result += mat4(-0.023999173, -0.091900624, 0.02388157, 0.03173873, 0.0065633506, -0.033716757, -0.1198324, 0.12057766, 0.026465805, -0.07517131, -0.07760598, 0.060463097, 0.07345541, 0.046037503, 0.21101558, -0.26785463) * go_0(1.0, 1.0);\n    result += mat4(0.15544604, -0.03902825, 0.04630384, -0.25173616, -0.0691359, 0.07476507, 0.009071253, 0.089964196, -0.26539803, -0.3958477, -0.22155671, 0.20735882, -0.105860494, -0.003996804, -0.044815883, 0.39544627) * go_1(-1.0, -1.0);\n    result += mat4(0.6169709, 0.23717614, -0.37884676, -0.7484867, 0.020169826, -0.30718836, 1.0965588, -0.20711036, -0.39149985, -0.06843563, -0.06522909, 0.103805855, 0.03265825, -0.15137726, 0.12837899, -0.01294922) * go_1(-1.0, 0.0);\n    result += mat4(-0.23638196, -0.4560866, -0.11948684, -0.1464144, 0.10690008, 0.007835961, 0.11864342, -0.13101323, -0.16509797, 0.075027354, 0.08122998, 0.13451207, 0.0011890623, 0.052157886, 0.08372405, -0.07085038) * go_1(-1.0, 1.0);\n    result += mat4(-0.21997726, -0.16488647, -0.0291317, 0.17997476, 0.1493211, 0.027494298, 0.0034613227, -0.3207727, 0.18699001, 0.14728633, -0.042895135, -0.07612043, 0.125076, -0.14714554, -0.03480009, -0.22753975) * go_1(0.0, -1.0);\n    result += mat4(-0.5342686, -0.7426105, -0.38294584, 0.42549992, 0.46053204, 0.7867879, 0.106234804, -0.041163098, 0.5198579, -0.5219404, 0.14809476, -0.41802374, 0.06810794, -0.15122683, -0.047409, 0.13178343) * go_1(0.0, 0.0);\n    result += mat4(-0.50428164, 0.18220626, 0.35510704, -0.081787474, 0.03155813, 0.019284263, 0.0032388573, -0.20513348, -0.05385551, 0.17803182, -0.26206362, 0.2870375, 0.008557827, 0.08401449, -0.027598893, -0.010791235) * go_1(0.0, 1.0);\n    result += mat4(0.16657415, 0.067647465, 0.093076974, -0.14438486, -0.10017002, 0.0022367141, 0.03250936, -0.052794546, -0.009178676, -0.019673595, -0.0016697067, -0.15424626, -0.112123474, -0.11079971, 0.011987111, -0.11747758) * go_1(1.0, -1.0);\n    result += mat4(-0.023021797, -0.058703423, -0.037978355, -0.062433913, -0.13130441, 0.048656322, 0.056839373, 0.109036915, -0.07823158, 0.14785293, 0.058555078, -0.11679035, -0.14002073, 0.07395252, 0.098268874, -0.06710464) * go_1(1.0, 0.0);\n    result += mat4(0.14906375, 0.030001195, -0.10338215, 0.0662968, -0.161953, -0.13682815, 0.09563142, 0.009514228, -0.009491218, 0.06737101, -0.1393389, 0.15231515, -0.073147796, 0.00767062, 0.028675212, 0.014213088) * go_1(1.0, 1.0);\n    result += vec4(0.018736731, -0.0026039074, 0.050130025, -0.055364225);\n    return result;\n}\n","#define go_0(x_off, y_off) (max((sampleAt(vec2(x_off, y_off))), 0.0))\n#define go_1(x_off, y_off) (max(-(sampleAt(vec2(x_off, y_off))), 0.0))\nvec4 hook() {\n    vec4 result = mat4(0.019100675, -0.014241565, 0.004667036, -0.03865062, 0.106731094, 0.026099661, 0.014594411, -0.011881356, 0.0040967264, -0.004626336, 0.006469508, 0.010875305, -0.033909045, -0.085905954, 0.07861378, 0.019452631) * go_0(-1.0, -1.0);\n    result += mat4(0.20777655, -0.060354974, 0.0023840065, -0.064121604, -0.17397617, 0.019293457, -0.09707183, 0.080641985, 0.01025124, -0.017382381, 0.008661793, -0.010995665, 0.21943407, -0.115574986, 0.14471593, -0.068836235) * go_0(-1.0, 0.0);\n    result += mat4(0.057942886, -0.06311754, 0.2253396, -0.04159292, -0.020731755, 0.007877151, 0.041525815, 0.025278691, 0.03041967, -0.025137542, 0.024364179, -0.024543528, 0.029438615, -0.015506873, 0.081686, -0.07812221) * go_0(-1.0, 1.0);\n    result += mat4(0.054237515, 0.0676094, -0.0047708177, 0.0043467237, -0.10032304, -0.020498628, 0.04240586, 0.07272254, 0.0784221, 0.017945962, -0.022310399, -0.013134622, 0.015638694, -0.10001543, 0.1043031, 0.05898838) * go_0(0.0, -1.0);\n    result += mat4(-0.021652509, 0.35796642, 0.059497777, 0.23948468, 0.15454951, -0.10017235, -0.19072174, -0.44812536, -0.03974552, 0.04529369, 0.22207436, 0.026222564, -0.09705454, 0.5623026, -0.3354105, -0.017278556) * go_0(0.0, 0.0);\n    result += mat4(-0.053682446, -0.03411237, -0.09399936, 0.15128824, -0.07463, -0.042020727, 0.0031783928, 0.13481957, -0.07731454, 0.044114403, -0.23085599, 0.060444202, -0.15015422, 0.0018040676, -0.18684982, 0.2812511) * go_0(0.0, 1.0);\n    result += mat4(0.0029329916, 0.001596018, 0.0007512241, 0.016544111, -0.04876942, -0.05272409, 0.037884697, 0.049948208, 0.015518177, 0.11368592, -0.03815777, -0.013149978, -0.027638039, 0.107719295, -0.04115787, 0.02745414) * go_0(1.0, -1.0);\n    result += mat4(0.016691081, 0.010204119, 0.04078854, 0.01613337, 0.03325829, 0.0114824055, -0.017286912, -0.07284126, -0.110984206, -0.21041764, 0.0089543555, 0.18986733, 0.01537506, -0.2059135, 0.029074017, 0.013117443) * go_0(1.0, 0.0);\n    result += mat4(0.013965926, 0.029871881, 0.0034499036, -0.011343668, 0.022120327, -0.0068748263, 0.009324342, -0.039081004, 0.08032371, 0.050809264, 0.035050742, -0.2032847, 0.06305391, -0.021958945, 0.038569167, -0.22465245) * go_0(1.0, 1.0);\n    result += mat4(0.046307724, -0.012419472, 0.007673863, -0.042344846, 0.011042414, 0.016994251, -0.018166406, -0.016955731, -0.13240299, 0.01768431, -0.027607648, 0.0699927, -0.02840628, 0.004414203, 0.0049618417, 0.011084679) * go_1(-1.0, -1.0);\n    result += mat4(-0.119954154, -0.007455482, -0.031108133, -0.009946449, 0.0077065965, 0.01660345, 0.032943666, 0.016376585, 0.10273124, 0.1556573, -0.24643841, 0.107307844, -0.068235755, 0.0561896, -0.0104672015, 0.042693343) * go_1(-1.0, 0.0);\n    result += mat4(-0.01634601, 0.04195375, -0.10401894, 0.047641944, -0.034602515, -0.0034419263, -0.010457858, 0.015194475, -0.03962551, -0.030031368, 0.16036317, 0.019283568, -0.05877721, 0.016504882, -0.15523468, 0.018161612) * go_1(-1.0, 1.0);\n    result += mat4(-0.08083991, 0.0024665035, -0.049373373, 0.030371357, 0.0113322195, -0.014676956, 0.011646689, -0.01142667, 0.124930486, 0.06625774, -0.045840867, -0.009693036, -0.012649251, -0.07388084, 0.008790075, 0.0013844534) * go_1(0.0, -1.0);\n    result += mat4(-0.33941835, -0.2763476, -0.118311435, -0.063535266, 0.20936015, 0.13731301, 0.13443594, 0.07464433, 0.059650812, -0.36973104, 0.16444235, -0.37082872, 0.06432777, -0.18283032, -0.044489607, -0.13895285) * go_1(0.0, 0.0);\n    result += mat4(0.13533665, 0.08268915, -0.03675727, -0.14348659, 0.0186255, -0.05051692, 0.056702953, 0.0061717895, 0.047663026, -0.088188455, 0.23254345, -0.014015464, 0.08400204, -0.0073777726, 0.2202068, -0.12366078) * go_1(0.0, 1.0);\n    result += mat4(0.04361004, 0.046543695, 0.0064863074, -0.03358146, -0.022602187, 0.018138997, -0.011071864, 0.010244091, -0.019814799, -0.17250171, 0.040823266, -0.040131986, 0.010125854, 0.020660749, 0.0020435036, -0.010819304) * go_1(1.0, -1.0);\n    result += mat4(-0.004810193, -0.11286074, 0.051985834, 0.04788631, -0.023950428, 0.036145125, -0.038203828, 0.052401308, 0.022986965, 0.26420745, -0.06076917, -0.09252999, 0.03164547, 0.15652153, -0.037934, -0.0035418556) * go_1(1.0, 0.0);\n    result += mat4(0.03358366, -0.005219482, 0.007060882, -0.06569114, -0.02941682, 0.00966056, -0.0153679885, 0.019905418, -0.107232265, -0.03405676, -0.044340115, 0.26892832, -0.04723829, -0.02589829, 0.004563232, 0.19318114) * go_1(1.0, 1.0);\n    result += vec4(-0.00346731, -0.0046263863, -0.004627155, -0.0057769152);\n    return result;\n}\n"];
  const AI_CNN_MODEL_FINAL = "vec4 hook() {\n    vec2 f0 = fract(uv * inputSize);\n    ivec2 i0 = ivec2(f0 * vec2(2.0));\n    float c0 = sampleDetail((vec2(0.5) - f0) * invSize + uv)[i0.y * 2 + i0.x];\n    float c1 = c0;\n    float c2 = c1;\n    float c3 = c2;\n    return vec4(c0, c1, c2, c3) + texture(baseTexture,uv);\n}\n";
  const AI_CNN_MAX_INPUT_PIXELS = 640_000;
  const AI_CNN_MAX_OUTPUT_PIXELS = 2_560_000;

  function aiCnnCanUseSource(image) {
    const url=String(image?.currentSrc||image?.src||'');
    if(!image?.complete||!image.naturalWidth||!image.naturalHeight)return false;
    if(/^blob:|^data:/i.test(url))return true;
    try {
      if(new URL(url,location.href).origin===location.origin)return true;
    }catch(_){}
    return !!image.crossOrigin; // Cross-origin image must already have passed CORS.
  }

  function aiCnnShader(gl,kind,source) {
    const shader=gl.createShader(kind);
    if(!shader)throw new Error('GPUシェーダーを確保できません');
    gl.shaderSource(shader,source);
    gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
      const error=gl.getShaderInfoLog(shader)||'コンパイルできません';
      gl.deleteShader(shader);
      throw new Error('AIシェーダー: '+error.slice(0,180));
    }
    return shader;
  }

  function aiCnnProgram(gl,vertex,fragment) {
    const v=aiCnnShader(gl,gl.VERTEX_SHADER,vertex);
    const f=aiCnnShader(gl,gl.FRAGMENT_SHADER,fragment);
    const program=gl.createProgram();
    gl.attachShader(program,v);gl.attachShader(program,f);
    gl.linkProgram(program);
    gl.deleteShader(v);gl.deleteShader(f);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
      const reason=gl.getProgramInfoLog(program)||'リンクできません';
      gl.deleteProgram(program);
      throw new Error('AIプログラム: '+reason.slice(0,180));
    }
    return program;
  }

  function anime4kCnnConvolutionShader(body) {
    return '#version 300 es\nprecision highp float;\n'+
      'in vec2 uv;out vec4 color;\n'+
      'uniform sampler2D inputTexture;uniform vec2 invSize;\n'+
      'vec4 sampleAt(vec2 offset){return texture(inputTexture,uv+offset*invSize);}\n'+
      body+'\nvoid main(){color=hook();}\n';
  }

  function anime4kCnnFinalShader(body) {
    return '#version 300 es\nprecision highp float;\n'+
      'in vec2 uv;out vec4 color;\n'+
      'uniform sampler2D baseTexture, detailTexture;\n'+
      'uniform vec2 inputSize,invSize;\n'+
      'vec4 sampleDetail(vec2 coord){return texture(detailTexture,coord);}\n'+
      body+'\nvoid main(){vec4 c=hook();color=vec4(clamp(c.rgb,0.0,1.0),1.0);}\n';
  }

  function anime4kCnnProcessImage(image) {
    const width=image.naturalWidth, height=image.naturalHeight;
    if(!aiCnnCanUseSource(image))throw new Error('IMAGE_CORS_OR_UNAVAILABLE');
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||
       width*height>AI_CNN_MAX_INPUT_PIXELS||
       width*height*4>AI_CNN_MAX_OUTPUT_PIXELS){
      throw new Error('AI超解像の画素上限を超えています');
    }
    const work=document.createElement('canvas');
    work.width=width*2;work.height=height*2;
    const gl=work.getContext('webgl2',{alpha:false,depth:false,stencil:false,
      antialias:false,preserveDrawingBuffer:true,powerPreference:'low-power'});
    if(!gl)throw new Error('WebGL2が利用できません');
    if(!gl.getExtension('EXT_color_buffer_float'))
      throw new Error('浮動小数点テクスチャが使えません');
    const textures=[], programs=[];
    let fbo=null,vao=null;
    const tex=(unit,texObj)=>{gl.activeTexture(gl.TEXTURE0+unit);
      gl.bindTexture(gl.TEXTURE_2D,texObj);};
    const newTexture=(type,sourceImage)=>{
      const texture=gl.createTexture();
      textures.push(texture);
      tex(0,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,type==='input'?gl.LINEAR:gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,type==='input'?gl.LINEAR:gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      if(type==='input'){
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,sourceImage);
      }else{
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,width,height,0,gl.RGBA,gl.HALF_FLOAT,null);
      }
      return texture;
    };
    try{
      const vertex='#version 300 es\nprecision highp float;out vec2 uv;\n'+
        'void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));'+
        'uv=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}\n';
      vao=gl.createVertexArray();gl.bindVertexArray(vao);
      fbo=gl.createFramebuffer();
      const original=newTexture('input',image);
      let incoming=original;
      for(const fragmentBody of AI_CNN_MODEL_PASSES){
        const output=newTexture('float',null);
        gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,output,0);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)
          throw new Error('AI処理バッファを作成できません');
        gl.viewport(0,0,width,height);
        const program=aiCnnProgram(gl,vertex,anime4kCnnConvolutionShader(fragmentBody));
        programs.push(program);
        gl.useProgram(program);
        gl.uniform1i(gl.getUniformLocation(program,'inputTexture'),0);
        gl.uniform2f(gl.getUniformLocation(program,'invSize'),1/width,1/height);
        tex(0,incoming);
        gl.drawArrays(gl.TRIANGLES,0,3);
        incoming=output;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.viewport(0,0,width*2,height*2);
      const last=aiCnnProgram(gl,vertex,anime4kCnnFinalShader(AI_CNN_MODEL_FINAL));
      programs.push(last);
      gl.useProgram(last);
      gl.uniform1i(gl.getUniformLocation(last,'baseTexture'),0);
      gl.uniform1i(gl.getUniformLocation(last,'detailTexture'),1);
      gl.uniform2f(gl.getUniformLocation(last,'inputSize'),width,height);
      gl.uniform2f(gl.getUniformLocation(last,'invSize'),1/width,1/height);
      tex(0,original);tex(1,incoming);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.finish();
      // 2D Canvasへ保存してGPUの一時テクスチャを速やかに破棄。
      const output=document.createElement('canvas');
      output.width=width*2;output.height=height*2;
      const ctx=output.getContext('2d',{alpha:false});
      if(!ctx)throw new Error('AI出力Canvasを準備できません');
      ctx.drawImage(work,0,0);
      output.className='pts-ai-cnn-canvas';
      return output;
    }finally{
      for(const program of programs)gl.deleteProgram(program);
      for(const texture of textures)gl.deleteTexture(texture);
      if(fbo)gl.deleteFramebuffer(fbo);
      if(vao)gl.deleteVertexArray(vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      work.width=0;work.height=0;
    }
  }


  function inflateRaw(bytes, maxSize = 8 * 1024 * 1024) {
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
    const push = byte => { if (out.length >= maxSize) throw new Error('ZIP展開上限（1フレーム8MB）'); out.push(byte); };
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        pos = (pos + 7) & ~7;
        const len = bytes[pos >> 3] | (bytes[(pos >> 3) + 1] << 8);
        pos += 32;
        const start = pos >> 3;
        for (let i = 0; i < len; i++) push(bytes[start + i]);
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
          if (sym < 256) push(sym);
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
            for (let i = 0; i < len; i++) push(out[start + i]);
          }
        }
      }
    }
    return new Uint8Array(out);
  }

  async function unzipFrames(zipUrl, frames, signal) {
    if (!Array.isArray(frames) || frames.length < 2 || frames.length > 120) throw new Error('フレーム数は2〜120に制限しています');
    let res;
    try {
      res = await fetch(zipUrl, { signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error('ZIP取得失敗(通信/CORS): ' + (e && e.message ? e.message : e));
    }
    if (!res.ok) throw new Error('ZIP取得失敗: HTTP ' + res.status);
    const declaredSize = Number(res.headers.get('content-length') || 0);
    if (declaredSize > 64 * 1024 * 1024) throw new Error('ZIPは64MB以下にしてください');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 64 * 1024 * 1024 || buf.byteLength < 22) throw new Error('ZIPの容量が不正です');
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
      if (off + 46 > buf.byteLength || view.getUint32(off, true) !== 0x02014b50) break;
      const method = view.getUint16(off + 10, true);
      const compSize = view.getUint32(off + 20, true);
      const uncompSize = view.getUint32(off + 24, true);
      if (uncompSize > 8 * 1024 * 1024) throw new Error('1フレーム8MB超過');
      const nameLen = view.getUint16(off + 28, true);
      const extraLen = view.getUint16(off + 30, true);
      const commentLen = view.getUint16(off + 32, true);
      const localOff = view.getUint32(off + 42, true);
      if (off + 46 + nameLen + extraLen + commentLen > buf.byteLength ||
          localOff + 30 > buf.byteLength) throw new Error('ZIPヘッダー不正');
      const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
      const lNameLen = view.getUint16(localOff + 26, true);
      const lExtraLen = view.getUint16(localOff + 28, true);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      if (dataOff + compSize > buf.byteLength) throw new Error('ZIPデータ範囲不正');
      byName.set(name, { method, compSize, uncompSize, dataOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    const urls = [];
    try {
    let totalUncompressed = 0;
    for (let fi = 0; fi < frames.length; fi++) {
      if (signal?.aborted) throw new DOMException('中断しました','AbortError');
      const f = frames[fi];
      const ent = byName.get(f.file);
      if (!ent) { urls.push(null); continue; }
      totalUncompressed += ent.uncompSize;
      if(totalUncompressed > 128 * 1024 * 1024) throw new Error('ZIP展開合計128MB超過');
      if(ent.method !== 0 && ent.method !== 8) throw new Error('未対応のZIP圧縮方式');
      const raw = new Uint8Array(buf, ent.dataOff, ent.compSize);
      let bytes = raw;
      if (ent.method === 8) {
        bytes = inflateRaw(raw, 8 * 1024 * 1024);
      }
      if (bytes.length !== ent.uncompSize) throw new Error('ZIP展開後のサイズ不一致');
      const mime = /\.png$/i.test(f.file) ? 'image/png' : 'image/jpeg';
      urls.push(URL.createObjectURL(new Blob([bytes], { type: mime })));
      // 同期解凍が続くとSafariが固まるので、数フレームごとに描画の機会を返す
      if (fi % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    return urls;
    } catch (e) {
      for (const url of urls) if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      throw e;
    }
  }


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
    releaseUgoiraMotion(s);
    player.urls = s.frameUrls;
  }

  function queueUgoiraFrame(s, index) {
    const player = s.ugoiraPlayer;
    const urls = s.frameUrls;
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
            s.frameUrls !== urls || !s.isCurrent) return;
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


  /* ---------- うごイラ: 動き推定を用いた端末内フレーム補間（実験的） ---------- */
  // これはRIFEなどのAI推論ではない。隣接ZIPフレーム間の局所ブロックマッチングで
  // 動きベクトルを推定し、WebGL2で前後の画像を位置補正して描画する。
  // クロスフェードのみの処理とは異なるが、激しい動きには破綻があり得る。
  // ソースは既に展開したblobフレームのみ。pixivへの追加GETを行わない。
  const MOTION_ANALYSIS_SIZE = 160;
  const MOTION_BLOCK_SIZE = 12;
  const MOTION_SEARCH_RADIUS = 4;
  const MOTION_MAX_FRAME_PIXELS = 2_500_000;
  const MOTION_MAX_OUTPUT_PIXELS = 1_250_000;
  let motionInterpolationEnabled = false;
  let motionInterpolationAvailable = true;

  function disableMotionInterpolation() {
    motionInterpolationAvailable = false;
    motionInterpolationEnabled = false;
    syncMotionButton();
  }

  function motionGrayFromImage(image, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    // うごイラZIPを展開して生成したsame-origin blob: のみを対象にする。
    const data = ctx.getImageData(0,0,width,height).data;
    const gray = new Uint8Array(width * height);
    for (let k=0, i=0; i<gray.length; i++, k+=4) {
      gray[i]=(data[k]*77+data[k+1]*150+data[k+2]*29)>>8;
    }
    canvas.width=0;canvas.height=0;
    return gray;
  }

  function estimateUgoiraMotion(grayA, grayB, width, height,
    blockSize = MOTION_BLOCK_SIZE, radius = MOTION_SEARCH_RADIUS) {
    if (!grayA || !grayB || width<24 || height<24 ||
        grayA.length!==width*height || grayB.length!==width*height) return null;
    const columns=Math.ceil(width/blockSize), rows=Math.ceil(height/blockSize);
    const pixels=new Uint8Array(columns*rows*4);
    let totalDifference=0;
    for(let i=0;i<grayA.length;i+=3) totalDifference+=Math.abs(grayA[i]-grayB[i]);
    const meanDifference=totalDifference/Math.ceil(grayA.length/3);
    // カット切り替えを誤って補間すると残像が出る。
    if(meanDifference>65)return null;
    for(let by=0;by<rows;by++)for(let bx=0;bx<columns;bx++){
      const centerX=bx*blockSize+Math.floor(blockSize/2);
      const centerY=by*blockSize+Math.floor(blockSize/2);
      const x0=Math.max(0,centerX-4),x1=Math.min(width-1,centerX+4);
      const y0=Math.max(0,centerY-4),y1=Math.min(height-1,centerY+4);
      let bestDx=0,bestDy=0,bestScore=Infinity;
      for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
        let score=0,samples=0;
        for(let y=y0;y<=y1;y+=2)for(let x=x0;x<=x1;x+=2){
          const tx=x+dx,ty=y+dy;
          if(tx<0||ty<0||tx>=width||ty>=height)continue;
          score+=Math.abs(grayA[y*width+x]-grayB[ty*width+tx]);
          samples++;
        }
        if(samples<8)continue;
        // 均一色の領域で意味のない大きな移動を推定しない。
        const normalized=score/samples+0.5*(dx*dx+dy*dy);
        if(normalized<bestScore){
          bestScore=normalized;bestDx=dx;bestDy=dy;
        }
      }
      // WebGLテクスチャの行は下から並ぶので順序を反転。
      const dest=((rows-1-by)*columns+bx)*4;
      pixels[dest]=Math.max(0,Math.min(255,128+bestDx*12));
      pixels[dest+1]=Math.max(0,Math.min(255,128-bestDy*12));
      pixels[dest+2]=0;pixels[dest+3]=255;
    }
    return {pixels,columns,rows,width,height,meanDifference};
  }

  function releaseUgoiraMotion(s) {
    const m=s?.motionRenderer;
    if(m){
      try{
        const gl=m.gl;
        for(const tex of [m.a,m.b,m.flow]) if(tex)gl.deleteTexture(tex);
        if(m.program)gl.deleteProgram(m.program);
        if(m.vao)gl.deleteVertexArray(m.vao);
      }catch(_){}
      m.canvas?.remove();
      if(m.canvas){m.canvas.width=0;m.canvas.height=0;}
    }
    if(s) {s.motionRenderer=null;s.motionPair=null;}
  }

  function motionShader(gl,type,code) {
    const shader=gl.createShader(type);
    if(!shader)return null;
    gl.shaderSource(shader,code);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){
      gl.deleteShader(shader);return null;
    }
    return shader;
  }

  function createUgoiraMotionRenderer(s,width,height) {
    const holder=s.sectionEl?.querySelector('.pts-holder');
    if(!holder||!motionInterpolationAvailable)return null;
    const canvas=document.createElement('canvas');
    canvas.className='pts-ugoira-motion-canvas';
    const scale=Math.min(1,Math.sqrt(MOTION_MAX_OUTPUT_PIXELS/(width*height)));
    canvas.width=Math.max(1,Math.floor(width*scale));
    canvas.height=Math.max(1,Math.floor(height*scale));
    const gl=canvas.getContext('webgl2',{
      alpha:false,depth:false,stencil:false,antialias:false,
      preserveDrawingBuffer:false,powerPreference:'low-power'
    });
    if(!gl){disableMotionInterpolation();return null;}
    const vertex=motionShader(gl,gl.VERTEX_SHADER,`#version 300 es
      out vec2 uv;
      void main(){
        vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
        uv=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);
      }`);
    const fragment=motionShader(gl,gl.FRAGMENT_SHADER,`#version 300 es
      precision highp float;
      in vec2 uv;out vec4 color;
      uniform sampler2D frameA,frameB,motionField;
      uniform vec2 invAnalysis;uniform float mixTime;
      void main(){
        vec2 flow=(texture(motionField,uv).rg*255.0-vec2(128.0))
          /12.0*invAnalysis;
        vec2 a=clamp(uv-flow*mixTime,0.0,1.0);
        vec2 b=clamp(uv+flow*(1.0-mixTime),0.0,1.0);
        color=mix(texture(frameA,a),texture(frameB,b),mixTime);
      }`);
    if(!vertex||!fragment){
      if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);
      canvas.width=0;canvas.height=0;disableMotionInterpolation();return null;
    }
    const program=gl.createProgram();
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);
    gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){
      gl.deleteProgram(program);canvas.width=0;canvas.height=0;
      disableMotionInterpolation();return null;
    }
    const vao=gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program,'frameA'),0);
    gl.uniform1i(gl.getUniformLocation(program,'frameB'),1);
    gl.uniform1i(gl.getUniformLocation(program,'motionField'),2);
    const m={gl,canvas,program,vao,a:null,b:null,flow:null,pair:null,
      alpha:gl.getUniformLocation(program,'mixTime'),
      inv:gl.getUniformLocation(program,'invAnalysis')};
    canvas.style.display='none';
    canvas.addEventListener('webglcontextlost',event=>{
      event.preventDefault();disableMotionInterpolation();
      releaseUgoiraMotion(s);
    },{once:true});
    holder.appendChild(canvas);
    s.motionRenderer=m;
    return m;
  }

  function motionTexture(gl,unit,image,field) {
    const texture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+unit);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    if(field){
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,field.columns,field.rows,0,
        gl.RGBA,gl.UNSIGNED_BYTE,field.pixels);
    }else{
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
    }
    return texture;
  }

  function drawUgoiraMotion(s,index,fraction,duration){
    if(!motionInterpolationEnabled||!motionInterpolationAvailable||
       !s.isCurrent||document.hidden||searchGrid.open||
       !(fraction>0.03&&fraction<0.97)||duration>300||duration<25){
      if(s.motionRenderer)s.motionRenderer.canvas.style.display='none';
      return false;
    }
    const player=s.ugoiraPlayer;
    const a=player?.ready.get(index);
    const next=(index+1)%s.frameUrls.length;
    const b=player?.ready.get(next);
    if(!a||!b||!a.src.startsWith('blob:')||!b.src.startsWith('blob:')||
      a.naturalWidth!==b.naturalWidth||a.naturalHeight!==b.naturalHeight||
      !a.naturalWidth||a.naturalWidth*a.naturalHeight>MOTION_MAX_FRAME_PIXELS){
      if(s.motionRenderer)s.motionRenderer.canvas.style.display='none';
      return false;
    }
    try{
      let m=s.motionRenderer;
      if(m&&(m.imageWidth!==a.naturalWidth||m.imageHeight!==a.naturalHeight)){
        releaseUgoiraMotion(s);m=null;
      }
      if(!m){
        m=createUgoiraMotionRenderer(s,a.naturalWidth,a.naturalHeight);
        if(!m)return false;
        m.imageWidth=a.naturalWidth;m.imageHeight=a.naturalHeight;
      }
      if(m.skipped?.index===index && m.skipped.a===a && m.skipped.b===b){
        m.canvas.style.display='none';return false;
      }
      if(m.pair?.index!==index||m.pair.a!==a||m.pair.b!==b){
        const scale=Math.min(1,MOTION_ANALYSIS_SIZE/a.naturalWidth,
          MOTION_ANALYSIS_SIZE/a.naturalHeight);
        const w=Math.max(24,Math.round(a.naturalWidth*scale));
        const h=Math.max(24,Math.round(a.naturalHeight*scale));
        const grayA=motionGrayFromImage(a,w,h);
        const grayB=motionGrayFromImage(b,w,h);
        const field=estimateUgoiraMotion(grayA,grayB,w,h);
        if(!field){
          m.skipped={index,a,b};m.canvas.style.display='none';return false;
        }
        m.skipped=null;
        const gl=m.gl;
        for(const tex of [m.a,m.b,m.flow])if(tex)gl.deleteTexture(tex);
        m.a=motionTexture(gl,0,a,null);
        m.b=motionTexture(gl,1,b,null);
        m.flow=motionTexture(gl,2,null,field);
        m.pair={index,a,b,field};
      }
      const gl=m.gl;
      gl.viewport(0,0,m.canvas.width,m.canvas.height);
      gl.useProgram(m.program);gl.bindVertexArray(m.vao);
      gl.uniform1f(m.alpha,fraction);
      gl.uniform2f(m.inv,1/m.pair.field.width,1/m.pair.field.height);
      for(const [unit,tex] of [[0,m.a],[1,m.b],[2,m.flow]]){
        gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,tex);
      }
      gl.drawArrays(gl.TRIANGLES,0,3);
      m.canvas.style.display='block';
      return true;
    }catch(e){
      releaseUgoiraMotion(s);
      disableMotionInterpolation();
      return false;
    }
  }


  function syncUgoiraQualityButton() {
    const button=overlay?.querySelector('.pts-ugoira-quality');
    if(!button)return;
    button.textContent=preferOriginalUgoira?'うご原寸優先: ON':'うご原寸優先: OFF';
    button.title='次に読み込むうごイラから元サイズZIPを直接取得。小さいZIPと両方取得するのを避けます。';
    button.setAttribute('aria-pressed',preferOriginalUgoira?'true':'false');
  }

  function toggleUgoiraQuality() {
    preferOriginalUgoira=!preferOriginalUgoira;
    syncUgoiraQualityButton();
  }

  function syncMotionButton(){
    const button=overlay?.querySelector('.pts-motion');
    if(!button)return;
    button.textContent=motionInterpolationEnabled?'動き補間: ON':'動き補間: OFF';
    button.setAttribute('aria-pressed',motionInterpolationEnabled?'true':'false');
    button.disabled=!motionInterpolationAvailable;
    button.title='うごイラの前後フレームを動き推定で補間。AI RIFEではありません。';
  }

  function toggleMotionInterpolation(){
    motionInterpolationEnabled=!motionInterpolationEnabled;
    if(!motionInterpolationEnabled)slides.forEach(releaseUgoiraMotion);
    syncMotionButton();
  }

  function startUgoira(s) {
    if (s.animTimer != null || !s.frameUrls?.length ||
        !s.frames?.length || !s.isCurrent) return;
    if (!ensureUgoiraCanvas(s)) return;
    const timeline = ugoiraTimeline(s.frames);
    const total = timeline.at(-1);
    if (!(total > 0)) return;
    s.animTotal = total;
    if (!s.ugoiraPlayer) s.ugoiraPlayer = {
      urls:s.frameUrls, ready:new Map(), loading:new Map(),
      generation:0, displayed:-1, elapsed:0, started:null,
      loops:0, timeline, total
    };
    const player=s.ugoiraPlayer;
    if (player.urls !== s.frameUrls) clearUgoiraDecodeCache(s);
    player.timeline=timeline;
    player.total=total;
    player.started=null;
    player.loops=0;
    player.elapsed=Number.isFinite(s.animSeekMs)
      ? ((s.animSeekMs % total) + total) % total : 0;
    s.animSeekMs=null;
    setUgoiraStatus(s,'playing');
    void upgradeUgoiraHiRes(s);
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
      if (player.urls !== s.frameUrls) {
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
      const frameMs=timeline[index+1]-timeline[index];
      drawUgoiraMotion(s,index,(player.elapsed-timeline[index])/frameMs,frameMs);
      const pct=timeline[index]/total*100;
      if(s.seekFill)s.seekFill.style.width=pct+'%';
      if(s.seekKnob)s.seekKnob.style.left=pct+'%';
      s.animTimer=requestAnimationFrame(tick);
    };
    s.animTimer=requestAnimationFrame(tick);
  }

  function dragUgoira(s,ratio) {
    if(!s.frameUrls?.length||!s.frames?.length)return;
    const timeline=ugoiraTimeline(s.frames);
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
    releaseUgoiraMotion(s);
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
    releaseUgoiraMotion(s);
    s.ugoiraCanvas?.remove();
    s.ugoiraCanvas = null;
    s.sectionEl?.querySelector('.pts-holder')
      ?.classList.remove('pts-ugoira-active');
    s.ugoiraPlayer = null;
  }

  function setChip(s, text) {
    if (!s.pageChip) return;
    s.pageChip.style.display = 'block';
    s.pageChip.textContent = text;
  }



  // Compatibility adapters for the formerly embedded ugoira renderer.
  function setUgoiraStatus(s, kind, text) {
    if(kind==='error')say(text||'うごイラエラー','error');
  }
  function onUgoiraLoop() {}
  function upgradeUgoiraHiRes() {} // Never fetch a second, redundant ZIP.
  window.addEventListener('pagehide',()=>{if(overlay&&!overlay.hidden)closeUI();});
  startButton();
})();
