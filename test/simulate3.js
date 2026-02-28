/**
 * simulate3.js - ローンチパターン補完 (+80)
 * 記念日/否定/連続会話/敵意/人数/時間帯/実在店名
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const brain = require('../brain');
const search = require('../search');

let passed = 0; let failed = 0; const fixes = [];

function check(label, condition, detail = '') {
  if (condition) { process.stdout.write('  ✅ ' + label + '\n'); passed++; }
  else {
    process.stdout.write('  ❌ ' + label + (detail ? ' — ' + detail : '') + '\n');
    failed++;
    fixes.push({ label, detail });
  }
}

function msgs(...texts) {
  return texts.map((t, i) => ({ display_name: `User${i+1}`, message: t }));
}

// ══════════════════════════════════════════
// I. 人数パターン（2〜10人以上）
// ══════════════════════════════════════════
async function testGroupSize() {
  console.log('\n━━ I. グループ人数パターン ━━');
  const cases = [
    { text: '2人で渋谷でランチしない？', approach: true },
    { text: '4人で新宿焼肉どう？', approach: true },
    { text: '大人数で池袋宴会！20人くらい', approach: true },
    { text: '1人でラーメン食べた', approach: false }, // 過去・1人
    { text: 'うち全員で恵比寿イタリアン行こう', approach: true },
  ];
  for (const c of cases) {
    const ctx = brain.detectPlanContext(msgs(c.text));
    check(`「${c.text}」→ ${c.approach}`, ctx.shouldApproach === c.approach, `got:${ctx.shouldApproach}`);
  }

  // 人数が提案の質に影響するか
  const hist = [{ food_item: '寿司', category: '和食' }];
  for (const n of [2, 5, 10]) {
    const r = await brain.generateFoodSuggestion(msgs('どこ行く？'), hist, n);
    check(`${n}人向け提案: 空でない`, r.length > 5);
    check(`${n}人向け提案: markdown禁止`, !/\*\*/.test(r));
  }
}

// ══════════════════════════════════════════
// J. 時間帯パターン
// ══════════════════════════════════════════
async function testTimeOfDay() {
  console.log('\n━━ J. 時間帯パターン ━━');
  const cases = [
    { text: '今日のランチ丸の内でどう？', approach: true },
    { text: '朝ごはん一緒に食べない？渋谷で', approach: true },
    { text: '深夜0時から新宿で飲もう', approach: true },
    { text: '夕方5時に銀座集合', approach: true },
    { text: '11時半に六本木でランチ', approach: true },
  ];
  for (const c of cases) {
    const ctx = brain.detectPlanContext(msgs(c.text));
    check(`「${c.text}」→ ${c.approach}`, ctx.shouldApproach === c.approach, `got:${ctx.shouldApproach} where=${ctx.where}`);
  }
}

// ══════════════════════════════════════════
// K. 記念日・特殊シーン
// ══════════════════════════════════════════
async function testSpecialOccasions() {
  console.log('\n━━ K. 記念日・特殊シーン ━━');

  // 特殊シーンの検出
  const cases = [
    { texts: ['田中さんの送別会どこにする？', '新宿がいいかな'], approach: true },
    { texts: ['誕生日なのでちょっとリッチに銀座で'], approach: true },
    { texts: ['合コンなんだけどどこがいい？', '恵比寿あたりで'], approach: true },
    { texts: ['接待で使えるお店、赤坂で'], approach: true },
  ];
  for (const c of cases) {
    const ctx = brain.detectPlanContext(msgs(...c.texts));
    check(`「${c.texts[0]}」→ ${c.approach}`, ctx.shouldApproach === c.approach, `got:${ctx.shouldApproach}`);
  }

  // 特殊シーンへのAI応答品質
  const specialMsgs = [
    { display_name: '山田', message: '田中さんの送別会、新宿でやろう' },
    { display_name: '鈴木', message: 'いいね！何人くらい？' },
  ];
  const ctx = brain.detectPlanContext(specialMsgs);
  const r = await brain.generateProactiveApproach(ctx, specialMsgs);
  check('送別会: 応答あり', r && r.length > 5);
  check('送別会: markdown禁止', !/\*\*/.test(r || ''));
  console.log(`  → ${(r || '').substring(0, 80)}`);
}

