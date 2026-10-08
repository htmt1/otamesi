# たかのぺーじ

このリポジトリはGitHub Pagesの `main / (root)` で公開します。ルートの `index.html` は `public/assets/` を参照する入口です。表示内容を変更するときは、ルートと `public/index.html` の両方のHTMLを更新してください。CSS・JavaScriptは `public/assets/` を更新します。

配布APIはまだ未接続です。管理パスワードも、サーバー側の秘密設定への登録が必要です。

白基調の最小限のホームページと、ゲームの限定アイテムを1件ずつ配る仕組みです。
公開ページに表示するのは「たかのぺーじ」「おもしろそうなこと試す場所」「アイテム定期配布」と「補充中…／受け取る」のボタン、小さな「管理」ボタンです。

## 配布の動き

1. 管理画面でリンクを追加します。最初の1件がすぐに配布対象になります。
2. 誰かが「受け取る」を押すと、その人にだけリンクを返して、そのリンク先を同じタブで開きます。
3. その受け取りから30分間は待機します。次のリンクを受け取れる状態になると自動更新されます。
4. 誰も受け取らなければ、同じ1件を配布し続けます。ストックが空なら補充待ちです。

30分の起点はサイトでの受け取りです。ゲーム内での使用は検知できません。
訪問者がいなくても時間は進みます。常時PCを起動したり、GitHub Actionsを30分ごとに動かす必要はありません。
公開画面は15秒ごとに状況を確認し、配布再開時刻も裏側で1秒ごとに確認します。カウントダウンは表示しません。
抽選ではなく先着方式です。

## 構成

| 場所 | 役割 |
| --- | --- |
| `public/` | GitHub Pagesで公開するページ。秘密情報を置かない |
| `public/assets/config.js` | 説明文、公開APIのURL、Turnstileの公開キー |
| `public/assets/admin.js` | index内の管理ダイアログ。認証はAPI側で行う |
| `worker/src/index.js` | Cloudflare WorkersのAPIと配布ロジック |
| Durable Object | 未配布リンク、配布間隔、受け取り状態を非公開で保存 |
| `.github/workflows/pages.yml` | `public/`だけをGitHub Pagesに公開 |

HTML・CSS・JavaScriptに分けています。あとからゲーム・ツール・記事などのページを `public/` に追加できます。
配布APIを変えずに見た目を変更することもできます。

## まずページを見る

ZIPを展開して、`taka-page` のフォルダーで次を実行します。

```sh
python -m http.server 8080 --directory public
```

Windowsでは `python` の代わりに `py` を使っても構いません。
ブラウザーで `http://localhost:8080` を開きます。API未接続の間は「補充中…」と表示されます。
ファイルのダブルクリックではJavaScriptのモジュールが動かないことがあります。

## 1. Cloudflareに配布機能を置く

Cloudflareのアカウントと、Node.jsの現行LTSを用意します。
`worker` フォルダー内で次を実行します。

```sh
npm ci
npx wrangler login
```

`worker/wrangler.toml` の2項目を自分のドメインに変更します。

```toml
ALLOWED_ORIGINS = "https://あなたのドメイン.com"
TURNSTILE_HOSTNAMES = "あなたのドメイン.com"
```

`www`付きでもアクセスさせる場合はカンマ区切りで両方を登録してください。
Originには `https://` を付け、末尾の `/` は付けません。HOSTNAMESにはホスト名のみを入れます。
`DEV_MODE` は本番で必ず `false` のままにします。

次にCloudflareダッシュボードのTurnstileでウィジェットを作成します。
種類はManaged。自分のドメインを許可し、公開Site KeyとSecret Keyを控えます。
Turnstileを未設定のまま公開すると、受け取りは安全のため拒否されます。

管理パスワードはCloudflareの秘密設定 `ADMIN_TOKEN` に登録します。指定されたパスワードを、下の `secret put` 実行時の入力欄に入力してください。公開ファイルやGitHubにはパスワードも照合用ハッシュも保存しません。8文字以上のパスワードに対応しています。ランダムなキーを使いたい場合の生成例：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

秘密設定に登録したパスワードで、ページの「管理」からログインします。
以下のコマンドを実行して、画面の入力欄にそれぞれの秘密キーを入れます。

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put TURNSTILE_SECRET
npm run deploy
```

初回の秘密キー登録でWorkerの作成を聞かれたら承認します。
登録ができない場合は先に `npm run deploy` を1回実行してから秘密キーを登録します。
デプロイ後に表示される `https://taka-giveaway.〜.workers.dev` を控えます。
`ADMIN_TOKEN` やTurnstile Secret Keyを `wrangler.toml`、`config.js`、GitHubの公開ファイルには記載しません。

## 2. 公開ページを設定する

`public/assets/config.js` に以下を入れます。

```js
export const config = {
  apiBase: 'https://taka-giveaway.あなたのサブドメイン.workers.dev',
  turnstileSiteKey: 'Turnstileの公開Site Key',
  bio: 'おもしろそうなこと試す場所',
  xUrl: 'https://x.com/あなたのID',
};
```

XのURLは今後の拡張用に設定項目を残していますが、現在の最小表示ではリンクを表示しません。説明文は自由に書き換えられます。
Turnstileの確認欄は通常は表示を抑え、操作による確認が必要なときだけ表示します。通信エラー時はダイアログで知らせます。

