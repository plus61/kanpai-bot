/**
 * index.js - Kanpai Bot メインエントリーポイント
 * LINE Webhookを受け取り、イベントをルーティングする
 */
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const memory = require('./memory');
const brain = require('./brain');
const kanji = require('./kanji');
const collector = require('./collector');
const flex = require('./flex');
const { buildRelaxedSearchPreamble } = require('./search-preamble');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const app = express();
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

/**
 * LINE署名検証。チャネルシークレット未設定時は本番では拒否、開発時のみ通過。
 */
function verifyLineSignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signature) return false;
  const expected = crypto.createHmac('SHA256', secret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(signature, 'base64'); } catch (e) { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * /track の転送先を許可ドメインに限定する（F0-4: オープンリダイレクト対策）
 */
const REDIRECT_ALLOWED_HOSTS = [/^(.+\.)?hotpepper\.jp$/, /^(.+\.)?google\.(com|co\.jp)$/, /^maps\.app\.goo\.gl$/];
const DEFAULT_REDIRECT = 'https://www.hotpepper.jp/';
function safeRedirect(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return DEFAULT_REDIRECT;
    return REDIRECT_ALLOWED_HOSTS.some(re => re.test(u.hostname)) ? u.toString() : DEFAULT_REDIRECT;
  } catch (e) {
    return DEFAULT_REDIRECT;
  }
}

/**
 * /test/simulate 用: リクエスト単位で返信を横取りする（F0-5）。
 * 共有の lineClient を差し替えないので、本番の返信と混ざらない。
 */
