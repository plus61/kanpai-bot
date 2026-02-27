/**
 * kanji.js - 幹事エンジン
 * グループを監視して自律的に動く
 */
const cron = require('node-cron');
const memory = require('./memory');
const brain = require('./brain');

let lineClient = null;

function setLineClient(client) {
  lineClient = client;
}

/**
 * Botが最後にメッセージを送ってから十分時間が経っているか確認
 * （連投防止：1時間以内は送らない）
 */
async function canBotSpeak(groupId) {
  const state = await memory.getGroupState(groupId);
  if (!state?.last_bot_message_at) return true;

  const lastSpoke = new Date(state.last_bot_message_at);
  const now = new Date();
  const diffMinutes = (now - lastSpoke) / (1000 * 60);
  return diffMinutes >= 60;
}

/**
 * グループに送信（連投チェック付き）
 */
async function sendToGroup(groupId, message) {
  if (!lineClient) return;
  try {
    const canSpeak = await canBotSpeak(groupId);
    if (!canSpeak) {
      console.log(`[kanji] Skip - bot spoke recently in ${groupId}`);
      return;
    }
    await sendToGroupForce(groupId, message);
  } catch (e) {
    console.error(`[kanji] sendToGroup error: ${e.message}`);
  }
}

/**
 * グループに強制送信（クールダウンを無視）
 * DM集計結果など重要なメッセージ用
 */
async function sendToGroupForce(groupId, message) {
  if (!lineClient) return;
  try {
    await lineClient.pushMessage({
      to: groupId,
      messages: [{ type: 'text', text: message }]
    });
    await memory.updateLastBotMessage(groupId);
    console.log(`[kanji] Force-sent to ${groupId}: ${message.substring(0, 50)}...`);
  } catch (e) {
    console.error(`[kanji] sendToGroupForce error: ${e.message}`);
  }
}

/**
 * 膠着検知：「どっちでもいい」「なんでもいい」が続いているか
 */
function detectStalemate(messages) {
  const stalemateWords = ['どっちでもいい', 'なんでもいい', 'どこでもいい', 'わからん', '任せる', 'まかせる'];
  const recent = messages.slice(-6);
  const stalemateCount = recent.filter(m =>
    stalemateWords.some(w => m.message.includes(w))
  ).length;
  return stalemateCount >= 2;
}

/**
 * グループ監視（30分ごと）
 */
async function monitorGroups() {
  console.log('[kanji] Running group monitor...');
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );

    // アクティブなグループを取得（過去7日以内に活動あり）
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const { data: activeGroups } = await supabase
      .from('group_states')
      .select('group_id, last_bot_message_at, last_activity_at, state')
      .gte('last_activity_at', since.toISOString());

    if (!activeGroups || activeGroups.length === 0) return;

    for (const group of activeGroups) {
      await checkGroup(group);
    }
  } catch (e) {
    console.error('[kanji] monitorGroups error:', e.message);
  }
}

/**
 * 個別グループをチェック
 */
async function checkGroup(groupState) {
  const { group_id } = groupState;

  try {
    const now = new Date();
    const lastActivity = new Date(groupState.last_activity_at);
    const silenceMinutes = (now - lastActivity) / (1000 * 60);

    const recentMessages = await memory.getRecentMessages(group_id, 10);

    // 投票中の場合はスキップ
    if (groupState.state === 'voting') return;

    // 膠着検知
    if (recentMessages.length >= 4 && detectStalemate(recentMessages)) {
      const message = await brain.generateIntervention(recentMessages, 'stalemate');
      if (message) await sendToGroup(group_id, message);
      return;
    }

    // 沈黙検知（3時間以上）
    if (silenceMinutes >= 180 && silenceMinutes < 1440) {
      // 深夜（23:00-08:00 JST）はスキップ
      const hour = new Date().getUTCHours() + 9; // JST
      const jstHour = hour >= 24 ? hour - 24 : hour;
      if (jstHour >= 23 || jstHour < 8) return;

      const message = await brain.generateIntervention(recentMessages, 'silence');
      if (message) await sendToGroup(group_id, message);
    }
  } catch (e) {
    console.error(`[kanji] checkGroup error for ${group_id}: ${e.message}`);
  }
}

/**
 * 投票タイムアウト処理（1時間で自動締め切り）
 */
async function checkVoteTimeout() {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );

    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    const { data: expiredVotes } = await supabase
      .from('votes')
      .select('*')
      .eq('status', 'active')
      .lt('created_at', oneHourAgo.toISOString());

    if (!expiredVotes) return;

    for (const vote of expiredVotes) {
      const resultMessage = await brain.generateVoteResult(vote);
      await sendToGroup(vote.group_id, resultMessage);
      await memory.closeVote(vote.group_id);
    }
  } catch (e) {
    console.error('[kanji] checkVoteTimeout error:', e.message);
  }
}

/**
 * DMセッションタイムアウト処理（3〜5分で自動集計）
 */
async function checkDMSessionTimeout() {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
    );

    const { data: expiredSessions } = await supabase
      .from('dm_sessions')
      .select('*')
      .eq('status', 'collecting')
      .lt('expires_at', new Date().toISOString());

    if (!expiredSessions || expiredSessions.length === 0) return;

    const collector = require('./collector');
    const brain = require('./brain');
    const memory = require('./memory');

    for (const session of expiredSessions) {
      console.log(`[kanji] DM session timeout: ${session.id}`);
      const result = await collector.checkAndAggregate(session.id);
      if (result) {
        await sendToGroupForce(session.group_id, result.summary);
        const [recentMessages, foodHistory] = await Promise.all([
          memory.getRecentMessages(session.group_id, 10),
          memory.getGroupFoodHistory(session.group_id, 14)
        ]);
        const suggestion = await brain.generateDMBasedSuggestion(recentMessages, foodHistory, result);
        setTimeout(async () => {
          await sendToGroupForce(session.group_id, suggestion);
        }, 2000);
      }
    }
  } catch (e) {
    console.error('[kanji] checkDMSessionTimeout error:', e.message);
  }
}

/**
 * cronジョブを開始
 */
function startCron() {
  // 30分ごとにグループ監視
  cron.schedule('*/30 * * * *', () => {
    monitorGroups();
  });

  // 15分ごとに投票タイムアウトチェック
  cron.schedule('*/15 * * * *', () => {
    checkVoteTimeout();
  });

  // 1分ごとにDMセッションタイムアウトチェック
  cron.schedule('* * * * *', () => {
    checkDMSessionTimeout();
  });

  console.log('[kanji] Cron jobs started ✅');
}

module.exports = {
  setLineClient,
  sendToGroup,
  sendToGroupForce,
  startCron,
  detectStalemate,
  checkDMTimeout: checkDMSessionTimeout,
  checkVoteTimeout,
  monitorGroups,
};
