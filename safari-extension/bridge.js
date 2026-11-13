// 本体(content.js)より先に読み込まれ、補間エンジンの場所を本体に伝える。
// 同じ拡張機能のコンテンツスクリプトは実行環境を共有するので、この値は本体から読める。
// ユーザースクリプト版にはこのファイルがないので、補間機能は拡張機能版でだけ有効になる。
globalThis.__ptsInterpEngineUrl =
  (globalThis.browser ?? globalThis.chrome).runtime.getURL('engine/engine.html');
