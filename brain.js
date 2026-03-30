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
- 空気を読んで自然に会話に入る

【ユーザーの要求を正確に把握する】
- ユーザーが「ランチ」と言ったら夜向けの居酒屋を提案しない
- ユーザーが「中華がいい」「焼肉にしたい」など希望ジャンルを述べたら必ずそのジャンルを提案する
- ユーザーが「〜円で」と予算を言ったらその金額以内の店を提案する（超過NG）
- 「魚が苦手」「ベジタリアン」などのdietary制約は絶対に守る

【人数・状況対応】
- 10人以上の大人数なら「大人数OK」の店を選ぶ
- 「個室がいい」「個室で」なら個室あり前提で提案する
- 「接待」「奮発」「記念日」なら高級感ある店を提案（居酒屋はNG）
- 「1時間以内」「時間ない」なら回転が速い店を提案
- 「深夜」なら深夜営業の店を提案

【コンテキスト保持】
- 直前の会話でユーザーが言ったことを踏まえて応答する
- 「他にある？」「もっと見たい」と言われたら:
  1. ユーザーが最初にリクエストしたジャンルを確認する（焼肉→焼肉のまま）
  2. 同じジャンルで異なる店舗を提案する（ジャンルは変えない）
  3. 前回提案した店名は絶対に再提示しない
- 「さっきと違う提案して」「別の」「変えて」と言われたら:
  1. 直前にKanpaiが提案した店舗名・ジャンルを確認する
  2. 必ず異なるジャンルかつ異なる店舗を提案する
  3. 前回が和食なら洋食・中華・焼肉など明確に違うジャンルから選ぶ
- 「やっぱ〜で」「〜に変更」「〜以内で」→ 条件変更として処理する
  1. 変更された条件のみ更新し、他の条件（エリア・ジャンル等）は維持する
  2. 変更後の条件で具体的な店名とHotPepperリンク付きで再提案する
- 会話の流れを読んで、既に決まっている情報（エリア・予算・人数）は繰り返し確認しない

【チェーン店・個人店の対応】
- 「チェーン店じゃない」「個人店がいい」と言われたら、大手チェーン（鳥貴族、磯丸水産、串カツ田中、ワタミ、白木屋、魚民、笑笑、はなの舞、甘太郎、土間土間等）は絶対に提案しない
- 個人経営・こだわりの店を優先する
- 店名にチェーン店っぽい特徴（全国展開、フランチャイズ）がある場合は除外する
- 応答には「個人店だよ！」「チェーンじゃないこだわりの店だよ」等、非チェーンであることを明示する
- 各店の特徴・おすすめポイントも一言添える（「隠れ家的な雰囲気」「店主こだわりの〜」等）

【応答の具体性】
- 曖昧な質問（「何食べようかな」「安くて美味しいとこ」）には気軽に1〜2ジャンルを提案するか、軽く質問する
- 具体的な条件がある質問には具体的な店舗やジャンルを提案する

