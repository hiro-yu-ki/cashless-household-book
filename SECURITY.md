# Security

## 実装済み防御

- 外部取込は24文字以上のBearer secretを要求し、長さ確認後に一定時間比較します。
- JSON payloadは1MB、文字列長、金額、日時、分割件数・合計を検証します。
- D1 queryは値をbindし、動的table名はコード内allowlistだけを使用します。
- UIは外部文字列をHTMLへ表示する前にescapeします。
- CORSは`ALLOWED_ORIGIN`の完全一致のみを返し、API responseには`nosniff`と`no-referrer`を付与します。
- source event unique index、fingerprint、同期operation IDでreplayと二重登録を抑止します。
- `.env`、`.dev.vars`、Wrangler state、build出力をGit対象外にしています。

## 運用要件

本番ではCloudflare AccessでWorker route全体を本人だけに制限してください。CORSは認証ではありません。ingestion tokenはCloudflare secretとiPhone Shortcutsの本人領域以外に保存せず、漏えい疑い時はrotationします。ログにはtransaction ID、source、status、confidenceだけを出し、raw payload、金額、店舗、tokenは出しません。

本番アプリの実行時依存パッケージはありません。開発依存のWranglerを更新する際は公式releaseと互換性を確認し、local migration、全テスト、stagingを通します。

脆弱性は公開issueへ秘密情報を貼らず、リポジトリ所有者へ非公開経路で、再現条件と影響範囲だけを報告してください。credential、実取引、個人情報を再現資料へ含めないでください。
