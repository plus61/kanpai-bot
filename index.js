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
const collector = require('./collector');
const flex = require('./flex');

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
collector.setLineClient(lineClient);

// cronジョブ開始（ローカル開発時のみ有効、Vercelでは /cron/* エンドポイントを使用）
if (process.env.NODE_ENV !== 'production') {
  kanji.startCron();
}

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
        // 署名検証（ログのみ、MVPでは通過させる）
        if (sig && process.env.LINE_CHANNEL_SECRET) {
          const crypto = require('crypto');
          const expected = crypto.createHmac('SHA256', process.env.LINE_CHANNEL_SECRET)
            .update(rawBody).digest('base64');
          if (sig !== expected) {
            console.warn('[webhook] signature mismatch (continuing for MVP)');
          } else {
            console.log('[webhook] signature OK');
          }
        }
        next();
      } catch(e) {
        console.error('[webhook] parse error:', e.message);
        res.status(200).send('OK');
      }
    });
  },
  async (req, res) => {
    try {
      const events = req.body.events || [];
      console.log('[webhook] received events:', events.length);
      // イベント処理をレスポンス送信前に完了させる（Vercelサーバーレス対応）
      await Promise.all(events.map(handleEvent));
      // 期限切れセッションを遅延チェック（cron不要でサーバーレス対応）
      kanji.checkDMTimeout().catch(e => console.error('[lazy-check]', e.message));
    } catch (e) {
      console.error('[webhook] handler error:', e.message, e.stack);
    }
    // 処理完了後にレスポンスを返す
    res.status(200).json({ status: 'ok' });
  }
);

/**
 * ヘルスチェック
 */
app.get('/', (req, res) => {
  res.json({ status: 'Kanpai Bot is running 🍻', timestamp: new Date().toISOString() });
});

/**
 * Cron: DMセッションタイムアウト（外部cronサービスから毎分叩く）
 */
