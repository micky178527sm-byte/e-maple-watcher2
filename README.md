# e-maple-watcher

e-Maple モントリオールの**求人**クラシファイドを定期巡回し、新着/更新があれば
**投稿の本文込みで Telegram に通知**するツール。

- 監視対象: <http://www.e-maple.net/classified.html?cat=WO&area=MO>
- 通知先: **Telegram**（無料・送信上限なし）※旧 LINE 版から移行
- 実行基盤: **Cloudflare Workers Cron**（無料・24/7・GitHub Actions 不要）※旧 GitHub Actions から移行

通知の例:

```
📋 e-Maple モントリオール求人

Restaurant bar Otto 周に2-3日出れるパートタイマーを募集しています。
キッチンヘルプ&主に皿洗い。英語力必要。賄い、チップ有り。担当者 豊

🏷 求人してます / レストラン/飲食業
👤 Bar_Otto
✉️ tengoku_hi@hotmail.com
🕐 2026-06-18 04:20
🔗 詳細を開く（No.439938）
```

---

## 構成

| パス | 役割 |
|------|------|
| `worker/src/index.js` | 本体（巡回・パース・Telegram 通知） |
| `worker/wrangler.toml` | cron トリガー + KV バインディング設定 |

---

## セットアップ（Cloudflare Worker）

### 1. Telegram Bot を作る

1. Telegram で **@BotFather** を開き `/newbot` を実行。名前とユーザー名を決める。
2. 発行された **Bot トークン**（`123456:ABC-...`）を控える。
3. 作った Bot との会話を開き、何かメッセージを1通送る（これをしないと chat_id が取れない）。
4. chat_id を取得:
   ```
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   返ってきた JSON の `message.chat.id` が **chat_id**（自分宛なら整数1つ）。

### 2. Cloudflare にデプロイ

```bash
cd worker
npm install                       # wrangler を導入
npx wrangler login                # 初回のみ

# 状態保存用の KV を作成し、出力された id を wrangler.toml の REPLACE_WITH_KV_NAMESPACE_ID に貼る
npx wrangler kv namespace create STATE

# 認証情報を secret として投入（平文でファイルに書かない）
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID

# デプロイ
npx wrangler deploy
```

### 3. 動作確認と初期化

デプロイ後の Worker URL（`https://e-maple-watcher.<account>.workers.dev`）に対して:

```bash
curl "https://<worker-url>/test"   # Telegram にテスト通知 → 届けば認証OK
curl "https://<worker-url>/init"   # 現在の最新を「基準」として記録（過去分の大量通知を防ぐ）
```

以後は `wrangler.toml` の cron（既定: 10分ごと）で自動巡回し、新着のみ通知する。

### 手動エンドポイント

| エンドポイント | 動作 |
|----------------|------|
| `GET /test` | Telegram 接続テスト通知 |
| `GET /init` | 通知せず現在の最新を基準に記録 |
| `GET /run`  | 1回巡回（新着があれば通知） |
| `GET /state`| 現在の保存状態（last_dt / seen_nos）を表示 |

ログ確認: `npx wrangler tail`

---

## 移行メモ

- **LINE → Telegram**: LINE Messaging API は無料枠が月200通に縮小。Telegram は実質上限なし。
- **GitHub Actions → Cloudflare Workers**: GitHub Actions の課金化リスクを回避。Cloudflare の無料 cron で 24/7 巡回。Mac の電源状態に依存しない。
- 状態（`last_dt` / `seen_nos`）は GitHub のリポジトリ commit → Cloudflare KV に移行。