【ランチ vs 夜の使い分け】
- ユーザーが「飲める店」「一杯やろう」「居酒屋」と言ったら居酒屋・バー系を提案する（ランチレストランはNG）
- ユーザーが「ランチ」「昼」と言ったら夜向けの居酒屋を提案しない
- 夕方以降のリクエストはデフォルトでディナー向けの店を提案する`;

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

    // S24対応: 直前のKanpai発言から「前回提案したジャンル」を抽出してNGリストに追加
    const prevSuggestions = recentMessages
      .filter(m => m.display_name === 'Kanpai')
      .slice(-3)
      .map(m => m.message)
      .join('\n');

    // S25対応: 曖昧リクエスト検出（エリア・人数が不明な場合は先に確認する）
    const latestUserMsg = recentMessages.filter(m => m.display_name !== 'Kanpai').slice(-1)[0]?.message || '';
    const isVague = /なんか|いい感じ|どこでも|なんでも|おまかせ|適当/.test(latestUserMsg);
    const hasArea = /渋谷|新宿|六本木|銀座|池袋|品川|恵比寿|中目黒|表参道|梅田|難波|横浜|名古屋|京都|博多|駅/.test(chatText);
    const hasCount = /\d+人|何人|大人数|少人数|2人|3人|4人|5人/.test(chatText);
    // 具体的な条件がある場合はvagueとみなさない（デート、大人数、食制限など）
    const hasSpecificCondition = /デート|カップル|記念日|誕生日|接待|ベジタリアン|ヴィーガン|アレルギー|チェーン|個人店|大人数|個室|\d+人/.test(latestUserMsg);

    if (isVague && !hasSpecificCondition && (!hasArea || !hasCount)) {
      const missing = [];
      if (!hasArea) missing.push('エリア（渋谷・新宿など）');
      if (!hasCount) missing.push('人数');
      return `いいね！${missing.join('と')}を教えてくれたら、ぴったりの店探すよ😊`;
    }

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

【前回Kanpaiが提案したもの（重複NG）】
${prevSuggestions || 'なし'}

【最近の会話】
${chatText}

ルール：
- 上記の禁止リスト・前回提案のジャンルは一切使わない（必ず違うジャンルで）
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

    // S14/MT02: 「他にある？」→ 同じジャンルで別の店を提案
    const isMoreRequest = /他に(ある|ない|は)?[？?]?$|もっと(見|教|出|ある)|他の(店|候補|選択肢)/.test(userMessage);
    // S24: 「さっきと違う」「別の」→ 異なるジャンルで提案
    const isDifferentGenreRequest = /さっきと違う|別の(ジャンル|系統|タイプ|やつ)?(?!店|候補|選択肢)|違う(の|店|ところ|提案)|変えて|ガラッと/.test(userMessage) && !isMoreRequest;
    const isDifferentRequest = isMoreRequest || isDifferentGenreRequest;

    // S25対応: 曖昧リクエスト検出
    const isVague = /なんか|いい感じ|どこでも|なんでも|おまかせ|適当/.test(userMessage);
    const chatText = recentMessages.slice(-10).map(m => m.message).join(' ');
    const hasArea = /渋谷|新宿|六本木|銀座|池袋|品川|恵比寿|中目黒|表参道|梅田|難波|横浜|名古屋|京都|博多|駅/.test(chatText);
    const hasCount = /\d+人|何人|大人数|少人数/.test(chatText);
    const hasSpecificCondition = /デート|カップル|記念日|誕生日|接待|ベジタリアン|ヴィーガン|アレルギー|チェーン|個人店|大人数|個室|\d+人/.test(userMessage);

    if (isVague && !hasSpecificCondition && (!hasArea || !hasCount)) {
      const missing = [];
      if (!hasArea) missing.push('エリア');
      if (!hasCount) missing.push('人数');
      return `いいね！${missing.join('と')}教えてくれたら探すよ😊`;
    }

    // ユーザーが明示的な条件を持っている場合、検索して具体的な店を返す
    const conditions = extractRequestConditions(userMessage, recentMessages);
    // S21: キーワード条件（チェーン店じゃない等）もexplicit requestとみなす
    const hasKeywordCondition = conditions.options && conditions.options.keywords && conditions.options.keywords.length > 0;
    const hasExplicitRequest = conditions.genre || conditions.budget || conditions.mealtime || hasKeywordCondition;

    // MT03: 予算・条件変更検出（「やっぱ〜で」「〜に変更」等）
    const isConditionUpdate = /やっぱ|やっぱり|予算.*変え|に変更|にして[！!]?$|以内で[！!]?$/.test(userMessage) && !isDifferentRequest;
    // 条件変更時はチャット履歴からジャンル・エリアを補完
    if (isConditionUpdate && !conditions.genre) {
      conditions.genre = guessGenreFromMessages(recentMessages.slice(-5).filter(m => m.display_name !== 'Kanpai'));
    }

    // S14/MT02/S24: 再提案リクエスト処理
    if (isDifferentRequest) {
      const prevShopNames = extractPreviousShopNames(recentMessages);
      const searchArea = conditions.area || search.extractArea(recentMessages) || '東京';
      const searchBudget = conditions.budget || extractBudgetFromMessages(recentMessages.slice(-5)) || '2';
      let searchGenre;
      let flexPrefix = '';

      if (isMoreRequest) {
        // MT02: 「他にある？」→ ユーザーが求めたジャンルを維持（全ユーザーメッセージから検索）
        const userGenre = guessGenreFromMessages(recentMessages.filter(m => m.display_name !== 'Kanpai'));
        const botGenre = extractPreviousGenre(recentMessages);
        searchGenre = userGenre || botGenre || '5';
        flexPrefix = 'ほかにもあったよ！';
      } else {
        // S24: 「さっきと違う提案して」→ 前回と異なるジャンル
        const prevGenres = extractAllPreviousGenres(recentMessages);
        const allGenres = ['1', '2', '3', '4', '5', '6', '7', '8'];
        const availableGenres = allGenres.filter(g => !prevGenres.includes(g));
        searchGenre = availableGenres[Math.floor(Math.random() * availableGenres.length)] || '1';
        const genreLbl = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン', '8': 'カフェ' };
        flexPrefix = `ジャンル変えて${genreLbl[searchGenre] || 'お店'}で探したよ！`;
      }

      // S21: チェーン店除外
      const isAntiChainSearch = /チェーン(店)?じゃない|チェーン以外|個人店|こだわり(の|がある)/.test(userMessage) ||
        recentMessages.slice(-5).some(m => /チェーン(店)?じゃない|チェーン以外|個人店/.test(m.message));
      const searchOpts = { ...(conditions.options || {}) };
      if (isAntiChainSearch) {
        searchOpts.keywords = [...(searchOpts.keywords || []), 'こだわり'];
        flexPrefix = 'チェーン店を除いて個人店で探したよ！';
      }
      // S14: 「他にある？」→ 検索結果をオフセットして別の店を返す
      if (isMoreRequest) searchOpts.start = 4;

      try {
        const restaurants = await search.searchRestaurants(searchGenre, searchBudget, searchArea, 8, searchOpts);
        if (restaurants && restaurants.length > 0) {
          // 前回提案した店名と重複する店を除外
          let filtered = restaurants.filter(r => !prevShopNames.some(name => r.name && r.name.includes(name)));
          // チェーン店フィルタ
          if (isAntiChainSearch) {
            const chainNames = /鳥貴族|磯丸|串カツ田中|ワタミ|白木屋|魚民|笑笑|はなの舞|甘太郎|土間土間|和民|金の蔵|目利きの銀次|山内農場|千年の宴|福福屋|さくら水産|養老乃瀧|日本海庄や|つぼ八|庄や|大庄|モンテローザ|コロワイド/;
            filtered = filtered.filter(r => !chainNames.test(r.name || ''));
          }
          const finalResults = filtered.length > 0 ? filtered.slice(0, 3) : restaurants.slice(0, 3);
          const { buildRestaurantCarousel } = require('./flex');
          const label = isAntiChainSearch ? '個人店' : conditions.budgetLabel;
          const flexMsg = buildRestaurantCarousel(finalResults, searchGenre, searchBudget, conditions.area || null, '', { budgetLabel: label, prefix: flexPrefix });
          if (flexMsg) return flexMsg;
        }
      } catch (e) {
        console.warn('generateFreeResponse different-request search failed:', e.message);
      }
    } else if (isConditionUpdate || hasExplicitRequest) {
      const searchArea = conditions.area || search.extractArea(recentMessages) || '東京';
      const searchBudget = conditions.budget || extractBudgetFromMessages(recentMessages.slice(-5)) || '2';
      // MT03: ジャンルが不明な場合、会話履歴全体からユーザーの意図を取得
      let searchGenre = conditions.genre || guessGenreFromMessages(recentMessages.filter(m => m.display_name !== 'Kanpai')) || '5';
      const searchOptions = conditions.options || {};

      // ランチ要求かつジャンルがデフォルト(居酒屋)の場合は和食に変更
      if (conditions.mealtime === 'lunch' && searchGenre === '5') {
        searchGenre = '1';
        searchOptions.lunch = true;
      }
      // 夜/飲み系はランチフィルタを外す
      if (conditions.mealtime === 'dinner') {
        delete searchOptions.lunch;
      }

      // S21/MT01: チェーン店除外リクエスト検出（現在のメッセージ + 直近の会話）
      const isAntiChain = /チェーン(店)?じゃない|チェーン以外|個人店|こだわり(の|がある)/.test(userMessage) ||
        recentMessages.slice(-5).some(m => /チェーン(店)?じゃない|チェーン以外|個人店/.test(m.message));

      let flexPrefix = '';
      if (isAntiChain) {
        searchOptions.keywords = [...(searchOptions.keywords || []), 'こだわり'];
        flexPrefix = 'チェーン店を除いて個人店で探したよ！';
      }
      if (isConditionUpdate) {
        const budgetLabelMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
        const budgetLabel = conditions.budgetLabel || budgetLabelMap[searchBudget] || '';
        flexPrefix = `条件変更OK！${budgetLabel ? budgetLabel + 'で' : ''}探し直したよ`;
      }

      try {
        const count = isAntiChain ? 8 : 5;
        let restaurants = await search.searchRestaurants(searchGenre, searchBudget, searchArea, count, searchOptions);
        // MT03: 検索0件の場合、予算を1段階上げてリトライ
        if ((!restaurants || restaurants.length === 0) && parseInt(searchBudget) < 4) {
          const relaxedBudget = String(parseInt(searchBudget) + 1);
          restaurants = await search.searchRestaurants(searchGenre, relaxedBudget, searchArea, count, searchOptions);
        }
        if (restaurants && restaurants.length > 0) {
          let results = restaurants;
          // S21: チェーン店っぽい店名をフィルタ
          if (isAntiChain) {
            const chainNames = /鳥貴族|磯丸|串カツ田中|ワタミ|白木屋|魚民|笑笑|はなの舞|甘太郎|土間土間|和民|金の蔵|目利きの銀次|山内農場|千年の宴|福福屋|さくら水産|養老乃瀧|日本海庄や|つぼ八|庄や|大庄|モンテローザ|コロワイド/;
            results = restaurants.filter(r => !chainNames.test(r.name || ''));
            if (results.length === 0) results = restaurants;
          }
          const { buildRestaurantCarousel } = require('./flex');
          // S21: チェーン店除外時は「個人店」ラベルを表示
          const label = isAntiChain ? '個人店' : conditions.budgetLabel;
          const flexMsg = buildRestaurantCarousel(results.slice(0, 3), searchGenre, searchBudget, conditions.area || null, '', { budgetLabel: label, prefix: flexPrefix });
          if (flexMsg) return flexMsg;
        }
      } catch (e) {
        console.warn('generateFreeResponse search failed, falling back to AI:', e.message);
      }
    }

    // AI fallback: Flex検索で解決済みの場合はここに来ない
    const BUDGET_LABEL_MAP = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
    const genreLabel = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン', '8': 'カフェ' };
    // チェーン店除外指示（現在のメッセージ + 直近の会話）
    const isAntiChainForAI = /チェーン(店)?じゃない|チェーン以外|個人店|こだわり(の|がある)/.test(userMessage) ||
      recentMessages.slice(-5).some(m => /チェーン(店)?じゃない|チェーン以外|個人店/.test(m.message));

    let extraInstruction = '';
    if (isDifferentRequest) {
      const prevGenres = extractAllPreviousGenres(recentMessages);
      const prevShopNames = extractPreviousShopNames(recentMessages);
      const prevGenreLabels = prevGenres.map(g => genreLabel[g] || '不明').join('・');
      const prevShopList = prevShopNames.length > 0 ? prevShopNames.join('、') : 'なし';
      if (isMoreRequest) {
        // MT02: 同ジャンルで別の店（全ユーザーメッセージからジャンルを検索）
        const userGenre = guessGenreFromMessages(recentMessages.filter(m => m.display_name !== 'Kanpai'));
        const genreName = genreLabel[userGenre] || '同じジャンル';
        extraInstruction = `\n\n【最重要】ユーザーが「他にある？」と言っています。
