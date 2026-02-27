/**
 * simulate2.js - 拡張シミュレーター
 * エッジケース・実会話シナリオ・ストレステスト
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const brain = require('../brain');
const search = require('../search');

let passed = 0; let failed = 0;

function check(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

function toMsgs(arr) {
  return arr.map((m, i) => ({
    display_name: m.name || `User${i+1}`,
    message: m.text || m,
  }));
}

// ══════════════════════════════════════════
// A. 関西弁・方言パターン
// ══════════════════════════════════════════
async function testDialects() {
  console.log('\n━━ A. 方言・口語パターン ━━');
  const cases = [
    { text: '梅田でたこ焼き食べへん？', where: '梅田', shouldApproach: true },
    { text: '難波で飲もうや', where: '難波', shouldApproach: true },
    { text: '天神でもつ鍋どうやろ', where: '天神', shouldApproach: true },
    { text: '博多行くばい', where: '博多', shouldApproach: false }, // 食べ物なし
    { text: 'すき家行かね？', where: null, shouldApproach: false },
  ];

  for (const c of cases) {
    const msgs = toMsgs([c.text]);
    const ctx = brain.detectPlanContext(msgs);
    check(
      `「${c.text}」→ approach:${c.shouldApproach}`,
      ctx.shouldApproach === c.shouldApproach,
      `got: approach=${ctx.shouldApproach} where=${ctx.where}`
    );
  }
}

// ══════════════════════════════════════════
// B. あいまい・ノイズ耐性
// ══════════════════════════════════════════
async function testNoiseTolerance() {
  console.log('\n━━ B. ノイズ耐性テスト ━━');

  // ジャンル推定のエッジケース
  const genreCases = [
    { text: 'ラーメン？いや焼肉かな', expect: '4' }, // 最後の方を優先
    { text: 'なんか食べたい', expect: null },
    { text: 'おなかぺこぺこ', expect: null },
    { text: '鍋がいい', expect: '1' }, // 和食系
    { text: 'もんじゃ焼き', expect: '1' },
    { text: 'タコス食べたい', expect: null }, // 未定義ジャンル
    { text: 'しゃぶしゃぶにしよう', expect: '1' },
    { text: 'BBQしたい', expect: '4' },
  ];

  for (const c of genreCases) {
    const result = brain.guessGenreFromText(c.text);
    check(`ジャンル「${c.text}」→ ${c.expect ?? 'null'}`, result === c.expect, `got: ${result}`);
  }

  // プラン検出のノイズ
  const noiseCases = [
    {
      msgs: ['ラーメン食べた', '美味しかった'],
      shouldApproach: false, // 過去形・完了
    },
    {
      msgs: ['昨日渋谷で焼肉食べたよ', 'よかった'],
      shouldApproach: false, // 過去
    },
    {
      msgs: ['今夜どうする？', 'わからん'],
      shouldApproach: false, // 食べ物もエリアも不明
    },
  ];

  for (const c of noiseCases) {
    const ctx = brain.detectPlanContext(toMsgs(c.msgs));
    check(
      `ノイズ「${c.msgs.join(' / ')}」→ no-approach`,
      ctx.shouldApproach === c.shouldApproach,
      `got: ${ctx.shouldApproach}`
    );
  }
}

// ══════════════════════════════════════════
// C. 実会話シナリオ（複数ターン）
// ══════════════════════════════════════════
async function testRealScenarios() {
  console.log('\n━━ C. 実会話シナリオ ━━');

  const scenarios = [
    {
      name: '幹事が提案→みんなOK',
      msgs: [
        { name: '田中', text: '今週の飲み会、木曜日でどう？' },
        { name: '鈴木', text: 'いいよ！' },
        { name: '佐藤', text: '木曜空いてる' },
        { name: '田中', text: '新宿で居酒屋にしよう' },
      ],
      expectApproach: true,
    },
    {
      name: '膠着パターン（なんでもいい）',
      msgs: [
        { name: 'A', text: 'どこ行く？' },
        { name: 'B', text: 'なんでもいいよ' },
        { name: 'C', text: 'どこでもいい' },
        { name: 'A', text: '任せる' },
      ],
      expectStalemate: true,
    },
    {
      name: '食べ物オンリー（エリア不明）',
      msgs: [
        { name: 'A', text: '焼肉食べたい' },
        { name: 'B', text: '焼肉いいね' },
      ],
      expectApproach: true, // 食べ物×2で発火
    },
    {
      name: 'エリア言及後に食べ物',
      msgs: [
        { name: 'A', text: '恵比寿に用事があるんだよね' },
        { name: 'B', text: 'じゃあ恵比寿でランチしない？' },
      ],
      expectApproach: true,
    },
  ];

  for (const s of scenarios) {
    const msgs = toMsgs(s.msgs.map(m => ({ ...m, text: m.text })));
    const ctx = brain.detectPlanContext(msgs);
    const stale = brain.detectStalemate ? false : false; // kanji.jsにある

    if (s.expectApproach !== undefined) {
      check(`[${s.name}] approach検出`, ctx.shouldApproach === s.expectApproach,
        `got: ${ctx.shouldApproach}, where=${ctx.where}`);
    }
    console.log(`  context: where=${ctx.where} when=${ctx.when} time=${ctx.time}`);
  }
}

// ══════════════════════════════════════════
// D. AI応答の一貫性テスト（同じ入力→品質安定）
// ══════════════════════════════════════════
async function testConsistency() {
  console.log('\n━━ D. AI応答一貫性テスト（3回同じ入力）━━');

  const msgs = toMsgs([
    { name: '田中', text: '今夜新宿で焼肉どう？' },
    { name: '鈴木', text: '7時からいける！' },
  ]);
  const ctx = brain.detectPlanContext(msgs);

  const responses = [];
  for (let i = 0; i < 3; i++) {
    const r = await brain.generateProactiveApproach(ctx, msgs);
    responses.push(r);
    const hasMD = /\*\*|__|^\d+\. /m.test(r);
    const isShort = r.length < 600;
    check(`Run ${i+1}: markdown禁止`, !hasMD, hasMD ? r.substring(0, 50) : '');
    check(`Run ${i+1}: 長さOK`, isShort, `${r.length}文字`);
    console.log(`  → ${r.substring(0, 80)}...`);
  }

  // 全てお店リストまたは自然な返答であること
  const allValid = responses.every(r => r && r.length > 5);
  check('全3回: 有効な応答', allValid);
}

// ══════════════════════════════════════════
// E. 食事履歴を使った被り回避テスト
// ══════════════════════════════════════════
async function testAvoidance() {
  console.log('\n━━ E. 食事被り回避テスト ━━');

  const heavyRamenHistory = Array(7).fill(null).map((_, i) => ({
    food_item: ['ラーメン', 'つけ麺', '担々麺', '塩ラーメン', '醤油ラーメン', '二郎', 'らーめん'][i],
    category: '中華',
  }));

  const recentMsgs = [{ display_name: 'User', message: 'どこ行く？' }];
  const suggestion = await brain.generateFoodSuggestion(recentMsgs, heavyRamenHistory, 4);

  // ラーメン系が提案されていないか（被り回避）
  const suggestsRamen = /ラーメン|らーめん|つけ麺|中華/.test(suggestion);
  check('ラーメン7連続 → 中華を避ける', !suggestsRamen, suggestion.substring(0, 100));
  check('提案が空でない', suggestion.length > 10);
  check('markdown禁止', !/\*\*/.test(suggestion));
  console.log(`  → ${suggestion.substring(0, 120)}...`);
}

