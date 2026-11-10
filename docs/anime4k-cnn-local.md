# pixiv縦スクロール：学習済みAnime4K CNN x2（v3.13.26 試作）

**2026-11-11 / 技術検証。** このブランチは `main` ではない。

## 何ができるか

- 学習済み **Anime4K v3.2 CNN x2 (S)** の4畳み込みパス＋depth-to-spaceをGLSL ES 3.00へ移植して同梱。
- **単純なCanvas拡大ではなく**、原作者が公開した訓練済み係数でネットワーク推論する。
- 外部JavaScript・モデルファイル・推論APIのダウンロードなし。選択した端末内の画像を2倍解像度のCanvasへ変換。
- 画像の画素取得はCORS制約に従う。処理用Canvasは使用後に解放。外部送信なし。
- 画面下の **「AI超解像(保存画像)」** から、端末内に保存したPNG/JPEG/WebP画像を明示的に選択する。選択画像が現在表示している作品と同じかは利用者が確認する。
- 現在表示中の単一画像・マンガの表示ページへ結果を重ね、ボタン再押下で元に戻す。
- WEBGL2と浮動小数点描画拡張がない場合、画像解像度が制限を超える場合、モデルが失敗した場合は元の画像を表示する。

## 重要なCORS制約

pixivの静止画は通常 `i.pximg.net` から読み込む。通常の `<img>` 表示は可能でも、`www.pixiv.net` 内のJavaScriptからCanvas/WebGLでピクセルを取得する権限はない場合がある。その場合は**ローカルファイルから手動で読み込む**。外部proxyを使わず、権限回避用の拡張機能を導入しない。

**サイトで表示中のpixiv画像を自動的にAI高画質化できると主張しないこと。** 作品を保存せず通常表示する際はpixivの元画像表示に戻る。

## GPU予算

- 入力最大64万画素、出力最大256万画素、2倍拡大。
- 入力ファイル最大12 MiB。1処理だけ実行。フィード移動、ページ変更、検索、更新、タブ非表示、ビューア終了では結果を廃棄。
- 中間畳み込み4層で`RGBA16F`を使用、成功時は2D Canvasへ複写してWebGL中間リソースを廃棄。
- 上限を超える高画素原画像は処理しない。意図的な低解像化→補間でオリジナルより品質が下がることを避ける。

## RIFEについて

別ブランチ`feat/ugoira-motion-interpolation-20261111`の**非AI動き推定補間**を引き継ぐ。これは局所ブロックマッチング＋WebGL2中間フレーム描画であり、RIFEモデルではない。

RIFEの学習済みモデルをiPhone Safariへ安全に持ち込むには、モデル出典・ライセンス、ファイル形式、実行基盤、GPUメモリの調査・実機測定が必要。ONNX Runtime Web公式の対応表ではSafari iOSのWebGPU実行プロバイダは未対応と記載されている（SafariのWebGPU API自体は対応）。したがって、動作未確認のRIFEを「実装済み」とはしない。大きなモデルを外部サーバーから無断でダウンロードする設計は採用しない。

## 検証と制限

**確認済み**: NodeでJavaScript構文・API通信モック・ローカル補間幾何・局所フロー推定。Linuxのheadless Chromiumで実際にCNNの全shaderをコンパイルして、合成画像に2倍推論を実行し非空出力を検証。

**未確認**: iPhone Safariの実GPUコンパイル・熱・FPS、pixiv表示との重なり、実作品での画質比較、全既存Playwright回帰テスト、RIFEモデル推論。

## 参照・ライセンス

- Original trained shader (MIT): https://github.com/bloc97/Anime4K/blob/master/glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl
- Source SHA: `e6ad7c218452014eaf70170cb5160e9ff427ffbe`
- ライセンス全文: `docs/third-party/Anime4K-LICENSE.txt`
- CORS: https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image
- ONNX Web browser support: https://onnxruntime.ai/docs/get-started/with-javascript/web.html
- WebKit Safari 26 WebGPU: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
