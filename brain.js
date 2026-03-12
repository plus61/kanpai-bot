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

【絶対禁止】
- **太字** や __下線__ などのmarkdown記法は絶対に使わない（LINEでは文字化けする）
- 「1. 2. 3.」の番号リストより「1️⃣ 2️⃣ 3️⃣」を使う
- 長い返答（5行以上）は避ける

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
          content: `グループ（${memberCount}人）への食事提案。

【絶対に提案禁止（直近で食べたもの）】
${historyText}

【最近の会話】
${chatText}

ルール：
- 上記の禁止リストに含まれるジャンル名・食材名は一切使わない
- 被りゼロの3ジャンルを短く提案する
- markdown禁止（**太字**使わない）`
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

    // お店検索 → Flex優先
    const restaurants = await search.searchRestaurants(
      dmResult.genre, dmResult.budget, area, 3
    );

    if (restaurants && restaurants.length > 0) {
      const { buildRestaurantCarousel } = require('./flex');
      const flexMsg = buildRestaurantCarousel(restaurants, dmResult.genre, dmResult.budget, area);
      if (flexMsg) return flexMsg; // Flexオブジェクト返却
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

/**
 * 会話からいつ・どこ・何時を検出して能動的アプローチ判断
 * @returns {{ shouldApproach: bool, when, where, time, confidence }}
 */
function detectPlanContext(messages) {
  // 直近3メッセージのみ見る（古いコンテキストの混入を防ぐ）
  const recentText = messages.slice(-3).map(m => m.message).join('\n');

  // いつ
  const whenPatterns = [
    /今夜|今晩|今日の夜|本日/,
    /明日|あした/,
    /明後日|あさって/,
    /今週末|来週末|週末/,
    /来週/,
    /(\d+)月(\d+)日/,
    /(月|火|水|木|金|土|日)曜/,
    /今度|次回|そのうち/,
    /大人数|20人|みんなで|全員で/,  // 宴会規模もwhenシグナルに
  ];
  // どこ
  const wherePatterns = [
    /渋谷|新宿|六本木|銀座|池袋|品川|恵比寿|中目黒|表参道|赤坂/,
    /梅田|難波|心斎橋|天王寺|博多|天神|横浜|吉祥寺|下北沢/,
    /名古屋|京都|神戸|福岡|札幌|仙台/,
    /中野|高円寺|三軒茶屋|自由が丘|目黒|五反田|大崎|浜松町/,
    /新橋|有楽町|神田|上野|浅草|錦糸町|武蔵小杉|二子玉川/,
    /駅(の?周辺|近く|前)/,
  ];
  // 何時（「夜」単体はノイズ多いので除外、「夜ごはん」「夜7時」はOK）
  const timePatterns = [
    /(\d{1,2})時(半|頃|ごろ)?/,
    /(\d{1,2}):(\d{2})/,
    /ランチ|ディナー|夕食|夕ごはん|夜ごはん|昼ごはん/,
    /夕方|夜中|深夜|早め|遅め/,
  ];

  // 食べ物・ジャンルも検出シグナルに加える
  const foodPatterns = [
    /ラーメン|焼肉|寿司|カレー|パスタ|中華|イタリアン|焼き鳥|居酒屋|うどん|蕎麦|ピザ|ステーキ|天ぷら/,
    /ご飯|飯|めし|食事|ランチ|ディナー|夜ごはん|昼ごはん|朝ごはん|モーニング/,
    /たこ焼き|もつ鍋|鍋|しゃぶしゃぶ|もんじゃ|焼き肉|飲み|飲もう|飲まない/,
    /宴会|飲み会|送別会|歓迎会|誕生日|合コン|接待|記念日/,
    /磯丸|鳥貴族|串カツ田中|やきとり|居酒屋|酒場|バル|バー/,
  ];

  const whenMatch = whenPatterns.find(p => p.test(recentText));
  const whereMatch = wherePatterns.find(p => p.test(recentText));
  const timeMatch = timePatterns.find(p => p.test(recentText));
  const foodMatch = foodPatterns.find(p => p.test(recentText));

  const matched = [whenMatch, whereMatch, timeMatch, foodMatch].filter(Boolean).length;

  // 過去形・無関係トピックは「最新1メッセージ」だけで判断（前メッセージの汚染防止）
  const latestMsg = messages[messages.length - 1]?.message || '';
  const isPast = /食べたよ|食べたな|食べたね|行ったよ|行ったな|飲んだよ|飲んだな|でした|ました|だった|よかった|映画|ドラマ|ゲーム|仕事|会議|授業/.test(latestMsg);
  // 雑談・挨拶系は最新メッセージが食事文脈でない場合はスキップ（前文脈の汚染防止）
  const isChitchat = /ハロー?|^hello$|^hi$|やあ|おっす|よ[ー〜]+|どもー?|最近どう|どうよ|元気[？?]|何してる|久しぶり|おはよう|こんにちは|おつかれ|おやすみ|ね[ー〜]|だね|だよね|そうだね|わかる|すごい|えー|まじ？|まじか|ほんと|やばい|草|笑|www|笑笑/.test(latestMsg) && !/ランチ|ディナー|飯|ご飯|食べ|飲み|どこ行く|おすすめ|居酒屋|焼肉|ラーメン|中華|和食|洋食|寿司|カレー|お腹|腹|美味|うまい|安くて|奮発|記念日|予約|店/.test(latestMsg);

  // 「わからん」「どうする」だけでは除外
  const isUndecided = matched < 2 || (whenMatch && !whereMatch && !foodMatch && !timeMatch);

  // 2つ以上一致 かつ 過去形でない かつ 雑談でない
  const shouldApproach = matched >= 2 && !isPast && !isChitchat;

  // 既にKanpaiが最近発言していたらスキップ（連投防止）
  const recentBotMsg = messages.slice(-5).find(m => m.display_name === 'Kanpai');
  if (recentBotMsg) return { shouldApproach: false };

  // food×2でもapproach（エリア不明でも食べ物が重なれば発火）
  // food×2: 複数メッセージまたは同一メッセージに食べ物ワード複数
  const foodCount = messages.slice(-3).reduce((count, m) => {
    const text = m.message;
    // 同じ単語の繰り返し（「飲み飲み飲み」）もカウント
    const uniqueHits = foodPatterns.filter(p => p.test(text)).length;
    const repeatBonus = /(.{1,4})\1{2,}/.test(text) && foodPatterns.some(p => p.test(text)) ? 1 : 0;
    return count + Math.min(uniqueHits + repeatBonus, 2);
  }, 0);
  const hasSubstance = !!(whereMatch || foodMatch || timeMatch); // when単独はNG
  // isChitchatの場合はfoodCount条件でも発火しない（P1/P2対策）
  const shouldApproachFinal = (shouldApproach && hasSubstance) || (foodCount >= 2 && !isPast && !isChitchat);

  return {
    shouldApproach: shouldApproachFinal,
    confidence: matched,
    when: whenMatch ? recentText.match(whenMatch)?.[0] : null,
    where: whereMatch ? recentText.match(whereMatch)?.[0] : null,
    time: timeMatch ? recentText.match(timeMatch)?.[0] : null,
  };
}

/**
 * プラン文脈を検出した際の能動的アプローチ（お店検索まで一気にやる）
 */
async function generateProactiveApproach(context, recentMessages) {
  try {
    const area = context.where;
    // 直近3メッセージのみからジャンル推定（直近優先で古い文脈を引きずらない）
    const genreGuess = guessGenreFromMessages(recentMessages.slice(-3));

    // お店検索（エリアが判明している場合）→ Flex優先、fallbackにテキスト
    if (area && genreGuess) {
      const restaurants = await search.searchRestaurants(genreGuess, '2', area, 3);
      if (restaurants && restaurants.length > 0) {
        // Flex Messageオブジェクトを返す（index.jsで判定してreplyMessage）
        const { buildRestaurantCarousel } = require('./flex');
        const flexMsg = buildRestaurantCarousel(restaurants, genreGuess, '2', area);
        if (flexMsg) return flexMsg; // オブジェクト返却
      }
    }

    // Flex生成できない場合は自然な一言で促す
    const chatText = recentMessages.slice(-6)
      .map(m => `${m.display_name}: ${m.message}`).join('\n');
    const contextParts = [
      context.when && `${context.when}`,
      context.where && `${context.where}`,
      context.time && `${context.time}`,
    ].filter(Boolean).join('・');

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 60,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM },
        {
          role: 'user',
          content: `会話から「${contextParts}」が出てきた。
一言だけ自然に割り込む。必ず会話から読み取った情報だけ使う。推測や捏造禁止。markdown禁止。絵文字1個以内。

【直近の会話】\n${chatText}`
        }
      ]
    });

    return response.choices[0].message.content;
  } catch (e) {
    console.error('generateProactiveApproach error:', e.message);
    return null;
  }
}