app.get('/cron/dm-timeout', async (req, res) => {
  const token = req.headers['authorization'] || req.query.token;
  if (process.env.CRON_SECRET && token !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await kanji.checkDMTimeout();
    res.json({ ok: true, job: 'dm-timeout', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[cron/dm-timeout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Cron: 投票タイムアウト（外部cronサービスから15分ごと）
 */
app.get('/cron/vote-timeout', async (req, res) => {
  const token = req.headers['authorization'] || req.query.token;
  if (process.env.CRON_SECRET && token !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await kanji.checkVoteTimeout();
    res.json({ ok: true, job: 'vote-timeout', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[cron/vote-timeout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Cron: グループ監視（外部cronサービスから30分ごと）
 */
app.get('/cron/monitor', async (req, res) => {
  const token = req.headers['authorization'] || req.query.token;
  if (process.env.CRON_SECRET && token !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await kanji.monitorGroups();
    res.json({ ok: true, job: 'monitor', ts: new Date().toISOString() });
  } catch (e) {
    console.error('[cron/monitor]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 純粋な雑談・挨拶かどうかを判定
 * 食事・飲食関連ワードがある場合はfalseを返す（スキップしない）
 */
function isPureChitchat(text) {
  // 食事・飲食関連ワードがあれば雑談ではない
  const hasFoodContext = /ランチ|ディナー|ご飯|飯|めし|食べ|飲み|飲も|居酒屋|焼肉|ラーメン|寿司|中華|パスタ|カレー|お腹|腹|うまい|美味|おいしい|お店|店|おすすめ|どこ行く|どこ食べ|いいとこ|安くて|奮発|記念日|予約|ジャンル|和食|洋食|イタリアン|焼き鳥|鍋|しゃぶ|行きたい|食いたい/.test(text);
  if (hasFoodContext) return false;

  // 挨拶・雑談パターン（食事ワードなし + これらに一致 → スキップ）
  const chitchatPattern = /^(ハロー?|hello|hi|やあ|おはよ|こんにちは|こんばんは|おっす|よー|どもー?|おつかれ|おやすみ)[！!？?]*$|最近どう|どうよ|元気[？?]|何してる|久しぶり/i;
  return chitchatPattern.test(text.trim());
}

/**
 * イベントハンドラ
 */
async function handleEvent(event) {
  console.log('[event] type:', event.type, 'source:', JSON.stringify(event.source));
  try {
    // グループ or ルームのみ処理（個人DMは除外）
    const source = event.source;
    const isGroup = source.type === 'group' || source.type === 'room';
    const groupId = source.groupId || source.roomId;
    const userId = source.userId;

    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text;

      // 個人DM（1対1）の場合 → DM収集セッションへルーティング
      if (!isGroup) {
        await handleDMResponse(event, userId, text);
        return;
      }

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

      // 純粋な雑談・挨拶はスキップ（店舗提案しない）
      if (isPureChitchat(text)) {
        console.log('[handleEvent] chitchat detected, skipping:', text);
        return;
      }

      // 食事記録を試みる
      const foodData = await brain.extractFoodFromText(text);
      if (foodData.found && foodData.context === '食べた') {
        for (const item of (foodData.items || [])) {
          await memory.recordFood(groupId, userId, item, foodData.category, text);
        }
      }

      // 投票への返答チェック（「1」「2」「3」）
      const voteMatch = text.match(/^[1-5]$/);
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

      // 個別DM収集トリガー（食事トリガーより先にチェック）
      const dmTriggers = [
        '本音で', 'みんなに聞いて', 'こっそり聞いて', '個別に聞いて', 'みんなの希望',
        'みんなに聞いて', '今夜どこ', '今日どこ', 'どこ行く？', 'どこにする？',
        '希望聞いて', 'こっそり教えて', 'みんなの意見'
      ];
      const hasDMTrigger = dmTriggers.some(t => text.includes(t));

      if (hasDMTrigger) {
        await handleDMCollection(event, groupId, userId);
        return;
      }

      // 食事提案のトリガーワード
      const foodTriggers = [
        '何食べる', 'なに食べる', 'どこ行く', 'ご飯', '飯どこ',
        'なに食べ', 'お腹すいた', 'おすすめ', 'オススメ', 'おすすめある',
        '何がいい', 'どこがいい', 'どこ食べ', '飯どうする', 'めし',
        'ランチ', 'ディナー', '夜ごはん', '昼ごはん',
        // 追加: 曖昧・条件系（S09-S15対応）
        '安くて', '安い', '奮発', '記念日', '特別な', '予約',
        '他にある', '他ある', '他は', '別の',
        '駅近', 'いい店', 'いいとこ', 'いいお店', 'お店ある',
        'とこない', '店ある', '店教えて',
        '苦手', '除いて', '抜きで', 'なしで',
        '焼肉', '中華', 'ラーメン', '寿司', 'イタリアン', '和食', '洋食',
        '居酒屋', '焼き鳥', '鍋', 'しゃぶ', 'カレー',
        '食べたい', '行きたい', '食いたい',
        'この辺', 'この辺で', 'そこ予約',
      ];
      const hasFoodTrigger = foodTriggers.some(t => text.includes(t));

      if (hasFoodTrigger) {
        await handleFoodSuggestion(event, groupId);
        return;
      }

      // 食事記録時に確認メッセージを送る
      if (foodData.found && foodData.context === '食べた' && (foodData.items || []).length > 0) {
        const item = foodData.items[0];
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `${item}、記録したよ📝 次の提案に活かすね！` }]
        });
        return;
      }

      // 能動的アプローチ: いつ・どこ・何時が揃ったら自然に割り込む
      const recentMsgs = await memory.getRecentMessages(groupId, 8);
      const planCtx = brain.detectPlanContext(recentMsgs);
      if (planCtx.shouldApproach) {
        const approachMsg = await brain.generateProactiveApproach(planCtx, recentMsgs);
        if (approachMsg) {
          // Flex or テキストを自動判別
          const lineMsg = typeof approachMsg === 'string'
            ? { type: 'text', text: approachMsg }
            : approachMsg; // Flexオブジェクトそのまま
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [lineMsg]
          });
          await memory.updateLastBotMessage(groupId);
        }
      }

    } else if (event.type === 'join') {
      // グループ参加時のあいさつ
      console.log('[join] groupId:', event.source.groupId);
      try {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `乾杯🍻 Kanpaiです！\n\nグループのみんなの食事を記録して、被りなしの提案をする幹事AIです。\n\n使い方は簡単：\n・「ラーメン食べた」→ 記録します\n・「@Kanpai おすすめ教えて」→ 提案します\n・「@Kanpai 焼肉か中華か投票して」→ 投票します\n\nよろしく！🎉`
          }]
        });
        console.log('[join] greeting sent');
      } catch(e) {
        console.error('[join] replyMessage error:', e.message);
      }
    }
  } catch (e) {
    console.error('handleEvent error:', e.message);
  }
}

/**
 * 個別DM収集を開始
 */
async function handleDMCollection(event, groupId, triggeredBy) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );

    // グループメンバーを取得（過去に発言したメンバー）
    const { data: members } = await supabase
      .from('group_members')
      .select('line_user_id')
      .eq('group_id', groupId);

    const memberIds = (members || []).map(m => m.line_user_id).filter(id => id !== triggeredBy);
    const allMemberIds = memberIds.length > 0 ? [...memberIds, triggeredBy] : [triggeredBy];

    // グループに通知
    const memberCountText = allMemberIds.length > 1
      ? `${allMemberIds.length}人`
      : 'あなた';

    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `${memberCountText}にこっそり聞くね🤫\n\nKanpaiを友達追加してない人は先に追加してね！\n\n3分後または全員回答後に提案するよ✨` }]
    });

    // セッション作成（3分タイムアウト）
    const session = await collector.startCollection(groupId, triggeredBy, allMemberIds);
    if (!session) return;

    // 全メンバーにDMを送信
    const result = await collector.sendDMsToMembers(allMemberIds, groupId, session.id);
    console.log(`[dmCollection] sent: ${result.sent}, failed: ${result.failed.length}`);

    if (result.failed.length > 0 && result.sent === 0) {
      // 全員送信失敗 → グループに通知してフォールバック
      await kanji.sendToGroupForce(groupId,
        `ごめん、DMが届かなかった😅\nKanpaiを友達追加してからもう一度「みんなに聞いて」って言って！`
      );
    }
  } catch (e) {
    console.error('[handleDMCollection] error:', e.message);
  }
}

