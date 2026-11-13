# Safari拡張機能版

ユーザースクリプト本体 (`pixiv-tate-scroll.user.js`) を、そのままSafari Web Extensionの
コンテンツスクリプトとして載せる。本体は `@grant none` でGM APIを使っていないため、
拡張機能用の書き換えはしていない。機能追加・修正はこれまでどおり本体だけを編集する。
うごイラのAIコマ補間だけは、拡張機能に同梱したエンジンを使うので拡張機能版でのみ動く。

## 構成

- `safari-extension/manifest.json` … 拡張機能の定義（Manifest V3）。バージョンは仮の値で、ビルド時に本体の `@version` で上書きする。
- `safari-extension/bridge.js` … 補間エンジンの場所を本体に伝える。
- `safari-extension/engine/` … うごイラのAIコマ補間エンジン（`docs/ugoira-tween-3.13.23.md`）。
- `safari-extension/icons/` … アイコン（仮デザイン）。
- `scripts/build-safari.cjs` … 本体を `content.js` として組み込み、AIモデルと実行ライブラリを `node_modules` から集めて `dist/safari-extension/` に出力する（約50MB）。
- `tests/safari-extension.cjs` … ビルド結果をChromiumに読み込み、pixivのページでだけ起動することを確認する。
- `tests/ugoira-tween.cjs` … コマ補間が最後まで通ることを確認する。

権限は `www.pixiv.net`（表示とAPI）と `i.pximg.net`（うごイラのzip取得）だけ。
AIモデルと実行ライブラリは大きいのでリポジトリには入れず、`package.json` でバージョンを固定している。

## Xcodeプロジェクトにする（Macが必要）

```sh
npm install
node scripts/build-safari.cjs
xcrun safari-web-extension-converter dist/safari-extension \
  --project-location safari-app --app-name "pixiv縦スクロール" \
  --bundle-identifier <自分の識別子> --copy-resources
```

`--copy-resources` を付けると拡張機能のファイルがXcodeプロジェクト側にコピーされる。
本体を更新したら、ビルドし直して `safari-app` 内のResourcesへ上書きコピーする。

- Mac: Xcodeで実行 → Safariの設定 → 拡張機能 で有効にする。署名なしで試す場合はSafariの「開発」メニューで未署名の拡張機能を許可する。
- iPhone: XcodeでiOSターゲットを実機に向けて実行 → 設定 → Safari → 拡張機能 で有効にし、pixiv.netへのアクセスを「許可」にする。

## 注意

- 無料のApple IDで実機に入れたアプリは7日で期限が切れる。入れっぱなしにする、または他の人に配るには Apple Developer Program（有料）が必要。
- Userscripts版と同時に有効にすると二重に起動するので、どちらか片方だけ有効にする。
- 設定や学習データはpixiv.netのlocalStorageに保存されるので、Userscripts版から引き継がれる。
- Safari実機での動作は未検証。確認済みなのはChromiumでの読み込みと起動まで。
