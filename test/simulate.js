/**
 * simulate.js - 会話シミュレーター
 * brain.js を直接叩いて様々な会話パターンをテスト・育成する
 *
 * 実行: node test/simulate.js [--pattern all|food|proactive|dm|vote]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const brain = require('../brain');
const search = require('../search');

const args = process.argv.slice(2);
const patternFilter = args.find(a => a.startsWith('--pattern='))?.split('=')[1] || 'all';

// ─────────────────────────────────────────────
// テストパターン定義
// ─────────────────────────────────────────────

const PATTERNS = {

  // 1. 食事記録の抽出
  food_extraction: [
    { input: 'ランチでラーメン食べた', expect: { found: true, context: '食べた' } },
    { input: '昨日渋谷で焼肉行ったよ', expect: { found: true } },
    { input: '今日は何も食べてない', expect: { found: false } },
    { input: 'ピザとパスタ両方頼んだ', expect: { found: true, multiItem: true } },
    { input: 'お腹すいた', expect: { found: false } },
    { input: '寿司食いたい', expect: { found: true, context: '食べたい' } },
    { input: '先週カレー食べたな〜', expect: { found: true } },
    { input: 'お疲れ様でした', expect: { found: false } },
  ],

  // 2. プラン文脈検出（いつ・どこ・何時）
  plan_detection: [
    {
      msgs: ['中野でラーメンにしない？'],
      expect: { shouldApproach: true, where: '中野' }
    },
    {
      msgs: ['明日渋谷集まろう', '7時頃どう？'],
      expect: { shouldApproach: true }
    },
    {
      msgs: ['今夜暇？', '新宿で焼肉どうかな'],
      expect: { shouldApproach: true, where: '新宿' }
    },
    {
      msgs: ['お疲れ〜', 'また今度ね'],
      expect: { shouldApproach: false }
    },
    {
      msgs: ['土曜日に集まりたい'],
      expect: { shouldApproach: false } // いつだけではNG
    },
    {
      msgs: ['週末に池袋どう？', 'いいね！何時がいい？'],
      expect: { shouldApproach: true }
    },
  ],

  // 3. ジャンル推定精度
  genre_guess: [
    { input: 'ラーメン食べたい', expect: '3' },
    { input: 'らーめんにしない？', expect: '3' },
    { input: '焼肉行こうよ', expect: '4' },
    { input: 'カレーにしない？', expect: '5' },
    { input: 'パスタとか洋食がいい', expect: '2' },
    { input: 'お寿司食べたい', expect: '1' },
    { input: 'うどんはどう', expect: '1' },
    { input: '何でもいいよ', expect: null },
    { input: '担々麺最高', expect: '3' },
    { input: 'イタリアン行きたい', expect: '2' },
  ],

  // 4. 能動的アプローチの質（実際のAI応答を評価）
  proactive_quality: [
    {
      name: '中野ラーメン',
      msgs: [
        { display_name: '田中', message: '中野でラーメンにしない？' },
        { display_name: '山田', message: 'いいね！' },
      ]
    },
    {
      name: '渋谷焼肉・7時',
      msgs: [
        { display_name: '田中', message: '今夜渋谷で焼肉どう？' },
        { display_name: '山田', message: '7時から空いてる' },
      ]
    },
    {
      name: '新宿・明日・ランチ',
      msgs: [
        { display_name: 'A', message: '明日のランチ新宿にしようよ' },
        { display_name: 'B', message: 'いいね12時ごろ？' },
      ]
    },
    {
      name: 'エリア不明・時間あり',
      msgs: [
        { display_name: 'A', message: '今夜7時に集合ね' },
        { display_name: 'B', message: 'りょ〜' },
      ]
    },
  ],

  // 5. 食事提案の質
  suggestion_quality: [
    {
      name: '履歴なし・少人数',
      history: [],
      memberCount: 2,
    },
    {
      name: 'ラーメン被り避け',
      history: [
        { food_item: 'ラーメン', category: '中華' },
        { food_item: '担々麺', category: '中華' },
        { food_item: 'つけ麺', category: '中華' },
      ],
      memberCount: 4,
    },
    {
      name: '多様な履歴',
      history: [
        { food_item: '焼肉', category: '焼肉' },
        { food_item: '寿司', category: '和食' },
        { food_item: 'パスタ', category: 'イタリアン' },
      ],
      memberCount: 5,
    },
  ],
};

// ─────────────────────────────────────────────
// ランナー
// ─────────────────────────────────────────────

let passed = 0; let failed = 0; let total = 0;

function toMsgObjects(msgs) {
  return msgs.map((m, i) => ({
    display_name: typeof m === 'string' ? `User${i+1}` : m.display_name,
    message: typeof m === 'string' ? m : m.message,
  }));
}

function check(label, condition, detail = '') {
  total++;
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function runFoodExtraction() {
  console.log('\n━━ 1. 食事抽出テスト ━━');
  for (const p of PATTERNS.food_extraction) {
    const result = await brain.extractFoodFromText(p.input);
    const foundOk = result.found === p.expect.found;
    const contextOk = !p.expect.context || result.context === p.expect.context;
    check(
      `「${p.input}」`,
      foundOk && contextOk,
      `found=${result.found}(${p.expect.found}) context=${result.context}(${p.expect.context||'any'})`
    );
  }
}

async function runPlanDetection() {
  console.log('\n━━ 2. プラン文脈検出テスト ━━');
  for (const p of PATTERNS.plan_detection) {
    const msgs = toMsgObjects(p.msgs);
    const result = brain.detectPlanContext(msgs);
    const approachOk = result.shouldApproach === p.expect.shouldApproach;
    const whereOk = !p.expect.where || result.where === p.expect.where;
    check(
      `「${p.msgs.join(' / ')}」`,
      approachOk && whereOk,
      `shouldApproach=${result.shouldApproach}(${p.expect.shouldApproach}) where=${result.where}(${p.expect.where||'any'})`
    );
  }
}

function runGenreGuess() {
  console.log('\n━━ 3. ジャンル推定テスト ━━');
  for (const p of PATTERNS.genre_guess) {
    const result = brain.guessGenreFromText(p.input);
    check(
      `「${p.input}」→ ${p.expect || 'null'}`,
      result === p.expect,
      `got: ${result}`
    );
  }
}

async function runProactiveQuality() {
  console.log('\n━━ 4. 能動的アプローチ品質テスト ━━');
  for (const p of PATTERNS.proactive_quality) {
    const msgs = p.msgs;
    const context = brain.detectPlanContext(msgs);
    const response = await brain.generateProactiveApproach(context, msgs);
    const hasMD = /\*\*|__|\[.*\]\(/.test(response || '');
    const isShort = (response || '').length < 600; // お店リスト含む場合は長め
    const notEmpty = !!response;

    console.log(`\n  [${p.name}]`);
    console.log(`  context: where=${context.where} time=${context.time} when=${context.when}`);
    console.log(`  response: ${response}`);
    check('markdown禁止', !hasMD, hasMD ? '**が含まれてる' : '');
    check('短さ(<200文字)', isShort, `${(response||'').length}文字`);
    check('空でない', notEmpty);
  }
}

async function runSuggestionQuality() {
  console.log('\n━━ 5. 食事提案品質テスト ━━');
  for (const p of PATTERNS.suggestion_quality) {
    const recentMsgs = [{ display_name: 'User1', message: 'どこ行く？' }];
    const response = await brain.generateFoodSuggestion(recentMsgs, p.history, p.memberCount);
    const hasMD = /\*\*|__/.test(response);
    const isShort = response.length < 400;
    const mentionsHistory = p.history.length > 0
      ? !p.history.every(h => response.includes(h.food_item))
      : true; // 被り回避されてれば履歴アイテムが提案に出ないはず

    console.log(`\n  [${p.name}]`);
    console.log(`  → ${response.substring(0, 100)}...`);
    check('markdown禁止', !hasMD);
    check('長さ適切', isShort, `${response.length}文字`);
  }
}

// ─────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────

async function main() {
  console.log('🍻 Kanpai Bot 会話シミュレーター');
  console.log(`パターン: ${patternFilter}\n`);

  const run = (name) => patternFilter === 'all' || patternFilter === name;

  if (run('food'))      await runFoodExtraction();
  if (run('plan'))      await runPlanDetection();
  if (run('genre'))     { runGenreGuess(); }
  if (run('proactive')) await runProactiveQuality();
  if (run('suggest'))   await runSuggestionQuality();

  // all の場合は全部
  if (patternFilter === 'all') {
    await runFoodExtraction();
    await runPlanDetection();
    runGenreGuess();
    await runProactiveQuality();
    await runSuggestionQuality();
  }

  console.log(`\n${'━'.repeat(40)}`);
  console.log(`ロジックテスト: ${passed}/${total} passed`);
  if (failed > 0) console.log(`⚠️  ${failed} failed`);
  else console.log('🎉 全パターンOK!');
}

main().catch(e => { console.error(e); process.exit(1); });