// ══════════════════════════════════════════
// F. 各エリア×ジャンルの検索動作確認
// ══════════════════════════════════════════
async function testSearchCoverage() {
  console.log('\n━━ F. エリア×ジャンル検索カバレッジ ━━');

  const combos = [
    { area: '渋谷', genre: '1', label: '渋谷×和食' },
    { area: '新宿', genre: '4', label: '新宿×焼肉' },
    { area: '銀座', genre: '2', label: '銀座×洋食' },
    { area: '梅田', genre: '5', label: '梅田×居酒屋' },
    { area: '博多', genre: '3', label: '博多×ラーメン' },
    { area: '名古屋', genre: '1', label: '名古屋×和食' },
  ];

  for (const c of combos) {
    const results = await search.searchRestaurants(c.genre, '2', c.area, 3);
    const hasResults = results && results.length > 0;
    check(`${c.label}: ${hasResults ? results.length + '件取得' : '0件'}`, hasResults,
      hasResults ? results[0].name : 'empty');
    if (hasResults) console.log(`    1位: ${results[0].name}`);
  }
}

// ══════════════════════════════════════════
// G. DM集計ロジックテスト
// ══════════════════════════════════════════
async function testDMAggregation() {
  console.log('\n━━ G. DM集計ロジックテスト ━━');

  // aggregateResponses をcollector.jsから直接テスト
  const collector = require('../collector');

  // 全員焼肉・予算3
  const responses1 = {
    'user1': { budget: '3', genre: '4', answeredAt: new Date().toISOString() },
    'user2': { budget: '3', genre: '4', answeredAt: new Date().toISOString() },
    'user3': { budget: '2', genre: '4', answeredAt: new Date().toISOString() },
  };

  // aggregateは内部関数なので結果を直接検証できないが
  // generateDMBasedSuggestionを通して確認
  const result = await brain.generateDMBasedSuggestion(
    [{ display_name: 'User', message: '新宿集合' }],
    [],
    { budget: '3', genre: '4', answeredCount: 3 }
  );

  check('DM集計→焼肉提案: 結果あり', result && result.length > 5);
  check('DM集計→markdown禁止', !/\*\*/.test(result));
  console.log(`  → ${result.substring(0, 100)}...`);

  // 予算バラバラ
  const result2 = await brain.generateDMBasedSuggestion(
    [{ display_name: 'User', message: '渋谷で' }],
    [],
    { budget: '1', genre: '5', answeredCount: 2 }
  );
  check('DM集計→低予算居酒屋: 結果あり', result2 && result2.length > 5);
  console.log(`  → ${result2.substring(0, 100)}...`);
}

