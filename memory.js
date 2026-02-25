/**
 * memory.js - Supabaseデータ層
 * Kanpai Botの記憶を管理する
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

/**
 * メッセージをログに記録
 */
async function logMessage(groupId, userId, displayName, message) {
  try {
    await supabase.from('group_messages').insert({
      group_id: groupId,
      line_user_id: userId,
      display_name: displayName,
      message: message,
    });
  } catch (e) {
    console.error('logMessage error:', e.message);
  }
}

/**
 * グループの最近のメッセージを取得（AIの文脈用）
 */
async function getRecentMessages(groupId, limit = 20) {
  try {
    const { data } = await supabase
      .from('group_messages')
      .select('display_name, message, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).reverse();
  } catch (e) {
    console.error('getRecentMessages error:', e.message);
    return [];
  }
}

/**
 * 食事履歴を記録
 */
async function recordFood(groupId, userId, foodItem, category, rawMessage) {
  try {
    await supabase.from('food_history').insert({
      group_id: groupId,
      line_user_id: userId,
      food_item: foodItem,
      category: category || null,
      raw_message: rawMessage,
    });
  } catch (e) {
    console.error('recordFood error:', e.message);
  }
}

/**
 * グループの最近の食事履歴を取得
 */
async function getGroupFoodHistory(groupId, days = 14) {
  try {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data } = await supabase
      .from('food_history')
      .select('line_user_id, food_item, category, eaten_at')
      .eq('group_id', groupId)
      .gte('eaten_at', since.toISOString())
      .order('eaten_at', { ascending: false });

    return data || [];
  } catch (e) {
    console.error('getGroupFoodHistory error:', e.message);
    return [];
  }
}

/**
 * グループ状態を取得または作成
 */
async function getGroupState(groupId) {
  try {
    const { data } = await supabase
      .from('group_states')
      .select('*')
      .eq('group_id', groupId)
      .single();

    if (!data) {
      const { data: newState } = await supabase
        .from('group_states')
        .insert({ group_id: groupId })
        .select()
        .single();
      return newState;
    }
    return data;
  } catch (e) {
    console.error('getGroupState error:', e.message);
    return { group_id: groupId, state: 'idle' };
  }
}

/**
 * グループ状態を更新
 */
async function updateGroupState(groupId, updates) {
  try {
    await supabase
      .from('group_states')
      .upsert({
        group_id: groupId,
        ...updates,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'group_id' });
  } catch (e) {
    console.error('updateGroupState error:', e.message);
  }
}

/**
 * グループメンバーを登録・更新
 */
async function upsertMember(groupId, userId, displayName) {
  try {
    await supabase
      .from('group_members')
      .upsert({
        group_id: groupId,
        line_user_id: userId,
        display_name: displayName,
      }, { onConflict: 'group_id,line_user_id' });
  } catch (e) {
    console.error('upsertMember error:', e.message);
  }
}

/**
 * 投票を作成
 */
async function createVote(groupId, question, options) {
  try {
    const { data } = await supabase
      .from('votes')
      .insert({
        group_id: groupId,
        question: question,
        options: options,
        results: {},
      })
      .select()
      .single();

    if (data) {
      await updateGroupState(groupId, {
        current_vote_id: data.id,
        state: 'voting',
      });
    }
    return data;
  } catch (e) {
    console.error('createVote error:', e.message);
    return null;
  }
}

/**
 * 投票を記録
 */
async function recordVote(groupId, userId, optionIndex) {
  try {
    const state = await getGroupState(groupId);
    if (!state?.current_vote_id) return null;

    const { data: vote } = await supabase
      .from('votes')
      .select('*')
      .eq('id', state.current_vote_id)
      .eq('status', 'active')
      .single();

    if (!vote) return null;

    const results = vote.results || {};
    results[userId] = optionIndex;

    const { data } = await supabase
      .from('votes')
      .update({ results })
      .eq('id', vote.id)
      .select()
      .single();

    return data;
  } catch (e) {
    console.error('recordVote error:', e.message);
    return null;
  }
}

/**
 * 投票を締め切って結果を返す
 */
async function closeVote(groupId) {
  try {
    const state = await getGroupState(groupId);
    if (!state?.current_vote_id) return null;

    const { data: vote } = await supabase
      .from('votes')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', state.current_vote_id)
      .select()
      .single();

    await updateGroupState(groupId, {
      current_vote_id: null,
      state: 'idle',
    });

    return vote;
  } catch (e) {
    console.error('closeVote error:', e.message);
    return null;
  }
}

/**
 * Botが最後にメッセージを送った時刻を更新
 */
async function updateLastBotMessage(groupId) {
  await updateGroupState(groupId, {
    last_bot_message_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  });
}

/**
 * グループの最後の活動時刻を更新
 */
async function touchGroupActivity(groupId) {
  await updateGroupState(groupId, {
    last_activity_at: new Date().toISOString(),
  });
}

module.exports = {
  logMessage,
  getRecentMessages,
  recordFood,
  getGroupFoodHistory,
  getGroupState,
  updateGroupState,
  upsertMember,
  createVote,
  recordVote,
  closeVote,
  updateLastBotMessage,
  touchGroupActivity,
};