/**
 * 個別DM応答を処理（ステップ式質問）
 */
async function handleDMResponse(event, userId, text) {
  try {
    // アクティブなセッションを探す
    const session = await collector.getSessionByUserId(userId);
    if (!session) {
      // セッションなし → 通常の1対1応答
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: `グループでKanpaiを呼んでね🍻\n「みんなに聞いて」と言うと、こっそりみんなの希望を集めるよ！` }]
      });
      return;
    }

    const responses = session.responses || {};
    const userResponse = responses[userId] || {};

    // ステップ1: 予算収集
    if (!userResponse.budget) {
      const budgetMap = { '1': '2000', '2': '4000', '3': '6000', '4': '9999' };
      if (budgetMap[text]) {
        await collector.recordResponse(session.id, userId, { ...userResponse, budget: text });

        // ステップ2: ジャンルを聞く
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `了解！次に**食べたいジャンル**は？\n\n1️⃣ 和食\n2️⃣ 洋食\n3️⃣ 中華\n4️⃣ 焼肉\n5️⃣ なんでもOK\n\n数字で答えてね！` }]
        });
      } else {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `1〜4の数字で答えてね😊\n\n1️⃣ 〜2,000円\n2️⃣ 〜4,000円\n3️⃣ 〜6,000円\n4️⃣ 6,000円〜` }]
        });
      }
      return;
    }

    // ステップ2: ジャンル収集
    if (!userResponse.genre) {
      const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': 'なんでも' };
      if (genreMap[text]) {
        await collector.recordResponse(session.id, userId, { ...userResponse, genre: text });

        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `ありがとう！回答を受け取ったよ✅\nみんなの回答が集まったらグループに提案するね🍻` }]
        });

        // 全員分揃ったか確認して集計
        const result = await collector.checkAndAggregate(session.id);
        if (result) {
          await kanji.sendToGroupForce(session.group_id, result.summary);
          // 食事提案も続けて送る（好みベース）
          const [recentMessages, foodHistory] = await Promise.all([
            memory.getRecentMessages(session.group_id, 10),
            memory.getGroupFoodHistory(session.group_id, 14)
          ]);
          const suggestion = await brain.generateDMBasedSuggestion(
            recentMessages, foodHistory, result
          );
          setTimeout(async () => {
            if (typeof suggestion === 'string') {
              await kanji.sendToGroupForce(session.group_id, suggestion);
            } else {
              // Flex Message → pushMessage
              await lineClient.pushMessage({ to: session.group_id, messages: [suggestion] });
            }
          }, 2000);
        }
      } else {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `1〜5の数字で答えてね😊\n\n1️⃣ 和食\n2️⃣ 洋食\n3️⃣ 中華\n4️⃣ 焼肉\n5️⃣ なんでもOK` }]
        });
      }
    }
  } catch (e) {
    console.error('[handleDMResponse] error:', e.message);
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
    const search = require('./search');

    const [recentMessages, foodHistory] = await Promise.all([
      memory.getRecentMessages(groupId, 15),
      memory.getGroupFoodHistory(groupId, 14),
    ]);

    // エリアとジャンルを直近会話から抽出してHotPepper検索を試みる
    // extractArea: 直近優先で最新のエリアを返す
    const area = search.extractArea(recentMessages);
    // guessGenreFromMessages: 直近優先でジャンルを返す（コンテキスト引き継ぎ対応）
    const genreGuess = brain.guessGenreFromMessages(recentMessages.slice(-5)) || '5'; // デフォルト: '5'=なんでも/居酒屋
    const budgetGuess = search.extractBudget(recentText) || '2';   // デフォルト: '2'=~4,000円

    // エリアがある場合は必ずHotPepper検索を試みる（ジャンル不明でもデフォルト値で検索）
    if (area) {
      try {
        const restaurants = await search.searchRestaurants(genreGuess, budgetGuess, area, 3);
        if (restaurants && restaurants.length > 0) {
          const flexMsg = flex.buildRestaurantCarousel(restaurants, genreGuess, budgetGuess, area);
          if (flexMsg) {
            await lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [flexMsg]
            });
            await memory.updateLastBotMessage(groupId);
            return;
          }
        }
      } catch (searchErr) {
        console.warn('handleFoodSuggestion: search failed, fallback to AI', searchErr.message);
      }
    }

    // フォールバック: LLMによるテキスト提案
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