/**
 * メッセージリストからジャンルを推定（直近メッセージ優先）
 * 最新メッセージから順に確認し、最初にマッチしたジャンルを返す
 */
function guessGenreFromMessages(messages) {
  const orderedMessages = messages.slice().reverse();
  for (const msg of orderedMessages) {
    const genre = guessGenreFromText(msg.message);
    if (genre) return genre;
  }
  return null;
}

/**
 * テキストからジャンルコードを推定
 */
function guessGenreFromText(text) {
  if (/焼肉|ホルモン|BBQ|バーベキュー|焼き肉/.test(text)) return '4';
  if (/ラーメン|らーめん|拉麺|中華|餃子|チャーハン|担々麺|つけ麺/.test(text)) return '3';
  if (/イタリアン|パスタ|ピザ|フレンチ|洋食|ステーキ|ハンバーグ|ステーキのどん/.test(text)) return '2';
  if (/寿司|すし|天ぷら|蕎麦|うどん|和食|割烹|刺身|鍋|しゃぶしゃぶ|もんじゃ|もつ鍋|たこ焼き|磯丸/.test(text)) return '1';
  if (/カレー|インド|エスニック|タイ|居酒屋|飲み|飲もう|鳥貴族|串カツ|酒場|バル/.test(text)) return '5';
  return null;
}

module.exports = {
  extractFoodFromText,
  generateFoodSuggestion,
  generateFreeResponse,
  generateIntervention,
  generateVoteResult,
  generateDMBasedSuggestion,
  detectPlanContext,
  generateProactiveApproach,
  guessGenreFromText,
  guessGenreFromMessages,
};