const simulateStore = new AsyncLocalStorage();

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// /test/simulate 実行中だけ返信を収集する（それ以外は通常どおり送信）
const _replyMessage = lineClient.replyMessage.bind(lineClient);
lineClient.replyMessage = async (req) => {
  const sim = simulateStore.getStore();
  if (sim) {
    sim.responses.push(...(req.messages || []));
    return { sentMessages: (req.messages || []).map((m, i) => ({ id: `mock-${i}` })) };
  }
  return _replyMessage(req);
};

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
        // 署名検証（F0-3: 不一致・欠落は拒否する）
        if (!verifyLineSignature(rawBody, req.headers['x-line-signature'])) {
          console.warn('[webhook] signature invalid - rejected');
          return res.status(401).send('invalid signature');
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
const path = require('path');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
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
  const hasFoodContext = /ランチ|ディナー|ご飯|飯|めし|食べ|飲み|飲も|居酒屋|焼肉|ラーメン|寿司|中華|パスタ|カレー|お腹|腹|うまい|美味|おいしい|お店|店|おすすめ|どこ行く|どこ食べ|いいとこ|安くて|奮発|記念日|予約|ジャンル|和食|洋食|イタリアン|焼き鳥|鍋|しゃぶ|行きたい|食いたい|デート|いい感じ|雰囲気|探してる|ベジタリアン|ヴィーガン|アレルギー|チェーン|大人数/.test(text);
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

      // 予約リンクリクエスト検出（直前の提案の予約URLを返す）
      if (/そこ予約|予約できる|予約したい|予約リンク|予約URL/.test(text)) {
        const recentBotMsgs = await memory.getRecentMessages(groupId, 10);
        const lastBotFlex = recentBotMsgs.find(m => m.display_name === 'Kanpai' && m.message.includes('見つけたよ'));
        // 直前のFlex提案があった場合、予約を促す応答+HotPepperリンク
        const hotpepperLink = 'https://www.hotpepper.jp/';
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [
            { type: 'text', text: 'さっき提案したお店のカードにある「コース予約はこちら」ボタンから予約できるよ📋✨ カードをもう一度見てみて！' },
            { type: 'text', text: `🔗 HotPepperで直接探すならこちら:\n${hotpepperLink}` },
          ]
        });
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

      // ソフトシグナル検出（「何食べようかな」「お腹すいた」→ 軽い提案 or 質問返し）
      const isSoftSignal = /何食べ(よう|たい)?かな|お腹すいた|お腹空いた|腹減った|腹へった/.test(text);
      const isExplicitRequest = /教えて|ある[？?]|ない[？?]|行きたい|食べたい|探して|予約|おすすめ/.test(text);
      if (isSoftSignal && !isExplicitRequest) {
        const recentMessages = await memory.getRecentMessages(groupId, 10);
        const response = await brain.generateFreeResponse(recentMessages, text, displayName);
        if (typeof response === 'string') {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: response }]
          });
        } else {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: Array.isArray(response) ? response : [response]
          });
        }
        await memory.updateLastBotMessage(groupId);
        return;
      }

      // 食事提案のトリガーワード
      const foodTriggers = [
        '何食べる', 'なに食べる', 'どこ行く', 'ご飯', '飯どこ',
        'なに食べ', '何食べ', 'お腹すいた', 'おすすめ', 'オススメ', 'おすすめある',
        '何がいい', 'どこがいい', 'どこ食べ', '飯どうする', 'めし',
        'ランチ', 'ディナー', '夜ごはん', '昼ごはん',
        // S04: 飲み系
        '飲める', '飲み', '飲もう', '一杯',
        // S18: 時間制約
        '食べ終われる', '時間以内',
        // S23: 深夜
        '深夜', '開いてる', '開いてるとこ',
        // 追加: 曖昧・条件系（S09-S15対応）
        '安くて', '安い', '奮発', '記念日', '特別な', '予約',
        '他にある', '他ある', '他は', '別の',
        '駅近', 'いい店', 'いいとこ', 'いいお店', 'お店ある',
        'とこない', '店ある', '店教えて',
        '苦手', '除いて', '抜きで', 'なしで',
        '焼肉', '中華', 'ラーメン', '寿司', 'イタリアン', '和食', '洋食',
        '居酒屋', '焼き鳥', '鍋', 'しゃぶ', 'カレー',
        '食べたい', '行きたい', '食いたい',
        // S24: 再提案系
        '提案して', '違う提案',
        'この辺', 'この辺で', 'そこ予約',
        // S16: デート・雰囲気系
        'デート', 'いい感じ', '雰囲気', 'おしゃれ', 'カップル', '2人で',
        // S17: 大人数系
        '探してる', '探して', '人以上', '大人数', '大勢', '大きい店', '広い店',
        // S19: 食事制限・条件系
        'ベジタリアン', 'ヴィーガン', 'アレルギー', '食べられる', 'グルテン', '菜食',
        // S21: チェーン・こだわり系
        'チェーン', 'じゃないところ', 'ところがいい', '個人店', 'こだわり',
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
        const approachMsg = await brain.generateProactiveApproach(planCtx, recentMsgs, groupId);
        if (approachMsg) {
          const messages = typeof approachMsg === 'string'
            ? [{ type: 'text', text: approachMsg }]
            : Array.isArray(approachMsg) ? approachMsg : [approachMsg];
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages
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
            recentMessages, foodHistory, result, session.group_id
          );
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (typeof suggestion === 'string') {
            await kanji.sendToGroupForce(session.group_id, suggestion);
          } else {
            await lineClient.pushMessage({ to: session.group_id, messages: Array.isArray(suggestion) ? suggestion : [suggestion] });
          }
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

    // Flex or text response
    if (Array.isArray(response)) {
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: response
      });
      const savedText = response
        .map(message => message.type === 'text' ? message.text : message.type === 'flex' ? message.altText : '')
        .filter(Boolean)
        .join('\n');
      if (savedText) await memory.logMessage(groupId, 'bot', 'Kanpai', savedText);
    } else if (response && typeof response === 'object' && response.type === 'flex') {
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [response]
      });
      // altTextをKanpaiのメッセージとして保存（コンテキスト継続のため）
      if (response.altText) {
        await memory.logMessage(groupId, 'bot', 'Kanpai', response.altText);
      }
    } else {
      const responseText = typeof response === 'string' ? response : JSON.stringify(response);
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: responseText }]
      });
      // Kanpaiの応答もgroup_messagesに保存（コンテキスト継続のため）
      await memory.logMessage(groupId, 'bot', 'Kanpai', responseText);
    }

    await memory.updateLastBotMessage(groupId);
  } catch (e) {
    console.error('handleMention error:', e.message);
  }
}