// デバッグ：全リクエストをログ（一時的）
app.post('/debug', express.json(), (req, res) => {
  console.log('[debug] body:', JSON.stringify(req.body).substring(0, 200));
  res.json({ received: true, events: (req.body.events || []).length });
});

/**
 * テスト用シミュレーションエンドポイント
 * noaがUI操作なしでKP応答をテストできる
 * 
 * POST /test/simulate
 * Body: { groupId, userId, message, secret }
 * 
 * 応答はLINEに送信されず、JSONで返される
 */
app.post('/test/simulate', express.json(), async (req, res) => {
  try {
    // シークレット認証
    const { groupId, userId, message, secret } = req.body;
    if (secret !== process.env.TEST_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    
    if (!groupId || !userId || !message) {
      return res.status(400).json({ error: 'missing required fields: groupId, userId, message' });
    }
    
    console.log('[test/simulate] groupId:', groupId, 'userId:', userId, 'message:', message);
    
    // 応答を収集するためのモック
    const responses = [];
    const mockReplyToken = `test-${Date.now()}`;
    
    // LINEクライアントの replyMessage をモック
    const originalReply = lineClient.replyMessage.bind(lineClient);
    lineClient.replyMessage = async ({ replyToken, messages }) => {
      if (replyToken === mockReplyToken) {
        responses.push(...messages);
        return { sentMessages: messages.map((m, i) => ({ id: `mock-${i}` })) };
      }
      return originalReply({ replyToken, messages });
    };
    
    // イベントをシミュレート
    const mockEvent = {
      type: 'message',
      replyToken: mockReplyToken,
      source: {
        type: 'group',
        groupId: groupId,
        userId: userId,
      },
      message: {
        type: 'text',
        text: message,
      },
    };
    
    await handleEvent(mockEvent);
    
    // モックを元に戻す
    lineClient.replyMessage = originalReply;
    
    res.json({
      ok: true,
      input: { groupId, userId, message },
      responses: responses,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[test/simulate] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});
