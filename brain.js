/**
 * brain.js - OpenAI APIによる思考エンジン
 * Kanpai Botの頭脳（gpt-4o-mini）
 */
require('dotenv').config();
const OpenAI = require('openai');
const search = require('./search');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4o-mini';

const KANPAI_SYSTEM = `あなたは「Kanpai」というLINEグループの幹事AIです。

【性格】
- 明るくて気が利く、でも出しゃばりすぎない
- 理由を添えた提案をする（なぜこれを勧めるか）
- 絵文字を自然に使う（使いすぎない）
- タメ口で話す

【制約】
- 返答は必ず日本語
- LINEグループなので短く読みやすく（長文NG）
- メンバーのプライバシーに配慮する
- 押しつけない、最後は人間が決める

【役割】
- グループの食事決定を助ける
- 食事の被りを防ぐ提案をする
- 投票を整理する
- 空気を読んで自然に会話に入る`;

/**
 * メッセージが食事・飲食に関するかチェックし、食べたものを抽出
 */
async function extractFoodFromText(text) {
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: 'あなたは食事に関するテキスト分析器です。JSONのみ返してください。'
        },
        {
          role: 'user',
          content: `以下のテキストから食べ物・飲み物の情報を抽出してください。

テキスト:「${text}」

以下のJSON形式で返してください（食べ物がない場合はfound: false）:
{
  "found": true/false,
  "items": ["ラーメン", "餃子"],
  "category": "ラーメン/寿司/焼肉/イタリアン/中華/その他",
  "context": "食べた/食べたい/提案"
}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0].message.content;
    return JSON.parse(content);
  } catch (e) {
    console.error('extractFoodFromText error:', e.message);
    return { found: false };
  }
}

/**
 * グループへの食事提案を生成
 */
async function generateFoodSuggestion(recentMessages, foodHistory, memberCount) {
  try {
    const historyText = foodHistory.length > 0
      ? foodHistory.map(f => `・${f.food_item}（${f.category || '?'}）`).join('\n')
      : 'まだ記録なし';

    const chatText = recentMessages.slice(-10)
      .map(m => `${m.display_name}: ${m.message}`)
      .join('\n');

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 400,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM },
        {
          role: 'user',
          content: `グループ（${memberCount}人）への食事提案をお願いします。

【直近の食事履歴】
${historyText}

【最近の会話】
${chatText}

被りを避けた3ジャンルの提案を、理由付きで短く教えてください。`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.error('generateFoodSuggestion error:', e.message);
    return 'ちょっと考え中...🍻 もう一回「@Kanpai おすすめ教えて」って言ってみて！';
  }
}

/**
 * 自由な応答を生成（メンションへの返答）
 */
async function generateFreeResponse(recentMessages, userMessage, displayName) {
  try {
    const chatHistory = recentMessages.slice(-15).map(m => ({
      role: m.display_name === 'Kanpai' ? 'assistant' : 'user',
      content: `${m.display_name !== 'Kanpai' ? m.display_name + ': ' : ''}${m.message}`
    }));

    chatHistory.push({
      role: 'user',
      content: `${displayName}: ${userMessage}`
    });

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM },
        ...chatHistory
      ]
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.error('generateFreeResponse error:', e.message);
    return 'ちょっと考えてる🤔 もう一回言って！';
  }
}

/**
 * グループの空気を読んで介入メッセージを生成
 */
async function generateIntervention(recentMessages, interventionType) {
  try {
    const chatText = recentMessages.slice(-10)
      .map(m => `${m.display_name}: ${m.message}`)
      .join('\n');

    const prompts = {
      silence: 'グループが3時間以上静かです。自然に会話を盛り上げる短いメッセージを1つ作ってください。飲食の話題を絡めてもOK。',
      stalemate: 'みんな「どっちでもいい」「なんでもいい」と言い続けています。投票を提案する短いメッセージを作ってください。',
    };

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM },
        {
          role: 'user',
          content: `【最近の会話】\n${chatText}\n\n${prompts[interventionType] || prompts.silence}`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.error('generateIntervention error:', e.message);
    return null;
  }
}

/**
 * 投票結果を集計してメッセージを生成
 */
async function generateVoteResult(vote) {
  try {
    const options = vote.options;
    const results = vote.results || {};
    const counts = {};

    options.forEach((opt, i) => { counts[i] = 0; });
    Object.values(results).forEach(idx => {
      counts[idx] = (counts[idx] || 0) + 1;
    });

    const winner = parseInt(Object.keys(counts).reduce((a, b) =>
      counts[a] >= counts[b] ? a : b
    ));

    const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
    const resultText = options.map((opt, i) =>
      `${i === winner ? '🏆 ' : ''}${opt}：${counts[i] || 0}票`
    ).join('\n');

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM },
        {
          role: 'user',
          content: `投票が終わりました！結果を発表してください。

【投票内容】${vote.question}
【結果】
${resultText}
【総投票数】${totalVotes}票

勝者を明確にして、短く盛り上げるメッセージをお願いします。`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.error('generateVoteResult error:', e.message);
    const options = vote.options;
    const results = vote.results || {};
    const counts = {};
    options.forEach((opt, i) => { counts[i] = 0; });
    Object.values(results).forEach(idx => { counts[idx] = (counts[idx] || 0) + 1; });
    return `📊 結果発表！\n${options.map((opt, i) => `${opt}：${counts[i] || 0}票`).join('\n')}`;
  }
}

/**
 * DM収集結果をもとに食事提案を生成（Google Places連携）
 */
async function generateDMBasedSuggestion(recentMessages, foodHistory, dmResult) {
  try {
    const budgetMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
    const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': 'なんでも' };

    const budgetText = budgetMap[dmResult.budget] || '未定';
    const genreText = genreMap[dmResult.genre] || 'なんでも';

    // エリアを会話から推定
    const area = search.extractArea(recentMessages);

    // Google Placesでお店検索
    const restaurants = await search.searchRestaurants(
      dmResult.genre, dmResult.budget, area, 3
    );

    // お店が見つかった場合はリスト表示
    if (restaurants.length > 0) {
      const formatted = search.formatRestaurants(
        restaurants, dmResult.genre, dmResult.budget, area
      );
      if (formatted) return formatted;
    }

    // フォールバック: AIによる提案
    const historyText = foodHistory.length > 0
      ? foodHistory.slice(0, 5).map(f => `・${f.food_item}`).join('\n')
      : 'まだ記録なし';

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 350,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM },
        {
          role: 'user',
          content: `みんなの本音を集めたよ！この条件でお店を提案して。

条件：
- 予算：${budgetText}
- ジャンル：${genreText}
- エリア：${area || '指定なし'}
- 回答者：${dmResult.answeredCount}人

最近食べたもの（被りNG）：
${historyText}

具体的なお店の種類・特徴を2〜3個提案して。短く読みやすく！`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.error('generateDMBasedSuggestion error:', e.message);
    return '条件に合うお店を探してるよ🔍 もう少し待って！';
  }
}

module.exports = {
  extractFoodFromText,
  generateFoodSuggestion,
  generateFreeResponse,
  generateIntervention,
  generateVoteResult,
  generateDMBasedSuggestion,
};