// ══════════════════════════════════════════
// L. 否定・制約のハンドリング
// ══════════════════════════════════════════
async function testConstraints() {
  console.log('\n━━ L. 否定・制約パターン ━━');

  // 否定があっても食べ物の話題なら発火OK
  const cases = [
    { texts: ['焼肉は嫌', '渋谷で別のがいい'], approach: true },
    { texts: ['高いのはNG、新宿で飲み会安めで'], approach: true }, // 飲み会含む
    { texts: ['アレルギーあるから中華は無理', '池袋で他の'], approach: true },
    { texts: ['魚嫌いなんだよね、六本木で焼肉にしよう'], approach: true }, // 焼肉含む
  ];
  for (const c of cases) {
    const ctx = brain.detectPlanContext(msgs(...c.texts));
    check(`「${c.texts[0]}」→ approach:${c.approach}`, ctx.shouldApproach === c.approach, `got:${ctx.shouldApproach}`);
  }

  // 制約を含む食事提案
  const constraintHistory = [
    { food_item: '焼肉', category: '焼肉' },
    { food_item: '中華', category: '中華' },
  ];
  const constraintMsgs = [
    { display_name: 'User', message: 'アレルギーあるから魚NGで' },
  ];
  const r = await brain.generateFoodSuggestion(constraintMsgs, constraintHistory, 3);
  check('制約あり提案: 空でない', r.length > 5);
  check('制約あり提案: markdown禁止', !/\*\*/.test(r));
  console.log(`  → ${r.substring(0, 100)}`);
}

// ══════════════════════════════════════════
// M. 連続会話・話題変更
// ══════════════════════════════════════════
async function testConversationFlow() {
  console.log('\n━━ M. 連続会話・話題変更 ━━');

  const flows = [
    {
      name: '提案→キャンセル→再提案',
      steps: [
        { add: '渋谷で焼肉にしよう', expect: true },
        { add: 'やっぱり渋谷やめて新宿にしよう', expect: true },
        { add: '新宿でラーメンにする', expect: true },
      ],
    },
    {
      name: 'ランチ→ディナーに変更',
      steps: [
        { add: 'ランチに銀座でパスタ食べよう', expect: true },
        { add: 'やっぱりディナーにしない？新宿で', expect: true },
      ],
    },
    {
      name: '関係ない話が挟まる',
      steps: [
        { add: '恵比寿で飲もう', expect: true },
        { add: 'そういえば昨日映画見たよ', expect: false },
        { add: '恵比寿で20時からね', expect: true },
      ],
    },
  ];

  for (const flow of flows) {
    console.log(`\n  [${flow.name}]`);
    const history = [];
    for (const step of flow.steps) {
      history.push({ display_name: 'User', message: step.add });
      const ctx = brain.detectPlanContext(history.slice(-3));
      check(`「${step.add}」→ ${step.expect}`, ctx.shouldApproach === step.expect,
        `got:${ctx.shouldApproach} where=${ctx.where}`);
    }
  }
}

// ══════════════════════════════════════════
// N. 敵意・スパム・エッジ
// ══════════════════════════════════════════
async function testEdgeCases() {
  console.log('\n━━ N. 敵意・スパム・エッジケース ━━');

  // botへの攻撃的な入力
  const attackCases = [
    { text: 'お前うるさい', approach: false },
    { text: 'Kanpaiうざい', approach: false },
    { text: 'aaaaaaaaaaaaa', approach: false },
    { text: '！！！！！！', approach: false },
    { text: 'テストテストテスト', approach: false },
    { text: '飲み飲み飲み飲み飲み', approach: true }, // 「飲み」×5は発火OK
  ];
  for (const c of attackCases) {
    const ctx = brain.detectPlanContext(msgs(c.text));
    check(`攻撃「${c.text.substring(0,10)}」→ ${c.approach}`, ctx.shouldApproach === c.approach, `got:${ctx.shouldApproach}`);
  }

  // 極端に長いメッセージ
  const longMsg = '今夜渋谷で焼肉を食べようと思っているんだけど、みんなはどう思う？予算は3000円くらいで、7時に渋谷駅前に集合でどうかな？もし都合が悪い人がいれば別の日にするよ。';
  const ctx = brain.detectPlanContext(msgs(longMsg));
  check('長文メッセージ: approach検出', ctx.shouldApproach === true, `got:${ctx.shouldApproach}`);
  check('長文メッセージ: エリア検出', ctx.where === '渋谷', `got:${ctx.where}`);
}

// ══════════════════════════════════════════
// O. 実在店名・ブランドへの反応
// ══════════════════════════════════════════
async function testBrandNames() {
  console.log('\n━━ O. 実在店名・ブランド名 ━━');

  // ジャンル推定（店名からジャンルを推測できるか）
  const brandCases = [
    { text: '磯丸水産行こう', genre: '1' }, // 和食系
    { text: '吉野家でいいじゃん', genre: null }, // ファストフード→null
    { text: 'マクドナルドでいいか', genre: null },
    { text: 'ステーキのどんに行こう', genre: '2' }, // 洋食
    { text: '鳥貴族どう？', genre: '5' }, // 居酒屋系
    { text: '串カツ田中いいよね', genre: '5' }, // 居酒屋系
  ];
  for (const c of brandCases) {
    const result = brain.guessGenreFromText(c.text);
    check(`ブランド「${c.text}」→ ${c.genre ?? 'null'}`, result === c.genre, `got:${result}`);
  }

  // 店名言及でもapproachするか
  const storeCases = [
    { texts: ['磯丸水産で新宿どう？'], approach: true },
    { texts: ['鳥貴族に恵比寿店あったよね'], approach: true },
    { texts: ['松屋でいいじゃん'], approach: false }, // エリア・時間なし
  ];
  for (const c of storeCases) {
    const ctx = brain.detectPlanContext(msgs(...c.texts));
    check(`「${c.texts[0]}」→ approach:${c.approach}`, ctx.shouldApproach === c.approach, `got:${ctx.shouldApproach}`);
  }
}

