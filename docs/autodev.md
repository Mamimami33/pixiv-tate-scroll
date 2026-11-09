# 自律開発基盤（試験版・2026-11-10）

## 目的と到達範囲

曖昧な改善要望を受け取り、Codexが最新`origin/main`を基準にした専用worktreeで調査・変更し、固定された検査の失敗をフィードバックに最大3回まで再試行する。実装とテストの証拠をローカルに保存し、ユーザーがレビューしてからPRにする。

**現時点で自動化できること:** 新規ブランチ/worktree、非対話Codex実行、構文・単体・既存ブラウザ検査（オプション）、失敗時の再試行、機械可読レポート。
**現時点で未実装:** 自動PR作成、自動マージ、別AIの独立レビュー、iPhone実機の自動操作、長期間無人の常駐実行、正式なOSレベルの隔離環境の構築。これは完成した自律開発サービスではない。

## 安全境界

- `main`には直接書かない。最新`origin/main`をfetchし、`autodev/<timestamp>`のローカルブランチと別worktreeだけを作る。push/merge/公開は自動化しない。
- Codexは公式CLIを既存のアカウントで認証して使う。APIキーを要求しない。`--sandbox workspace-write`で実行し、従量課金APIへの自動フォールバックは作らない。**Codexの利用枠・利用可否は契約とCLIの認証状態に依存**する。
- 子プロセスの環境変数から一般的なAPIキー・トークンを削除するが、これだけでシークレットの隔離は保証できない。CodexのサンドボックスはOSや設定によって制約が異なる。
- Codex自身もコマンドを実行できるため、`--allow-local-tests`の有無では安全を制御できない。**使い捨ての低権限VM/コンテナで外部隔離を確認した場合だけ** `--confirm-isolated-worker` を指定してCodexを開始できる。フラグは自己申告であり隔離を構築しない。日常使いのWindowsホストでは絶対に指定しない。`--allow-local-tests`は隔離済み環境内でランナー側の検査を行うかどうかのみを制御する。
- 操作回数・時間に上限を付ける。失敗したら「成功」にせず結果を残して停止する。テスト合格後でも人間のレビューと実機確認が必要。
- アプリ本体 `pixiv-tate-scroll.user.js` 以外の変更（テスト・CI・ランナー・HTML・新規ファイルを含む）があれば、検査を実行せず `protected_changes_review_required` で停止する。AIが変更した検査を自動合格の証拠にしない。未知のパスも保護する。

## 操作

前提: Git、Python 3.11以上、Node.js、公式Codex CLI（`codex login`等で事前認証）、および隔離された開発環境。ブラウザ回帰を使う場合はPlaywrightとChromiumも用意する。

```sh
# リポジトリ内から。まずは「コード生成のみ」で安全に動作確認する
python tools/autodev.py --doctor

# VM/コンテナ内でのみ。日常利用のWindowsホストでは実行しない
python tools/autodev.py --request "画像読み込みが途中で消える原因を調査して改善する" --confirm-isolated-worker

# 分離された使い捨て環境でのみ、固定テストを実行して再試行まで行う
python tools/autodev.py --request "画像読み込みが途中で消える原因を調査して改善する" --confirm-isolated-worker --allow-local-tests --browser-tests --max-attempts 2
```

`--allow-local-tests`無しでは自動テストを省略し、最初のAI実行後に未検証状態で停止する。実験時のデフォルトはこれ。出力には`branch`、`base_sha`、`worktree`、`report_dir`、`status`が含まれる。`report_dir/report.json`に検査ごとの終了コードと変更ファイル、`agent-N.log`にAIの実行ログを保存する。ログには機密情報が入る可能性があるので共有・公開前に確認する。

status `checks_passed_review_required` は**許可されたローカル検査だけが通過した**意味であり、Safari実機での動作保証ではない。`protected_changes`があれば追加レビューする。

## GitHub Actions

`.github/workflows/verify.yml`はpush/PRで次を実行する：

1. Node構文検査、Pythonの自律ランナーテスト、差分の空白検査
2. Playwright/Chromiumによる既存のモックブラウザ回帰テスト

