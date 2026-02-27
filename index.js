/**
 * index.js - Kanpai Bot メインエントリーポイント
 * LINE Webhookを受け取り、イベントをルーティングする
 */
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const memory = require('./memory');
const brain = require('./brain');
const kanji = require('./kanji');

const app = express();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 幹事エンジンにLINEクライアントを渡す
kanji.setLineClient(lineClient);

// cronジョブ開始
kanji.startCron();

/**
 * LINE Webhookエンドポイント
 */
app.post('/webhook',
  (req, res, next) => {
    let rawBody = '';
    req.on('data', chunk => { rawBody += chunk; });
    req.on('end', () => {
      try {
        req.body = JSON.parse(rawBody);
        // 署名検証
        const sig = req.headers['x-line-signature'];
        // 署名検証は一時的にスキップ（デバッグ用）
        console.log('[webhook] sig:', sig ? sig.substring(0,20) : 'none');
        next();
      } catch(e) {
        console.error('[webhook] parse error:', e.message);
        res.status(200).send('OK');
      }
    });
  },
  async (req, res) => {
    res.status(200).json({ status: 'ok' });
    try {
      const events = req.body.events || [];
      console.log('[webhook] received events:', events.length);
      await Promise.all(events.map(handleEvent));
    } catch (e) {
      console.error('[webhook] handler error:', e.message);
    }
  }
);

/**
 * ヘルスチェック
 */
app.get('/', (req, res) => {
  res.json({ status: 'Kanpai Bot is running 🍻', timestamp: new Date().toISOString() });
});

/**
 * イベントハンドラ
 */
async function handleEvent(event) {
  try {
    // グループ or ルームのみ処理（個人DMは除外）
    const source = event.source;
    const isGroup = source.type === 'group' || source.type === 'room';
    const groupId = source.groupId || source.roomId;
    const userId = source.userId;

    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text;

      // 送信者名を取得（エラー時はデフォルト）
      let displayName = 'メンバー';
      try {
        if (isGroup && userId) {
          const profile = await lineClient.getGroupMemberProfile(groupId, userId);
          displayName = profile.displayName;
          await memory.upsertMember(groupId, userId, displayName);
        }
      } catch (e) {
        // プロフィール取得失敗は無視
      }

      // ログ記録
      if (isGroup && groupId) {
        await memory.logMessage(groupId, userId, displayName, text);
        await memory.touchGroupActivity(groupId);
      }

      // グループメッセージのみ処理
      if (!isGroup || !groupId) return;

      // 食事記録を試みる
      const foodData = await brain.extractFoodFromText(text);
      if (foodData.found && foodData.context === '食べた') {
        for (const item of (foodData.items || [])) {
          await memory.recordFood(groupId, userId, item, foodData.category, text);
        }
      }

      // 投票への返答チェック（「1」「2」「3」）
      const voteMatch = text.match(/^[1-3]$/);
      if (voteMatch) {
        await handleVoteResponse(event, groupId, userId, parseInt(text) - 1);
        return;
      }

      // @Kanpai / @kanpai メンションチェック
      const isMentioned = text.includes('@Kanpai') || text.includes('@kanpai') ||
                          text.toLowerCase().includes('kanpai');

      if (isMentioned) {
        await handleMention(event, groupId, userId, displayName, text);
        return;
      }

      // 食事提案のトリガーワード
      const foodTriggers = ['何食べる', 'どこ行く', 'ご飯', '飯どこ', 'なに食べ', 'お腹すいた'];
      const hasFoodTrigger = foodTriggers.some(t => text.includes(t));

      if (hasFoodTrigger) {
        await handleFoodSuggestion(event, groupId);
      }

    } else if (event.type === 'join') {
      // グループ参加時のあいさつ
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `乾杯🍻 Kanpaiです！\n\nグループのみんなの食事を記録して、被りなしの提案をする幹事AIです。\n\n使い方は簡単：\n・「ラーメン食べた」→ 記録します\n・「@Kanpai おすすめ教えて」→ 提案します\n・「@Kanpai 焼肉か中華か投票して」→ 投票します\n\nよろしく！🎉`
        }]
      });
    }
  } catch (e) {
    console.error('handleEvent error:', e.message);
  }
}

/**
 * メンション処理
 */
async function handleMention(event, groupId, userId, displayName, text) {
  try {
    const cleanText = text.replace(/@[Kk]anpai/g, '').trim();

    // 投票リクエスト検出
    const voteMatch = cleanText.match(/(.+?)か(.+?)か(投票|決めて|どっち)/);
    if (voteMatch) {
      const options = [voteMatch[1].trim(), voteMatch[2].trim()];
      const question = `${options[0]} vs ${options[1]}`;

      const vote = await memory.createVote(groupId, question, options);
      if (vote) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `📊 投票スタート！\n\n${question}\n\n1️⃣ ${options[0]}\n2️⃣ ${options[1]}\n\n番号で投票してね！（1時間で締め切ります）`
          }]
        });
        return;
      }
    }

    // 食事提案リクエスト
    const suggestionTriggers = ['おすすめ', 'どこ', '何食べ', '提案', 'ご飯'];
    if (suggestionTriggers.some(t => cleanText.includes(t))) {
      await handleFoodSuggestion(event, groupId);
      return;
    }

    // 自由応答
    const recentMessages = await memory.getRecentMessages(groupId, 15);
    const response = await brain.generateFreeResponse(recentMessages, text, displayName);

    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: response }]
    });

    await memory.updateLastBotMessage(groupId);
  } catch (e) {
    console.error('handleMention error:', e.message);
  }
}

/**
 * 食事提案処理
 */
async function handleFoodSuggestion(event, groupId) {
  try {
    const [recentMessages, foodHistory] = await Promise.all([
      memory.getRecentMessages(groupId, 15),
      memory.getGroupFoodHistory(groupId, 14),
    ]);

    // メンバー数取得（概算）
    const memberCount = Math.max(2, new Set(recentMessages.map(m => m.display_name)).size);

    const suggestion = await brain.generateFoodSuggestion(recentMessages, foodHistory, memberCount);

    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: suggestion }]
    });

    await memory.updateLastBotMessage(groupId);
  } catch (e) {
    console.error('handleFoodSuggestion error:', e.message);
  }
}

/**
 * 投票応答処理
 */
async function handleVoteResponse(event, groupId, userId, optionIndex) {
  try {
    const state = await memory.getGroupState(groupId);
    if (state?.state !== 'voting') return;

    const vote = await memory.recordVote(groupId, userId, optionIndex);
    if (!vote) return;

    // リアクションとして確認
    // 投票数チェック（全員投票したら締め切り）
    const totalVotes = Object.keys(vote.results || {}).length;
    if (totalVotes >= 3) {
      const resultMessage = await brain.generateVoteResult(vote);
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: resultMessage }]
      });
      await memory.closeVote(groupId);
    }
    // 個別確認は送らない（静かに記録）
  } catch (e) {
    console.error('handleVoteResponse error:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍻 Kanpai Bot running on port ${PORT}`);
});

module.exports = app;