## 3. GitHubにアップして公開する

新しいGitHubリポジトリを用意し、このZIP内の `taka-page` の中身をルートに置きます。
`public`、`worker`、`.github` が同じ階層に並ぶ形です。ZIPそのものをアップする方式ではありません。
GitHubの画面からアップする場合も `.github/workflows/pages.yml` を忘れずに含めてください。

Gitを使う場合：

```sh
git init
git add .
git commit -m "Create Taka personal page"
git branch -M main
git remote add origin https://github.com/ユーザー名/リポジトリ名.git
git push -u origin main
```

リポジトリの `Settings → Pages → Build and deployment → Source` を `GitHub Actions` にします。
`Actions → Publish page → Run workflow` で公開を開始します。
以降、`main` の `public/` を更新するとページも更新されます。
APIのコードを変更したときは `worker/` で `npm run deploy` を別途実行します。

秘密URLは管理画面から送信するので、公開リポジトリでも未配布リンクがソースに入りません。
ローカルの `.dev.vars`、`.env`、`node_modules`、`.wrangler` はGitに含めません。

## 4. 取得済みの .com ドメインをつなぐ

GitHubの `Settings → Pages → Custom domain` に自分のドメインを入力します。
ドメインを管理しているサービスのDNS画面で、次の設定を行います。

| 種類 | 名前 | 値 |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | あなたのGitHubユーザー名.github.io |

既存のA・AAAAレコードや転送設定が競合しないよう確認します。メール用のMXレコードは変更しません。
DNSが反映されたらGitHub Pagesで `Enforce HTTPS` を有効にします。
ドメインの所有権検証もGitHubの案内に従って実施してください。
上記はGitHub Pagesの公式設定値です。今後の変更は下記の公式ドキュメントを確認してください。
Cloudflareにドメインを移管する必要はありません。APIの `workers.dev` URLをそのまま使えます。

## 5. 配布リンクを追加する

`https://あなたのドメイン.com` の小さな「管理」ボタンを押します。
登録した管理パスワードを入力し、アイテム名・ひとこと・配布URLを追加します。
複数のURLは1行に1件ずつ入力します。追加順に1件ずつ配ります。
一度に100件、ストックは最大500件です。URLはhttps、2048文字以内です。
同じURLは配布済みでも再登録を拒否します。未配布のストックを削除した場合だけ再登録できます。
配布間隔は1〜10080分に変更できます。変更済みの間隔は次の受け取りから適用されます。
一時停止中も、既存の待ち時間は進みます。再開しても待ち時間をリセットしません。

## セキュリティと仕様

- 未配布URLはHTML、JavaScript、公開API、管理用一覧に出しません。難読化や隠しフォルダーに頼らず、サーバー側に保存します。
- 管理画面はindex内のダイアログです。ボタンや画面の構成は解析できますが、パスワードや照合用ハッシュは公開ファイルにはありません。正しいパスワードがないと登録・削除・設定はできません。閉じる・Escape・ログアウトでパスワードをメモリから破棄し、管理内容もクリアします。
- 同時受け取りはDurable Objectの永続トランザクションで直列に処理し、1件を2人に返しません。
- 本人確認はTurnstileをサーバー側で検証し、ホスト名とactionも確認します。IP単位の簡易レート制限もあります。
- CORSは設定したサイトだけ許可します。ただしCORSだけを認証とはみなしていません。
- URLを受け取った本人はリンクを確認・コピー・再共有できます。リンクを最後まで完全に隠すことはできません。
- Turnstileで自動操作を減らしますが、会員登録なしの先着配布です。1人が複数回受け取ることや高度なBotを完全には防ぎません。
- 通信切断時には同じタブの再読み込みで24時間以内の受け取りを復旧できます。復旧用ランダムキーはsessionStorageに保存します。新しいタブやタブを閉じた後の復旧は保証しません。
- 受け取ったURLは復旧のためサーバーで24時間保管し、その後削除します。ログには秘密URLを出しません。
- 訪問者にリンクを返すと配布済みになります。実際のゲーム内引換の成功・失敗や有効期限は判定しません。有効な未使用リンクのみ追加してください。
- 追加履歴は現在20000種類まで。全体の保存容量にも上限があるため、長いURLや説明文を大量に追加すると先に容量上限になります。大規模運用では履歴を個別レコードへ分離する拡張が適しています。
- Cloudflareの利用上限を超えると配布できないことがあります。課金はアカウントのプランと利用量次第です。

## 検証

`worker/` で `npm ci` と `npm test` を実行します。
Miniflareの実際のSQLite-backed Durable Objectで、同時受け取り・リンク非公開・認証・30分待機・復旧・再開・重複拒否を検証します。
`npx wrangler deploy --dry-run` でデプロイ用ビルドを確認できます。
初回公開後、管理画面で自分のテスト用URLを2件追加し、スマホとPCから受け取りを確認してください。
この一式には実際の配布URL、管理パスワードの秘密設定、Cloudflareアカウント、GitHubアカウント、ドメインは設定されていません。管理パスワードをページ内で隠す方式にはせず、公開時にCloudflareの秘密設定への登録が必要です。

## 公式ドキュメント

- GitHub Pages https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- カスタムドメイン https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
- Durable Objects https://developers.cloudflare.com/durable-objects/
- Turnstileのサーバー検証 https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

作成日：2026年10月8日