CIの権限は`contents: read`だけ。AIモデル・APIキーはCIから実行しないため、CIのためのAI API従量課金は不要。ただしGitHub Actionsの利用枠・実行課金条件はアカウントに依存する。CIはpixivの実サーバーやiPhone Safariを検証しない。

## 合格条件（試験版）

- `main`を変更せず、実行ごとにローカルの別ブランチとworktreeが作られる。
- 認証済みCodex CLIが指定要望を受け取り、変更とログが残る。
- テスト有効時には構文・ハーネス・差分・ブラウザ回帰を実行し、失敗を渡して上限内で再試行する。
- 失敗・未実施を「成功」と表示せず、チェック結果と未検証範囲を区別する。
- PRを人間が確認し、別途実機確認するまでは公開しない。

## 次の段階

隔離環境の標準化、テスト仕様の自動生成と人間による検証、ブランチの自動push＋PR作成、GitHub Actions結果の取得、必要時の独立レビュー、実機からのテスト結果入力を順に追加する。これらは今回の試作では実装済みと扱わない。

## 第2段階：モデル実行前の診断・模擬結合試験（2026-11-10）

以前の試作品では、作業worktreeを最新`origin/main`から作ると、未マージの`AGENTS.md`や自律ランナーのテストが存在しない問題があった。修正版は**コントローラー側**の指示書をプロンプトに渡し、ランナーの不変条件テストもコントローラー側から実行する。アプリ本体は最新`origin/main`を基準に扱う。

`python tools/autodev.py --doctor` は外部AIを実行せず、Git・Node・公式Codex CLIとそのログイン状態、Git checkout、originの存在を真偽値で表示する。秘密情報やアカウント識別情報は表示しない。

`tests/test_autodev_integration.py` は、使い捨てのローカルGitリポジトリと**偽のCodex実行ファイル**を使った模擬結合試験。初回のJavaScript構文エラー→失敗情報をAIプロンプトへ渡す→2回目の修正→全検査合格と、元のmainを変更しないことを実行プロセス経由で確認する。本物のモデルが同様に動くことやSafari互換性は証明しない。

Windowsでの次の確認（PC所有者が実行）：

```powershell
git clone https://github.com/Mamimami33/pixiv-tate-scroll.git
cd pixiv-tate-scroll
git fetch origin
git switch feat/autodev-foundation-20261110
python tools/autodev.py --doctor
```

Codex CLIが未導入なら、公式案内に従い`npm install -g @openai/codex@latest`と`codex login`でChatGPTアカウント認証する。APIキーは使わない。インストール・ログインは所有者の明示操作で行う。認証済みでも追加料金が発生しないという絶対保証ではなく、契約・利用枠・認証方法による。

実際のAI開発試験では、低権限の使い捨てVM内で最初は`--allow-local-tests`なしで動かす。VM隔離の検証前にコード実行テストを有効化しない。診断が`ready:true`でも、完成・実機検証済みとはみなさない。


## 第3段階：安全境界と検証の強化（2026-11-10）

- `--confirm-isolated-worker` がない限りAI実行を開始しない。これは確認済みの外部VM/コンテナ隔離の<b>申告</b>でありOSレベルの保護機能そのものではない。ホストからの秘密・ホームディレクトリ・認証情報・SSH・ネットワークへのアクセスを隔離し、ローカルユーザーも低権限にする。
- Git変更一覧は `git status --porcelain=v1 -z` で読み、ファイル名の空白、日本語、リネームの両パス、未追跡ファイルを扱う。
- 自動的に認める変更はアプリ本体のJSファイルだけとする。テストやCIなどを含むそれ以外の変更は検査を実行せずレビュー待ちで終了する。
- ランナー起動の準備確認 `--doctor` はモデルを起動せず従来どおり実行できる。モデル実行と同じ環境に隔離したことを意味しない。
- CIの模擬テストはCodex本物の挙動、実機Safari、実際の隔離や安全性を証明するものではない。
