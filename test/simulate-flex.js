/**
 * simulate-flex.js - Flex Message テスト
 * 実際のHotpepperデータでFlexを生成し、構造・内容を検証
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const search = require('../search');
const flex = require('../flex');

let passed = 0; let failed = 0;

function check(label, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

function validateBubble(bubble, label) {
  check(`${label}: type=bubble`, bubble.type === 'bubble');
  check(`${label}: header存在`, !!bubble.header);
  check(`${label}: body存在`, !!bubble.body);
  check(`${label}: footer存在`, !!bubble.footer);
  check(`${label}: ボタンあり`, bubble.footer?.contents?.length > 0);

  // テキストにmarkdownがないか
  const bodyStr = JSON.stringify(bubble.body);
  check(`${label}: markdown禁止`, !/\*\*|__/.test(bodyStr));

  // 文字数制限（LINEは1テキスト要素300文字まで）
  const texts = bubble.body.contents
    .flatMap(c => c.contents || [c])
    .filter(c => c.type === 'text')
    .map(c => c.text || '');
  const tooLong = texts.filter(t => t.length > 300);
  check(`${label}: テキスト長さOK`, tooLong.length === 0, tooLong.join(', ').substring(0, 50));
}

async function testFlexGeneration() {
  console.log('\n━━ Flex生成テスト（実Hotpepperデータ）━━\n');

  const combos = [
    { area: '渋谷', genre: '4', budget: '2', label: '渋谷×焼肉' },
    { area: '新宿', genre: '3', budget: '2', label: '新宿×ラーメン' },
    { area: '銀座', genre: '2', budget: '3', label: '銀座×洋食' },
    { area: '梅田', genre: '5', budget: '2', label: '梅田×居酒屋' },
    { area: '博多', genre: '1', budget: '2', label: '博多×和食' },
  ];

  for (const c of combos) {
    console.log(`\n[${c.label}]`);
    const restaurants = await search.searchRestaurants(c.genre, c.budget, c.area, 3);

    check('検索結果あり', restaurants && restaurants.length > 0,
      `${restaurants?.length}件`);

    if (!restaurants || restaurants.length === 0) continue;

    // Flexカルーセル生成
    const carousel = flex.buildRestaurantCarousel(restaurants, c.genre, c.budget, c.area);

    check('カルーセル生成OK', carousel !== null);
    check('type=flex', carousel?.type === 'flex');
    check('altText設定済み', carousel?.altText?.length > 5);
    check('contents.type=carousel', carousel?.contents?.type === 'carousel');

    const bubbles = carousel?.contents?.contents || [];
    check(`バブル数: ${bubbles.length}件`, bubbles.length > 0 && bubbles.length <= 3);

    // 各バブルを検証
    bubbles.forEach((bubble, i) => {
      validateBubble(bubble, `${c.label}[${i+1}]`);
    });

    // 実際の店名がaltTextに含まれるか
    const firstShop = restaurants[0];
    console.log(`  店1: ${firstShop.name}`);
    console.log(`  altText: ${carousel.altText}`);

    // JSONサイズ確認（LINEは10KB制限）
    const jsonSize = JSON.stringify(carousel).length;
    check(`JSONサイズ <10KB`, jsonSize < 10000, `${(jsonSize/1000).toFixed(1)}KB`);
  }
}

async function testEdgeCases() {
  console.log('\n━━ Flexエッジケーステスト ━━');

  // 空結果
  const emptyResult = flex.buildRestaurantCarousel([], '1', '2', '渋谷');
  check('空配列→null返却', emptyResult === null);

  // null入力
  const nullResult = flex.buildRestaurantCarousel(null, '1', '2', '渋谷');
  check('null→null返却', nullResult === null);

  // 1件のみ
  const oneShop = [{
    name: 'テスト食堂',
    catchCopy: 'テスト用のキャッチコピー',
    access: '渋谷駅徒歩3分',
    budget: '2000円',
    open: '月〜金 18:00〜23:00',
    url: 'https://example.com',
  }];
  const oneResult = flex.buildRestaurantCarousel(oneShop, '5', '2', '渋谷');
  check('1件→正常生成', oneResult !== null);
  check('1件→バブル1個', oneResult?.contents?.contents?.length === 1);

  // 長い店名・長いキャッチコピー
  const longShop = [{
    name: 'とても長い名前の居酒屋 渋谷道玄坂店 本格派創作料理と地酒の店',
    catchCopy: 'これはとても長いキャッチコピーです。50文字以上のキャッチコピーが入った場合のテストです。正しく切り詰められるか確認します。',
    access: 'JR渋谷駅A出口より徒歩5分、東急東横線渋谷駅より徒歩3分',
    budget: '3000円〜5000円（飲み放題コースあり）',
  }];
  const longResult = flex.buildRestaurantCarousel(longShop, '5', '2', '渋谷');
  check('長テキスト→生成OK', longResult !== null);

  const longJsonSize = JSON.stringify(longResult).length;
  check('長テキスト→JSONサイズOK', longJsonSize < 10000, `${(longJsonSize/1000).toFixed(1)}KB`);

  // Summary Bubble
  const summary = '📊 みんなの本音を集めたよ（3人が回答）\n\n💰 予算：〜4,000円\n🍽️ ジャンル：焼肉\n\nこの条件でお店を探すね！';
  const summaryBubble = flex.buildSummaryBubble(summary);
  check('サマリーバブル生成', summaryBubble !== null);
  check('サマリー type=flex', summaryBubble?.type === 'flex');
}

async function testLineApiFormat() {
  console.log('\n━━ LINE API フォーマット検証 ━━');

  const restaurants = await search.searchRestaurants('4', '2', '新宿', 3);
  if (!restaurants || restaurants.length === 0) {
    console.log('  ⚠️ 検索結果なし、スキップ');
    return;
  }

  const carousel = flex.buildRestaurantCarousel(restaurants, '4', '2', '新宿');

  // LINE replyMessage形式の検証
  const replyPayload = {
    replyToken: 'dummy_token',
    messages: [carousel],
  };

  check('replyPayload構造OK', Array.isArray(replyPayload.messages));
  check('messages[0].type=flex', replyPayload.messages[0]?.type === 'flex');
  check('altText必須フィールド存在', !!replyPayload.messages[0]?.altText);
  check('contents必須フィールド存在', !!replyPayload.messages[0]?.contents);

  // JSON全体を出力（確認用）
  console.log('\n  [LINE APIペイロードプレビュー]');
  const preview = JSON.stringify(carousel, null, 2).substring(0, 500);
  console.log(preview + '\n  ...(省略)');
}

async function main() {
  console.log('🃏 Kanpai Bot Flex Message テスト\n');
  const start = Date.now();

  await testFlexGeneration();
  await testEdgeCases();
  await testLineApiFormat();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${'━'.repeat(50)}`);
  const total = passed + failed;
  console.log(`結果: ${passed}/${total} passed  (${elapsed}s)`);
  if (failed === 0) console.log('🎉 Flex Message、全テストOK！LINEに送れる状態です');
  else console.log(`⚠️  ${failed}件要修正`);
}

main().catch(e => { console.error(e); process.exit(1); });
