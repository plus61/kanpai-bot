# Kanpai Bot — 目的・アーキテクチャ

> 最終更新: 2026-04-01

---

## 🎯 目的

**Kanpai Bot** は、LINEグループで「どこ飯食う？」問題を解決する AI 幹事 Bot。

### 解決する課題
- グループで店を決めるのに時間がかかる（全員が意見を言わない、話が流れる）
- 誰かが幹事をやらされて疲弊する
- いつも同じ店になりがち

### 提供する価値
- 自然な会話から条件（エリア・予算・ジャンル等）を読み取り、即座に店舗候補を提案
- 過去の食事履歴を記憶して被り防止
- 意見が分かれたとき投票を自動整理
- 幹事の代わりに個別 DM で本音を収集・統合

### 収益化
- FLEXカードの「🍽 食べログで予約する」ボタンに **ValueCommerce アフィリエイトリンク** を埋め込み
  - sid=3765360 / pid=892584846（固定）
  - `vc_url` に食べログ検索 URL を動的生成して付与
  - ユーザーが予約するたびにアフィリエイト報酬が発生

---

## 🏗️ アーキテクチャ

```
LINE グループ
    │ Webhook (POST /webhook)
    ▼
index.js（メインルーター・Vercel サーバーレス）
    ├─ brain.js     ← AI 思考エンジン（OpenAI GPT-4o-mini）
    ├─ search.js    ← 店舗検索（HotPepper API → Google Places フォールバック）
    ├─ flex.js      ← LINE FLEX メッセージ生成 + アフィリエイト URL 付与
    ├─ memory.js    ← 会話・状態管理（Supabase）
    ├─ kanji.js     ← 自律幹事エンジン（cron・連投防止）
    └─ collector.js ← 個別 DM 収集エンジン
```

### インフラ

| レイヤー | サービス | 用途 |
|---|---|---|
| ホスティング | **Vercel** (Serverless) | API エンドポイント |
| AI | **OpenAI GPT-4o-mini** | 会話理解・店舗提案文生成 |
| 店舗データ | **HotPepper グルメ API** | 実在店舗の検索（無料） |
| 店舗データ(FB) | **Google Places API** | HotPepper 0 件時のフォールバック |
| DB | **Supabase** (PostgreSQL) | 会話ログ・グループ状態・検索キャッシュ |
| メッセージング | **LINE Messaging API** | Webhook 受信・FLEX メッセージ送信 |
| アフィリエイト | **ValueCommerce** (食べログ) | 予約リンクからの収益化 |

---

## 📁 ファイル構成

### `index.js` — エントリーポイント
- LINE Webhook の受信・署名検証
- メッセージタイプ別ルーティング（通常会話 / 投票 / DM 返答 / etc）
- 主要フロー: `handleFoodSuggestion()` が店舗提案の中心処理
- エンドポイント一覧:
  - `POST /webhook` — LINE からの Webhook
  - `GET /track` — タップ計測・HotPepper リダイレクト
  - `GET /cron/*` — Vercel Cron ジョブ（DM タイムアウト・投票タイムアウト・自律監視）
  - `POST /test/simulate` — テスト用シミュレーター

### `brain.js` — AI 思考エンジン
- `KANPAI_SYSTEM`: ベースシステムプロンプト（URLは絶対に生成しない指示）
- 主要関数:
  - `generateFoodSuggestion()` — 会話文脈から店舗提案テキストを生成
  - `shouldKanpaiRespond()` — 発言すべきか判断（発火条件）
  - `guessGenreFromMessages()` — ジャンル推定
  - `extractPreviousGenre()` — 前回提案ジャンルの抽出
- シナリオ別 `extraInstruction` で GPT に追加指示（他にある？/条件変更/個人店指定等）

### `search.js` — 店舗検索エンジン
- `searchRestaurants()` — メイン検索（段階的フォールバック付き）
  1. HotPepper（ジャンル + 予算）
  2. HotPepper（予算なし）← 地方エリア対策
  3. HotPepper（ジャンル・予算なし）
  4. Google Places
- `extractArea()` — 会話からエリア名を抽出
- `AREA_CODES` — エリア名 → HotPepper `large_service_area_code` マッピング
- Supabase の `restaurant_cache` テーブルに 24h キャッシュ

### `flex.js` — FLEX メッセージ生成
- `buildRestaurantCarousel()` — 複数店舗のカルーセル FLEX を生成
- `buildShopBubble()` — 1 店舗分のバブル（カード）生成
  - フッターに 3 ボタン:
    1. 「🏃 今すぐ席を押さえる」（HotPepper タップ計測 URL）
    2. 「📋 コース予約はこちら」（HotPepper タップ計測 URL）
    3. 「🍽 食べログで予約する」（ValueCommerce アフィリエイト URL）← 収益化
- `getTabelogAffiliateUrl(shopName, area)` — 食べログアフィリ URL を動的生成
- `trackUrl()` — `/track` エンドポイント経由のタップ計測 URL を生成

### `memory.js` — データ層（Supabase）
- テーブル:
  - `group_messages` — 会話ログ（groupId / userId / message）
  - `group_states` — グループごとの状態（state / last_bot_message_at 等）
  - `food_history` — 食事履歴（被り防止用）
  - `restaurant_cache` — HotPepper 検索結果キャッシュ（24h）
  - `dm_sessions` — DM 収集セッション管理
  - `tap_events` — タップ計測ログ

### `kanji.js` — 自律幹事エンジン
- 一定時間メッセージがないグループを監視
- 「そろそろ決めましょ？」的な自律メッセージ（連投防止: 1h 間隔）
- 投票タイムアウト処理

### `collector.js` — DM 収集エンジン
- グループメンバーに個別 DM を送り、希望（ジャンル・予算・苦手等）を収集
- 全員の回答を統合して最適解を提案

---

## 🔄 主要フロー

### 通常の店舗提案フロー

```
ユーザー「渋谷で飲みたい」
    │
    ▼ handleFoodSuggestion()
brain.js: shouldKanpaiRespond() → 発火判定
    │
    ▼
search.extractArea() → "渋谷" 抽出
brain.guessGenreFromMessages() → '5'（居酒屋）
search.extractBudget() → '2'（〜4,000円）
    │
    ▼ search.searchRestaurants()
HotPepper API 検索 → 3件取得
    │
    ▼ flex.buildRestaurantCarousel()
FLEX カード生成（店名・予算・アクセス + 3ボタン）
    │
    ▼
LINE に FLEX メッセージ送信
```

### アフィリエイトリンク生成

```javascript
// flex.js
function getTabelogAffiliateUrl(shopName, area) {
  const tabelogSearchUrl =
    `https://tabelog.com/rstLst/?vs=1&sa=${encodeURIComponent(area)}&keyword=${encodeURIComponent(shopName)}`;
  return `https://ck.jp.ap.valuecommerce.com/servlet/referral`
       + `?sid=3765360&pid=892584846`
       + `&vc_url=${encodeURIComponent(tabelogSearchUrl)}`;
}
```

---

## 🔧 環境変数

| 変数名 | 用途 |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Webhook 署名検証 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE API 送信 |
| `OPENAI_API_KEY` | GPT-4o-mini 呼び出し |
| `HOTPEPPER_API_KEY` | HotPepper グルメ API |
| `GOOGLE_PLACES_API_KEY` | Google Places API（フォールバック用）|
| `SUPABASE_URL` | Supabase 接続先 |
| `SUPABASE_SERVICE_KEY` | Supabase 認証 |
| `TEST_SECRET` | `/test/simulate` 認証 |
