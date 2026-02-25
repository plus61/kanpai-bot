# Kanpai Bot 🍻

グループの飲食意思決定を支援するLINE AI幹事Bot

## 機能

- 🍜 **食事自動記録** - 「ラーメン食べた」を自動検出・保存
- 🎯 **被り検知 + 食事提案** - グループの食事履歴から被りを避けた提案
- 📊 **投票フロー** - 「焼肉か中華か投票して」で即投票開始
- 🤖 **AI幹事** - 沈黙・膠着を検知して自然に介入
- 💬 **自由応答** - @Kanpaiメンションで何でも答える

## セットアップ

### 1. 環境変数

```bash
cp .env.example .env
```

`.env`を編集して以下を設定：
- `LINE_CHANNEL_SECRET` - LINE Developersから取得
- `LINE_CHANNEL_ACCESS_TOKEN` - LINE Developersから取得
- `ANTHROPIC_API_KEY` - console.anthropic.comから取得
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` - Supabaseプロジェクトから取得

### 2. Supabaseのテーブル作成

Supabase SQL Editorで `supabase/schema.sql` を実行

### 3. ローカル起動

```bash
npm install
npm run dev
```

### 4. Vercelデプロイ

```bash
npm install -g vercel
vercel deploy
```

### 5. LINE DevelopersでWebhook URLを設定

```
https://your-app.vercel.app/webhook
```

### 6. LINEグループにBotを招待

完成！🎉

## 使い方

| メッセージ例 | 動作 |
|---|---|
| 「ラーメン食べた」 | 食事記録 |
| 「@Kanpai おすすめ教えて」 | 食事提案 |
| 「@Kanpai 焼肉か中華か投票して」 | 投票開始 |
| 投票中に「1」「2」を送信 | 投票 |

## アーキテクチャ

```
LINE Group
    ↓ Webhook
index.js (イベントルーティング)
    ├── brain.js (Claude API思考エンジン)
    ├── memory.js (Supabaseデータ層)
    └── kanji.js (幹事エンジン・cron)
```

## 技術スタック

- Node.js / Express
- LINE Messaging API (@line/bot-sdk)
- Claude API (claude-opus-4-5)
- Supabase (PostgreSQL)
- Vercel
