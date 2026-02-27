/**
 * collector.js - 個別DM収集エンジン
 * グループメンバーにDMを送り、本音を集めて統合する
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

let lineClient = null;
function setLineClient(client) { lineClient = client; }

/**
 * DM収集セッションを開始
 */
async function startCollection(groupId, triggeredBy, memberIds) {
  try {
    const { data } = await supabase
      .from('dm_sessions')
      .insert({
        group_id: groupId,
        triggered_by: triggeredBy,
        member_ids: memberIds,
        responses: {},
        status: 'collecting',
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      })
      .select().single();
    return data;
  } catch (e) {
    console.error('[collector] startCollection error:', e.message);
    return null;
  }
}

/**
 * アクティブなDMセッションを取得
 */
async function getActiveSession(groupId) {
  try {
    const { data } = await supabase
      .from('dm_sessions')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'collecting')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return data;
  } catch (e) { return null; }
}

/**
 * ユーザーIDからグループのセッションを検索（DM応答ルーティング用）
 */
async function getSessionByUserId(userId) {
  try {
    const { data } = await supabase
      .from('dm_sessions')
      .select('*')
      .eq('status', 'collecting')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(10);

    if (!data) return null;
    return data.find(s => {
      const members = s.member_ids || [];
      return members.includes(userId);
    });
  } catch (e) { return null; }
}

/**
 * DM回答を記録
 */
async function recordResponse(sessionId, userId, answers) {
  try {
    const { data: session } = await supabase
      .from('dm_sessions')
      .select('responses')
      .eq('id', sessionId)
      .single();

    const responses = session?.responses || {};
    responses[userId] = { ...answers, answeredAt: new Date().toISOString() };

    await supabase.from('dm_sessions')
      .update({ responses })
      .eq('id', sessionId);

    return responses;
  } catch (e) {
    console.error('[collector] recordResponse error:', e.message);
    return null;
  }
}

/**
 * セッションを完了にする
 */
async function completeSession(sessionId) {
  await supabase.from('dm_sessions')
    .update({ status: 'completed' })
    .eq('id', sessionId);
}

/**
 * メンバーにDMを送信（友達追加済みのみ）
 */
async function sendDMsToMembers(memberIds, groupId, sessionId) {
  if (!lineClient) return { sent: 0, failed: [] };

  const questions = [
    `こっそり教えて🤫\n\n今夜の食事の希望を聞くよ！\n\n**予算は？**\n1️⃣ 〜2,000円\n2️⃣ 〜4,000円\n3️⃣ 〜6,000円\n4️⃣ 6,000円〜\n\n数字で答えてね！（例：2）`
  ];

  let sent = 0;
  const failed = [];

  for (const userId of memberIds) {
    try {
      await lineClient.pushMessage({
        to: userId,
        messages: [{
          type: 'text',
          text: questions[0]
        }]
      });
      sent++;

      // ユーザー状態を記録
      await supabase.from('user_follows').upsert({
        line_user_id: userId,
        is_following: true,
        last_seen: new Date().toISOString()
      }, { onConflict: 'line_user_id' });

    } catch (e) {
      console.error(`[collector] DM failed for ${userId}:`, e.message);
      failed.push(userId);
    }
  }

  return { sent, failed };
}

/**
 * DM回答の収集状態を確認して統合
 */
async function checkAndAggregate(sessionId) {
  try {
    const { data: session } = await supabase
      .from('dm_sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (!session) return null;

    const memberIds = session.member_ids || [];
    const responses = session.responses || {};
    const answeredCount = Object.keys(responses).length;

    // 全員回答 or タイムアウト
    const isComplete = answeredCount >= Math.max(memberIds.length, 1);
    const isExpired = new Date(session.expires_at) < new Date();

    if (isComplete || isExpired) {
      await completeSession(sessionId);
      return aggregateResponses(responses, session.group_id);
    }

    return null; // まだ収集中
  } catch (e) {
    console.error('[collector] checkAndAggregate error:', e.message);
    return null;
  }
}

/**
 * 回答を統合して提案テキストを生成
 */
function aggregateResponses(responses, groupId) {
  const budgetMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
  const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': 'なんでも' };

  const budgets = Object.values(responses)
    .map(r => r.budget)
    .filter(Boolean);

  const genres = Object.values(responses)
    .map(r => r.genre)
    .filter(Boolean);

  const answeredCount = Object.keys(responses).length;

  // 最多投票を取得
  const budgetVotes = {};
  budgets.forEach(b => { budgetVotes[b] = (budgetVotes[b] || 0) + 1; });
  const topBudget = Object.keys(budgetVotes).sort((a,b) => budgetVotes[b]-budgetVotes[a])[0];

  const genreVotes = {};
  genres.forEach(g => { genreVotes[g] = (genreVotes[g] || 0) + 1; });
  const topGenre = Object.keys(genreVotes).sort((a,b) => genreVotes[b]-genreVotes[a])[0];

  const budgetText = budgetMap[topBudget] || '未定';
  const genreText = genreMap[topGenre] || 'なんでも';

  return {
    summary: `📊 みんなの本音を集めたよ（${answeredCount}人が回答）\n\n💰 予算：${budgetText}\n🍽️ ジャンル：${genreText}\n\nこの条件でお店を探すね！`,
    budget: topBudget,
    genre: topGenre,
    answeredCount
  };
}

module.exports = {
  setLineClient,
  startCollection,
  getActiveSession,
  getSessionByUserId,
  recordResponse,
  completeSession,
  sendDMsToMembers,
  checkAndAggregate,
};
