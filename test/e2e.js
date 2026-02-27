/**
 * e2e.js - Kanpai Bot E2Eテスト
 * 本番Vercelエンドポイントに正規署名付きリクエストを送信して動作確認
 *
 * 実行: node test/e2e.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const crypto = require('crypto');
const https = require('https');

const BASE_URL = process.env.TEST_URL || 'https://kanpai-bot.vercel.app';
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// テスト用ダミーID
const TEST_GROUP_ID = 'Ctest_group_e2e_001';
const TEST_USER_ID = 'Utest_user_e2e_001';
const TEST_USER2_ID = 'Utest_user_e2e_002';

let passed = 0;
let failed = 0;

function sign(body) {
  return crypto.createHmac('SHA256', CHANNEL_SECRET).update(body).digest('base64');
}

function makeEvent(type, overrides = {}) {
  const base = {
    type,
    timestamp: Date.now(),
    source: {
      type: 'group',
      groupId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
    },
    replyToken: 'test_reply_token_' + Date.now(),
  };
  return { ...base, ...overrides };
}

function makeTextEvent(text, sourceOverride = {}) {
  return makeEvent('message', {
    message: { type: 'text', id: 'msg_' + Date.now(), text },
    source: { type: 'group', groupId: TEST_GROUP_ID, userId: TEST_USER_ID, ...sourceOverride },
  });
}

async function post(path, body) {
  const bodyStr = JSON.stringify(body);
  const sig = sign(bodyStr);

  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-line-signature': sig,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log('✅ PASS');
    passed++;
  } catch (e) {
    console.log(`❌ FAIL: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

// ──────────────────────────────────────────────
async function runTests() {
  console.log('\n🍻 Kanpai Bot E2E Tests');
  console.log(`📡 Target: ${BASE_URL}\n`);

  // 1. ヘルスチェック
  console.log('■ Basic');
  await test('GET / returns 200 + status', async () => {
    const res = await new Promise((resolve) => {
      https.get(BASE_URL + '/', (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(d) }));
      });
    });
    assert(res.status === 200, `status: ${res.status}`);
    assert(res.body.status.includes('Kanpai'), `body: ${JSON.stringify(res.body)}`);
  });

  // 2. Webhook 署名OK
  console.log('\n■ Webhook');
  await test('POST /webhook with valid signature returns 200', async () => {
    const res = await post('/webhook', { events: [] });
    assert(res.status === 200, `status: ${res.status}`);
  });

  await test('Empty events → 200 ok', async () => {
    const res = await post('/webhook', { events: [] });
    assert(res.status === 200);
    assert(res.body.status === 'ok', `body: ${JSON.stringify(res.body)}`);
  });

  // 3. グループJoin
  console.log('\n■ Events');
  await test('join event → 200 (greets the group)', async () => {
    const event = makeEvent('join', {
      source: { type: 'group', groupId: TEST_GROUP_ID },
    });
    delete event.source.userId;
    const res = await post('/webhook', { events: [event] });
    assert(res.status === 200);
  });

  // 4. 食事記録
  await test('food record: ラーメン食べた → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('ラーメン食べた')]
    });
    assert(res.status === 200);
  });

  // 5. 食事提案トリガー
  await test('food trigger: 何食べる → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('今日何食べる？')]
    });
    assert(res.status === 200);
  });

  // 6. DMフロートリガー
  await test('DM trigger: 今夜どこ行く？ → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('今夜どこ行く？')]
    });
    assert(res.status === 200);
  });

  await test('DM trigger: みんなに聞いて → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('みんなに聞いて')]
    });
    assert(res.status === 200);
  });

  // 7. 個人DMでの回答（セッションなし → フォールバック）
  await test('DM response without session → 200', async () => {
    const event = makeTextEvent('2', { type: 'user' }); // 個人DM
    event.source = { type: 'user', userId: TEST_USER2_ID };
    const res = await post('/webhook', {
      events: [event]
    });
    assert(res.status === 200);
  });

  // 8. メンション
  await test('@Kanpai mention → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('@Kanpai おすすめ教えて')]
    });
    assert(res.status === 200);
  });

  // 9. 投票作成
  await test('vote create: 焼肉か寿司か投票して → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('@Kanpai 焼肉か寿司か投票して')]
    });
    assert(res.status === 200);
  });

  // 10. 投票応答
  await test('vote response: 1 → 200', async () => {
    const res = await post('/webhook', {
      events: [makeTextEvent('1')]
    });
    assert(res.status === 200);
  });

  // 11. Cron エンドポイント（認証なしは401）
  console.log('\n■ Cron');
  await test('GET /cron/dm-timeout without auth → 401', async () => {
    const res = await new Promise((resolve) => {
      https.get(BASE_URL + '/cron/dm-timeout', (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode }));
      });
    });
    assert(res.status === 401, `status should be 401, got ${res.status}`);
  });

  // 結果
  console.log(`\n${'─'.repeat(40)}`);
  const total = passed + failed;
  console.log(`結果: ${passed}/${total} passed`);
  if (failed > 0) {
    console.log(`⚠️  ${failed} tests failed`);
    process.exit(1);
  } else {
    console.log('🎉 All tests passed!');
  }
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
