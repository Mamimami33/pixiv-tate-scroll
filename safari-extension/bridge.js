// 本体(content.js)より先に読み込まれ、同梱したAIコマ補間のファイルの場所を本体に伝える。
// 同じ拡張機能のコンテンツスクリプトは実行環境を共有するので、この値は本体から読める。
// この値がないユーザースクリプト版は、同じファイルを配信サーバーから取得する。
globalThis.__ptsTweenBase =
  (globalThis.browser ?? globalThis.chrome).runtime.getURL('engine/');