前回提案した店: ${prevShopList}
ユーザーが求めているジャンル: ${genreName}
→ 必ず${genreName}ジャンルで、前回と異なる具体的な実在する店名を提案してください。ジャンルを変えてはいけません。
→ 各店にHotPepperリンクを必ず付けてください。`;
      } else {
        extraInstruction = `\n\n【重要】ユーザーが「さっきと違う提案して」と言っています。
前回提案したジャンル: ${prevGenreLabels}
前回提案した店: ${prevShopList}
→ 上記のジャンル・店は絶対に使わず、まったく異なるジャンル・異なる店を提案してください。HotPepperリンクも必ず付けてください。`;
      }
    }
    if (isConditionUpdate) {
      // MT03: 予算変更等の場合、具体的な店名とリンクを必須にする
      const updatedBudget = conditions.budget ? `予算: ~${{'1':'2,000','2':'4,000','3':'6,000','4':'10,000'}[conditions.budget] || '?'}円` : '';
      const updatedArea = conditions.area || search.extractArea(recentMessages) || '';
      const updatedGenre = conditions.genre ? (genreLabel[conditions.genre] || '') : '';
      extraInstruction += `\n\n【最重要】ユーザーが条件を変更しました。${updatedBudget} ${updatedArea} ${updatedGenre}