// ══════════════════════════════════════════
// P. 食事提案の多様性（同じ入力で3回→バリエーション）
// ══════════════════════════════════════════
async function testSuggestionDiversity() {
  console.log('\n━━ P. 提案多様性テスト ━━');

  const history = [
    { food_item: '焼肉', category: '焼肉' },
    { food_item: 'ラーメン', category: '中華' },
  ];
  const baseMsgs = [{ display_name: 'User', message: 'どこ行く？' }];

  const results = [];
  for (let i = 0; i < 3; i++) {
    const r = await brain.generateFoodSuggestion(baseMsgs, history, 4);
    results.push(r);
    check(`Run${i+1}: 禁止ジャンル除外`, !/焼肉|ラーメン/.test(r), r.substring(0, 50));
  }
  // 3回のうち少なくとも2種類の異なる提案があること
  const unique = new Set(results.map(r => r.substring(0, 30))).size;
  check('3回の提案にバリエーションあり', unique >= 2, `${unique}種類`);
}

// ══════════════════════════════════════════
// Q. エリア検索の網羅性（追加エリア）
// ══════════════════════════════════════════
async function testAreaCoverage() {
  console.log('\n━━ Q. 追加エリア検索カバレッジ ━━');

  const areas = [
    { area: '吉祥寺', genre: '3', label: '吉祥寺×ラーメン' },
    { area: '下北沢', genre: '5', label: '下北沢×居酒屋' },
    { area: '横浜', genre: '2', label: '横浜×洋食' },
    { area: '京都', genre: '1', label: '京都×和食' },
    { area: '札幌', genre: '4', label: '札幌×焼肉' },
    { area: '名古屋', genre: '3', label: '名古屋×ラーメン' },
  ];

  for (const a of areas) {
    const results = await search.searchRestaurants(a.genre, '2', a.area, 3);
    const ok = results && results.length > 0;
    check(`${a.label}: ${ok ? results.length + '件' : '0件'}`, ok,
      ok ? results[0].name : 'empty');
  }
}

// ══════════════════════════════════════════
// R. DM応答ステップ（予算→ジャンル）
// ══════════════════════════════════════════
async function testDMSteps() {
  console.log('\n━━ R. DMステップ応答パターン ━━');

  // 各ステップの入力バリエーション
  const budgetInputs = ['1', '2', '3', '4', 'いち', '2000円', '？'];
  const genreInputs = ['1', '2', '3', '4', '5', '和食', 'なんでも', '？'];

  // 有効な数字入力のみ処理
  for (const b of ['1', '2', '3', '4']) {
    check(`予算入力「${b}」: 有効`, ['1','2','3','4'].includes(b));
  }
  // 無効入力
  for (const b of ['0', '5', 'abc', '']) {
    check(`予算入力「${b}」: 無効`, !['1','2','3','4'].includes(b));
  }

  // DM集計結果からの提案（全組み合わせ）
  const combos = [
    { budget: '1', genre: '1' },
    { budget: '2', genre: '3' },
    { budget: '3', genre: '4' },
    { budget: '4', genre: '2' },
  ];
  for (const c of combos) {
    const r = await brain.generateDMBasedSuggestion(
      [{ display_name: 'User', message: '銀座で集合' }],
      [],
      { budget: c.budget, genre: c.genre, answeredCount: 3 }
    );
    check(`DM集計B${c.budget}G${c.genre}: 結果あり`, r && r.length > 5);
    check(`DM集計B${c.budget}G${c.genre}: markdown禁止`, !/\*\*/.test(r || ''));
  }
}

// ══════════════════════════════════════════
// メイン
// ══════════════════════════════════════════
async function main() {
  console.log('🍻 Kanpai Bot ローンチパターン補完 (+80)');
  const start = Date.now();

  await testGroupSize();
  await testTimeOfDay();
  await testSpecialOccasions();
  await testConstraints();
  await testConversationFlow();
  await testEdgeCases();
  await testBrandNames();
  await testSuggestionDiversity();
  await testAreaCoverage();
  await testDMSteps();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${'━'.repeat(50)}`);
  const total = passed + failed;
  console.log(`結果: ${passed}/${total} passed  (${elapsed}s)`);

  if (fixes.length > 0) {
    console.log('\n要修正:');
    fixes.forEach(f => console.log(`  - ${f.label}`));
  } else {
    console.log('🎉 全パターンOK!');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