/**
 * 表示する店舗全体の検索緩和条件を、返信とFlex要約で使う順に集約する。
 */
function mergeDisplayedSearchMeta(restaurants) {
  const displayed = restaurants.slice(0, 3);
  const baseSearchMeta = displayed.find(restaurant => restaurant?.searchMeta)?.searchMeta;
  if (!baseSearchMeta) return null;

  const relaxed = new Set(displayed.flatMap(restaurant =>
    Array.isArray(restaurant?.searchMeta?.relaxed) ? restaurant.searchMeta.relaxed : []
  ));
  return {
    ...baseSearchMeta,
    relaxed: ['budget', 'lunch', 'area', 'genre'].filter(condition => relaxed.has(condition)),
  };
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
    const area = search.extractArea(recentMessages);
    const recentText = recentMessages.slice(-5).map(m => m.message).join(' ');
    const currentMessage = recentMessages[recentMessages.length - 1]?.message || '';

    // ユーザーの直近メッセージから検索オプション抽出（ランチ・個室・大人数・デート等）
    const searchOptions = search.extractSearchOptions(currentMessage + ' ' + recentText);

    // ジャンル推定: 直近メッセージを優先
    const genreGuess = brain.guessGenreFromMessages(recentMessages.slice(-5)) || '5';
    searchOptions.genreExplicit = genreGuess !== '5' || /居酒屋/.test(currentMessage + ' ' + recentText);
    // 予算: 現在のメッセージを優先、なければ直近2件のみ参照（古い予算が混入しないように）
    // キーワードベースの予算推定（金額明示なしの場合）
    const inferBudgetFromKeywords = (text) => {
      if (/安く|安い|激安|コスパ|格安/.test(text)) return '1';
      if (/奮発|高級|記念日|接待|特別/.test(text)) return '4';
      return null;
    };
    const budgetGuess = search.extractBudget(currentMessage)
      || inferBudgetFromKeywords(currentMessage)
      || search.extractBudget(recentMessages.slice(-2).map(m => m.message).join(' '))
      || '2';

    // ランチ要求かつジャンルがデフォルト(居酒屋)の場合は和食(ランチ向け)に変更
    // S10/S20: 接待・奮発・記念日 → 高級キーワードで検索 + 居酒屋ジャンルを回避
    const isHighEnd = /接待|奮発|記念日/.test(currentMessage);
    let effectiveGenre = (searchOptions.lunch && genreGuess === '5') ? '1'
      : (isHighEnd && genreGuess === '5') ? '1'
      : genreGuess;

    // S10/S20: 高級検索の場合はキーワードに「高級」「個室」を追加
    if (isHighEnd) {
      if (!searchOptions.keywords) searchOptions.keywords = [];
      if (!searchOptions.keywords.includes('高級')) searchOptions.keywords.push('高級');
      searchOptions.privateRoom = true;
    }

    // S14/S24: 「他にある？」「さっきと違う」→ 前回と異なるジャンルで検索
    const isDifferentRequest = /さっきと違う|別の|他に(ある|ない|は)?|違う(の|店|ところ|提案)|もっと(他|違う)|変えて/.test(currentMessage);
    const isMoreOnly = /他に(ある|ない|は)?[？?]?$|もっと(見|教|出|ある)|他の(店|候補)/.test(currentMessage);
    let diffPrefix = '';
    if (isDifferentRequest) {
      const prevGenre = brain.extractPreviousGenre(recentMessages);
      const genreMap2 = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン', '8': 'カフェ' };
      if (isMoreOnly) {
        // 「他にある？」→ 同じジャンルで別の店
        // ユーザーメッセージから元ジャンルを取得
        const allUserMsgsForHandler = recentMessages.filter(m => m.display_name !== 'Kanpai');
        const userGenreForHandler = brain.guessGenreFromMessages(allUserMsgsForHandler) || prevGenre;
        effectiveGenre = userGenreForHandler;
        const genreName = genreMap2[userGenreForHandler] || 'いい店';
        diffPrefix = `前回と違う${genreName}を探したよ！ほかにもこんな店あったよ🔍`;
        searchOptions.start = 4; // オフセットで前回と違う店を取得
      } else {
        // 「さっきと違う提案して」→ 違うジャンルで
        const prevGenreLabel = genreMap2[prevGenre] || '前回のジャンル';
        const allGenres = ['1', '2', '3', '4', '6', '7', '8']; // '5'(居酒屋)も除外候補
        const availableGenres = allGenres.filter(g => g !== prevGenre);
        effectiveGenre = availableGenres[Math.floor(Math.random() * availableGenres.length)] || '1';
        const newGenreLabel = genreMap2[effectiveGenre] || '別ジャンル';
        diffPrefix = `前回は${prevGenreLabel}だったから、今度は${newGenreLabel}で探したよ！`;
      }
    }

    // エリアがある場合 or 具体的な条件がある場合はHotPepper検索を試みる
    // エリアなしでも東京をデフォルトにして検索（応答なし防止）
    const searchArea = area || '東京';
    try {
      let restaurants = await search.searchRestaurants(effectiveGenre, budgetGuess, searchArea, 3, searchOptions);
      // 高額帯で結果がない場合、一段下の予算でリトライ
      if ((!restaurants || restaurants.length === 0) && budgetGuess === '4') {
        restaurants = await search.searchRestaurants(effectiveGenre, '3', searchArea, 3, searchOptions);
      }
      // S10/S20: まだ0件の場合、高級キーワード + 予算フィルタなし（'2'）でリトライ
      if ((!restaurants || restaurants.length === 0) && isHighEnd) {
        restaurants = await search.searchRestaurants(effectiveGenre, '2', searchArea, 3, searchOptions);
      }
      // S10/S20: 結果が少ない場合、イタリアン・フレンチ(7)でも検索して補完（キーワード緩和）
      if (isHighEnd && restaurants && restaurants.length < 3) {
        const supplementGenres = ['7', '2']; // イタリアン、洋食
        for (const sg of supplementGenres) {
          if (restaurants.length >= 3) break;
          try {
            const extraResults = await search.searchRestaurants(sg, budgetGuess, searchArea, 3 - restaurants.length, { genreExplicit: true });
            if (extraResults && extraResults.length > 0) {
              restaurants = restaurants.concat(extraResults).slice(0, 3);
            }
          } catch (e) { /* ignore */ }
        }
      }
      if (restaurants && restaurants.length > 0) {
        // S04/S22: ユーザー明示予算をFlexのaltTextにも反映（万円も対応）
        const manBudgetMatchFC = currentMessage.match(/([\d.]+)万円?(以内|以下|くらい)?/);
        const userBudgetLabel = manBudgetMatchFC
          ? `${parseFloat(manBudgetMatchFC[1])}万円以内`
          : (currentMessage.match(/([\d,]+)円/) ? `${currentMessage.match(/([\d,]+)円/)[1]}円以内` : null);
        const flexOptions = { ...searchOptions, ...(userBudgetLabel ? { budgetLabel: userBudgetLabel } : {}), ...(diffPrefix ? { prefix: diffPrefix } : {}) };
        const displaySearchMeta = mergeDisplayedSearchMeta(restaurants);
        const displayRestaurants = displaySearchMeta
          ? [{ ...restaurants[0], searchMeta: displaySearchMeta }, ...restaurants.slice(1)]
          : restaurants;
        const flexMsg = flex.buildRestaurantCarousel(displayRestaurants, effectiveGenre, budgetGuess, area || null, groupId, flexOptions);
        if (flexMsg) {
          // ユーザーの条件を反映した導入テキストを生成（currentMessageのみから抽出）
          const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン', '8': 'カフェ' };
          const budgetMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
          const currentOptions = search.extractSearchOptions(currentMessage);
          const parts = [];
          if (area) parts.push(`${area}エリア`);
          if (genreGuess !== '5') parts.push(genreMap[effectiveGenre] || '');
          if (currentOptions.lunch) parts.push('ランチ');
          // S04/S22: ユーザーが明示した予算があればそのまま表示（万円も対応）
          const userManBudgetMatch = currentMessage.match(/([\d.]+)万円?(以内|以下|くらい)?/);
          const userBudgetMatch = currentMessage.match(/([\d,]+)円(以内|以下|くらい)?/);
          if (userManBudgetMatch) {
            parts.push(`${parseFloat(userManBudgetMatch[1])}万円以内`);
          } else if (userBudgetMatch) {
            parts.push(`${userBudgetMatch[1]}円以内`);
          } else if (/奮発|高級|記念日|接待/.test(currentMessage)) {
            parts.push(budgetMap[budgetGuess] || '');
          } else if (budgetGuess && budgetMap[budgetGuess]) {
            parts.push(budgetMap[budgetGuess]);
          }
          if (currentOptions.privateRoom || /個室/.test(currentMessage)) parts.push('個室あり');
          if (currentOptions.partyCapacity) parts.push(`${currentOptions.partyCapacity}人以上OK`);
          if (currentOptions.keywords?.length > 0) parts.push(currentOptions.keywords.join('・'));
          if (/深夜/.test(currentMessage)) parts.push('深夜営業');
          if (/駅近/.test(currentMessage)) parts.push('駅近');
          if (/苦手|嫌い|NG|ダメ/.test(currentMessage)) {
            const dislike = currentMessage.match(/(魚|肉|辛い|生もの|乳製品|卵|小麦)/);
            if (dislike) parts.push(`${dislike[1]}以外`);
          }
          if (/接待/.test(currentMessage)) parts.push('接待向き');
          if (/1時間|時間以内|急ぎ/.test(currentMessage)) parts.push('回転早め');
          const conditionText = parts.filter(Boolean).join('・');
          // S20/S22: 接待・デート系は雰囲気を強調
          let preamble;
          if (diffPrefix) {
            preamble = diffPrefix; // S24: 「前回は〇〇だったから...」
          } else if (/接待|ちゃんとした|しっかりした/.test(currentMessage)) {
            preamble = `静かで個室あり・接待向きの店を探したよ🥂`;
          } else if (/デート|カップル|いい感じの店/.test(currentMessage)) {
            preamble = `雰囲気が良くてデートにぴったりな店を探したよ💕`;
          } else if (/チェーン(店)?じゃない|個人店/.test(currentMessage)) {
            preamble = `チェーン店じゃない個人店を探したよ✨`;
          } else {
            preamble = conditionText
              ? `${conditionText}で探したよ🔍`
              : 'おすすめ見つけたよ🔍';
          }

          const honestPreamble = buildRelaxedSearchPreamble(conditionText, displaySearchMeta);
          if (honestPreamble) preamble = honestPreamble;

          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [
              { type: 'text', text: preamble },
              flexMsg,
            ]
          });
          // KanpaiのFlex応答をgroup_messagesに保存（コンテキスト継続：MT02等のジャンル追跡のため）
          const altText = flexMsg.altText || preamble;
          await memory.logMessage(groupId, 'bot', 'Kanpai', altText);
          await memory.updateLastBotMessage(groupId);
          return;
        }
      }
    } catch (searchErr) {
      console.warn('handleFoodSuggestion: search failed, fallback to AI', searchErr.message);
    }

    // フォールバック: LLMによるテキスト提案
    // 特定ジャンル希望がある場合はgenerateFreeBotResponseで文脈を活かす
    const memberCount = Math.max(2, new Set(recentMessages.map(m => m.display_name)).size);
    let suggestion;
    if (genreGuess && genreGuess !== '5') {
      suggestion = await brain.generateFreeResponse(recentMessages, currentMessage, 'ユーザー');
    } else {
      suggestion = await brain.generateFoodSuggestion(recentMessages, foodHistory, memberCount);
    }

    // Flex返却の場合はそのまま送信
    if (typeof suggestion !== 'string') {
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: Array.isArray(suggestion) ? suggestion : [suggestion]
      });
      await memory.updateLastBotMessage(groupId);
      return;
    }

    // テキスト提案にHotPepper検索リンクを付加（link-required対応）
    const searchKeyword = encodeURIComponent(area || '東京');
    const hotpepperUrl = `https://www.hotpepper.jp/SA12/lst/?keyword=${searchKeyword}`;
    const messages = [{ type: 'text', text: suggestion }];
    // 条件が具体的な場合はHotPepper検索リンクも追加
    if (/教えて|ある[？?]|ない[？?]|探して|行きたい|食べたい|奮発|記念日|接待|デート|飲める|個室/.test(currentMessage)) {
      messages.push({ type: 'text', text: `🔗 HotPepperでもっと探す:\n${hotpepperUrl}` });
      const tabelogUrl = flex.getTabelogAffiliateUrl(area || '東京', area);
      messages.push({ type: 'text', text: `🍽 食べログで予約:\n${tabelogUrl}` });
    }

    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages,
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