→ 変更後の条件に合う具体的な実在する店名を必ず3つ提案してください。
→ 各店に https://www.hotpepper.jp/ で検索できるHotPepperリンクを必ず付けてください。
→ 店名のない抽象的な提案（「イタリアンバル」等）は絶対禁止です。
→ 例: 「1️⃣ 〇〇酒場（池袋駅3分）https://www.hotpepper.jp/str〇〇〇/」`;
    }
    if (isAntiChainForAI) {
      extraInstruction += `\n\n【重要】ユーザーはチェーン店を避けたいと言っています。鳥貴族・磯丸水産・串カツ田中・ワタミ・白木屋・魚民等の大手チェーンは絶対に提案しないでください。個人経営・こだわりの店のみ提案し、「個人店だよ！」と明示してください。`;
    }

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: KANPAI_SYSTEM + extraInstruction },
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
async function generateDMBasedSuggestion(recentMessages, foodHistory, dmResult, groupId = '') {
  try {
    const budgetMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
    const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': 'なんでも', '6': 'ラーメン', '7': 'イタリアン', '8': 'カフェ' };

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
      const flexMsg = buildRestaurantCarousel(restaurants, dmResult.genre, dmResult.budget, area, groupId);
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
async function generateProactiveApproach(context, recentMessages, groupId = '') {
  try {
    const area = context.where;
    // 直近3メッセージのみからジャンル推定（直近優先で古い文脈を引きずらない）
    const genreGuess = guessGenreFromMessages(recentMessages.slice(-3));

    // 予算を会話から動的に抽出（ハードコード '2' を廃止）
    const budgetGuess = extractBudgetFromMessages(recentMessages.slice(-5)) || '2';

    // ランチ検出
    const recentText = recentMessages.slice(-3).map(m => m.message).join(' ');
    const searchOptions = search.extractSearchOptions(recentText);

    // ランチ要求かつジャンルがデフォルト(居酒屋)の場合は和食に変更
    const effectiveGenre = (searchOptions.lunch && genreGuess === '5') ? '1' : genreGuess;

    // お店検索（エリアが判明している場合）→ Flex優先、fallbackにテキスト
    if (area && effectiveGenre) {
      const restaurants = await search.searchRestaurants(effectiveGenre, budgetGuess, area, 3, searchOptions);
      if (restaurants && restaurants.length > 0) {
        // Flex Messageオブジェクトを返す（index.jsで判定してreplyMessage）
        const { buildRestaurantCarousel } = require('./flex');
        const flexMsg = buildRestaurantCarousel(restaurants, effectiveGenre, budgetGuess, area, groupId);
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
  if (/中華|餃子|チャーハン|担々麺|麻婆|小籠包|点心|春巻/.test(text)) return '3';
  if (/ラーメン|らーめん|拉麺|つけ麺/.test(text)) return '6';
  if (/イタリアン|パスタ|ピザ|フレンチ/.test(text)) return '7';
  if (/洋食|ステーキ|ハンバーグ/.test(text)) return '2';
  if (/寿司|すし|天ぷら|蕎麦|うどん|和食|割烹|刺身|鍋|しゃぶしゃぶ|もんじゃ|もつ鍋|たこ焼き|磯丸/.test(text)) return '1';
  if (/カフェ|スイーツ|ケーキ|デザート|パンケーキ/.test(text)) return '8';
  if (/カレー|インド|エスニック|タイ/.test(text)) return '5';
  // 居酒屋・飲み系は独立して検出（カレー等と分離）
  if (/居酒屋|飲み|飲もう|飲める|bar|バー|酒|乾杯|一杯|串カツ|焼き鳥|鳥貴族|やきとり|串焼き|酒場|バル/.test(text)) return '5';
  return null;
}

/**
 * メッセージリストから予算コードを抽出（直近メッセージ優先）
 */
function extractBudgetFromMessages(messages) {
  const orderedMessages = messages.slice().reverse();
  for (const msg of orderedMessages) {
    const budget = search.extractBudget(msg.message);
    if (budget) return budget;
  }
  return null;
}

/**
 * ユーザーメッセージから検索条件を抽出
 */
function extractRequestConditions(userMessage, chatHistory) {
  const text = userMessage;
  const conditions = {};

  // エリア
  conditions.area = search.extractArea([{ message: text }]);
  if (!conditions.area && chatHistory) {
    conditions.area = search.extractArea(chatHistory);
  }

  // S10/S20: 接待・奮発・記念日 → 高予算 + 高級ジャンル（居酒屋NG）
  if (/接待|ビジネス|奮発|記念日/.test(text)) {
    conditions.budget = '4';
    conditions.budgetLabel = '高級店';
    // 居酒屋(5)以外のジャンルを設定（和食懐石 or イタリアン）
    if (!guessGenreFromText(text) || guessGenreFromText(text) === '5') {
      conditions.genre = '1'; // 和食（懐石・割烹系）
    }
  }

  // 予算（接待系で未設定の場合のみ）
  if (!conditions.budget) {
    conditions.budget = search.extractBudget(text);
    // S04: ユーザーが明示した金額を表示用に保持
    const budgetMatch = text.match(/([\d,]+)円/);
    if (budgetMatch) {
      conditions.budgetLabel = `${budgetMatch[1]}円以内`;
    }
  }
  if (!conditions.budget && chatHistory) {
    conditions.budget = extractBudgetFromMessages(chatHistory.slice(-3));
  }

  // ジャンル（接待系で未設定の場合のみ）
  if (!conditions.genre) {
    conditions.genre = guessGenreFromText(text);
  }

  // 検索オプション
  conditions.options = search.extractSearchOptions(text);

  // 時間帯
  if (/ランチ|昼/.test(text)) conditions.mealtime = 'lunch';
  else if (/ディナー|夜|今夜|夕食|飲み|飲もう|飲める|一杯/.test(text)) conditions.mealtime = 'dinner';

  // 人数
  const countMatch = text.match(/(\d+)人/);
  if (countMatch) conditions.count = parseInt(countMatch[1]);

  return conditions;
}

/**
 * 直前のKanpai発言からジャンルコードを抽出（S14/S24: 前回と違うジャンルを返すため）
 */
function extractPreviousGenre(messages) {
  const botMessages = messages.filter(m => m.display_name === 'Kanpai').slice(-3);
  for (const msg of botMessages.reverse()) {
    const text = msg.message || '';
    // Flex altTextからジャンル検出（例: "渋谷周辺の居酒屋（〜4,000円）"）
    const genre = guessGenreFromText(text);
    if (genre) return genre;
    // ラベルテキストから検出
    if (/和食|懐石|割烹/.test(text)) return '1';
    if (/洋食|ステーキ/.test(text)) return '2';
    if (/中華/.test(text)) return '3';
    if (/焼肉/.test(text)) return '4';
    if (/居酒屋/.test(text)) return '5';
    if (/ラーメン/.test(text)) return '6';
    if (/イタリアン/.test(text)) return '7';
    if (/カフェ/.test(text)) return '8';
  }
  return '5'; // デフォルト（居酒屋を除外するため）
}

/**
 * 直前のKanpai発言から全てのジャンルコードを抽出（重複なし）
 */
function extractAllPreviousGenres(messages) {
  const botMessages = messages.filter(m => m.display_name === 'Kanpai').slice(-3);
  const genres = new Set();
  for (const msg of botMessages) {
    const text = msg.message || '';
    const genre = guessGenreFromText(text);
    if (genre) genres.add(genre);
    if (/和食|懐石|割烹/.test(text)) genres.add('1');
    if (/洋食|ステーキ/.test(text)) genres.add('2');
    if (/中華/.test(text)) genres.add('3');
    if (/焼肉/.test(text)) genres.add('4');
    if (/居酒屋/.test(text)) genres.add('5');
    if (/ラーメン/.test(text)) genres.add('6');
    if (/イタリアン/.test(text)) genres.add('7');
    if (/カフェ/.test(text)) genres.add('8');
  }
  if (genres.size === 0) genres.add('5');
  return Array.from(genres);
}

/**
 * 直前のKanpai発言から提案した店名を抽出
 */
function extractPreviousShopNames(messages) {
  const botMessages = messages.filter(m => m.display_name === 'Kanpai').slice(-3);
  const names = [];
  for (const msg of botMessages) {
    const text = msg.message || '';
    // Flex altText format: "店名1、店名2、店名3"
    // or text format: "ヒロキヤ新宿、Laugh ラフ 目黒、pulse パルス"
    const shopMatches = text.match(/[\u3000-\u9FFF\w][\u3000-\u9FFFa-zA-Z0-9ー・\s]{1,20}/g);
    if (shopMatches) {
      for (const match of shopMatches) {
        const trimmed = match.trim();
        if (trimmed.length >= 2 && !/周辺|エリア|予算|円|件見つけ|詳細|カード|チェック|探した/.test(trimmed)) {
          names.push(trimmed);
        }
      }
    }
  }
  return names;
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
  extractBudgetFromMessages,
  extractRequestConditions,
  extractPreviousGenre,
  extractAllPreviousGenres,
  extractPreviousShopNames,
};
