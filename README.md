> 公開用スナップショットです。実データ、認証情報、運用環境の識別子は含めていません。

# さっと家計簿

決済後の取引を取り込み、重複排除・店舗名正規化・個人履歴によるカテゴリー推定を行う、iPhone向けモバイルファーストPWAです。外部AIや有料APIがなくても、家計簿、分類、オフライン操作は動作します。

## 構成

- `public/`: PWA。Dashboard、取引CRUD、カレンダー、集計、予算、Inbox、マスター、取込、バックアップを含みます。
- `src/worker/`: Cloudflare Worker API。D1を利用します。
- `src/domain/`: 取込アダプター、validation、分類、重複判定、CSV処理です。
- `migrations/`: D1 schemaと同期操作のmigrationです。
- `test/`: Node標準テストのみを利用するローカルテストです。

ブラウザーはオフライン時にIndexedDBへ保存し、接続復帰時にidempotency key付きの待機列を同期します。Workerは`source_event_id`の一意制約とtransaction fingerprintで完全重複を防ぎ、近似一致は確認Inboxへ送ります。返金は通常購入との重複判定から除外します。

## ローカル実行

静的・オフライン画面だけを確認する場合はNode.js 20以上で実行します。

```sh
node scripts/dev-server.js
```

`http://127.0.0.1:8787`を開きます。このサーバーは安全な静的・オフライン開発モードで、API呼出しは503となるためUIはIndexedDBへfallbackします。D1を含む統合開発は次のコマンドを使います。

```sh
npm run db:migrate:local
npm run dev:worker
```

Wranglerは再現可能なローカルD1検証とデプロイ前検証のため、開発依存関係に固定しています。本番変更を行わないdry-runは`npm run deploy:dry-run`で実行できます。

## 検証

```sh
node scripts/check.js all
node --test
node scripts/build.js
```

またはnpmが利用できる環境では`npm run check`です。`check.js`は構文・型の表面検査、秘密値パターンのsecurity scanを行います。build成果物は`dist/`（Git対象外）です。

## 取込

外部取込は`POST /api/ingest`または`POST /api/ingest/{shortcuts|wallet|paypay|suica|aeonpay|credit-card}`です。`Authorization: Bearer <INGEST_API_TOKEN>`が必須です。payload定義は [docs/shortcut-payload.schema.json](docs/shortcut-payload.schema.json)、iPhone設定は [docs/SHORTCUTS.md](docs/SHORTCUTS.md) にあります。

公式の公開取得手段がないサービスに非公開APIは仮定していません。スクリーンショットの端末内`TextDetector`（対応ブラウザーのみ）、clipboard/text、CSV、クイック手入力がfallbackです。画像はサーバーへ送信しません。

Mockは外部送信せずJSON Linesを標準出力します。

```sh
node scripts/mock-wallet.js 10
```

## 設定

`.env.example`を参照し、実値は`.dev.vars`またはCloudflare secretへ設定します。秘密値をGit、Shortcuts手順書、Backlogへ記載しないでください。本番設定は [docs/CLOUDFLARE_DEPLOY.md](docs/CLOUDFLARE_DEPLOY.md) を参照してください。

## 制約

- iOSは他社アプリ通知を監視しません。Wallet Transaction Automation、Shortcuts、CSV、テキスト、画像、手入力のみを利用します。
- ブラウザーの`TextDetector`非対応時は端末内OCRを使えないため、同じ画面から手入力へ移れます。
- 競合同期は最終更新を受け付ける単一利用者向け第一版です。操作IDにより再送は二重適用されません。

プライバシーは [PRIVACY.md](PRIVACY.md)、脆弱性報告と防御設計は [SECURITY.md](SECURITY.md)、引き継ぎは [HANDOVER.md](HANDOVER.md) にあります。