/**
 * GET /track - タップ計測 → Supabase記録 → リダイレクト
 */
app.get('/track', async (req, res) => {
  const { type, shop_id, shop_name, group_id, genre, budget, area, redirect } = req.query;
  try {
    await supabase.from('tap_events').insert({
      event_type: type || 'unknown',
      shop_id: shop_id || null,
      shop_name: shop_name || null,
      group_id: group_id || null,
      genre: genre || null,
      budget: budget || null,
      area: area || null,
    });
  } catch (e) {
    console.error('[track] supabase insert error:', e.message);
  }
  res.redirect(302, safeRedirect(redirect || DEFAULT_REDIRECT));
});

/**
 * GET /track/stats - タップ集計（内部確認用）
 */
app.get('/track/stats', async (req, res) => {
  const token = req.headers['authorization'] || req.query.token;
  if (process.env.CRON_SECRET && token !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { data } = await supabase
      .from('tap_events')
      .select('event_type, shop_name, area, tapped_at')
      .order('tapped_at', { ascending: false })
      .limit(500);
    const walkin = data.filter(d => d.event_type === 'walkin').length;
    const reserve = data.filter(d => d.event_type === 'reserve').length;
    const total = data.length;
    res.json({
      total,
      walkin,
      reserve,
      walkin_pct: total ? Math.round(walkin / total * 100) : 0,
      reserve_pct: total ? Math.round(reserve / total * 100) : 0,
      recent: data.slice(0, 10),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    const { groupId, userId, message, secret } = req.body || {};
    // TEST_SECRET 未設定時は常に拒否（未設定同士の一致で通らないようにする）
    if (!process.env.TEST_SECRET || secret !== process.env.TEST_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!groupId || !userId || !message) {
      return res.status(400).json({ error: 'missing required fields: groupId, userId, message' });
    }

    console.log('[test/simulate] groupId:', groupId, 'userId:', userId, 'message:', message);

    const mockEvent = {
      type: 'message',
      replyToken: `test-${Date.now()}`,
      source: { type: 'group', groupId, userId },
      message: { type: 'text', text: message },
    };

    const store = { responses: [] };
    await simulateStore.run(store, () => handleEvent(mockEvent));

    res.json({
      ok: true,
      input: { groupId, userId, message },
      responses: store.responses,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[test/simulate] error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍻 Kanpai Bot running on port ${PORT}`);
});

module.exports = app;