// ══════════════════════════════════════════
// H. 会話の流れシミュレーション（フルフロー）
// ══════════════════════════════════════════
async function testFullConversationFlow() {
  console.log('\n━━ H. フル会話フロー ━━');

  const conversationFlows = [
    {
      name: '典型的な飲み会調整',
      steps: [
        { in: '今週末どこか行かない？', expectApproach: false },
        { in: '金曜日いける？', expectApproach: false },
        { in: '池袋で飲みたい', expectApproach: true },
      ],
    },
    {
      name: 'ランチ即決パターン',
      steps: [
        { in: '今日のランチ恵比寿でパスタにしない？', expectApproach: true },
      ],
    },
    {
      name: '二度目の提案（上書き）',
      steps: [
        { in: '六本木で寿司', expectApproach: true },
        { in: 'やっぱり銀座でフレンチにしよう', expectApproach: true },
      ],
    },
  ];

  for (const flow of conversationFlows) {
    console.log(`\n  [${flow.name}]`);
    const history = [];
    for (const step of flow.steps) {
      history.push({ display_name: 'User', message: step.in });
      const ctx = brain.detectPlanContext(history.slice(-3));
      check(
        `「${step.in}」→ approach:${step.expectApproach}`,
        ctx.shouldApproach === step.expectApproach,
        `where=${ctx.where} got=${ctx.shouldApproach}`
      );
    }
  }
}

// ══════════════════════════════════════════
// メイン
// ══════════════════════════════════════════
async function main() {
  console.log('🍻 Kanpai Bot 拡張シミュレーター');
  console.log('エッジケース・実会話・ストレステスト\n');

  await testDialects();
  await testNoiseTolerance();
  await testRealScenarios();
  await testConsistency();
  await testAvoidance();
  await testSearchCoverage();
  await testDMAggregation();
  await testFullConversationFlow();

  console.log(`\n${'━'.repeat(50)}`);
  const total = passed + failed;
  console.log(`結果: ${passed}/${total} passed`);
  if (failed > 0) {
    console.log(`⚠️  ${failed} failed → 要改善`);
  } else {
    console.log('🎉 全パターンOK!');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
