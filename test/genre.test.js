'use strict';

// Offline regression tests: only fabricated data and in-memory API/cache mocks.
// Never load dotenv, real dependencies, credentials, or application endpoints.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function loadModule(file, requireMock, env = {}) {
  const sandbox = {
    module: { exports: {} }, require: requireMock,
    process: { env }, URLSearchParams,
    console: { log() {}, error() {} },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
const searchPreamble = require('../search-preamble');
const searchCriteria = require('../search-criteria');
const flex = loadModule('flex.js', name => {
  if (name === './search-preamble') return searchPreamble;
  throw new Error(`Unexpected dependency: ${name}`);
});

function mockSearch({ shops = [], cached = null, responses } = {}) {
  const calls = [], writes = [];
  const apiResponses = responses || [{ results: { shop: shops } }];
  const https = {
    get(url, callback) {
      calls.push(url);
      assert.ok(apiResponses.length, 'Unexpected API request');
      const payload = apiResponses.shift();
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = new EventEmitter();
        callback(response);
        response.emit('data', JSON.stringify(payload));
        response.emit('end');
      });
      return request;
    },
  };
  const cacheQuery = {
    select() { return this; }, eq() { return this; }, gt() { return this; },
    async single() { return { data: cached ? { results: cached } : null }; },
    async upsert(data) { writes.push(data); return {}; },
  };
  const search = loadModule('search.js', name => {
    if (name === 'dotenv') return { config() {} };
    if (name === 'https') return https;
    if (name === './search-criteria') return searchCriteria;
    if (name === '@supabase/supabase-js') return { createClient: () => ({ from: () => cacheQuery }) };
    throw new Error(`Unexpected dependency: ${name}`);
  }, { HOTPEPPER_API_KEY: 'fixture-only' });
  return { search, calls, writes };
}

function shop(id, genreName, { area = '架空エリア', open = '11:00〜22:00' } = {}) {
  return {
    id, name: `架空店舗${id}`, ...(genreName === undefined ? {} : { genre: { name: genreName } }),
    catch: '架空の説明', budget: { average: '3,000円' }, mobile_access: '架空駅徒歩5分',
    open, small_area: { name: area }, address: `東京都${area}一丁目`,
    urls: { pc: `https://www.hotpepper.jp/str${id}/` },
  };
}
function headers(restaurants, options = {}) {
  return Array.from(flex.buildRestaurantCarousel(restaurants, '7', '2', '架空エリア', 'fixture-group', options)
    .contents.contents, bubble => bubble.header.contents[0].text);
}

test('Italian request displays Chinese actual genre and retains it in the cache', async () => {
  const { search, calls, writes } = mockSearch({ shops: [shop('fixture1', '中華')] });
  const results = await search.searchRestaurants('7', '2', '架空エリア');
  assert.equal(results[0].genreName, '中華');
  assert.deepEqual(headers(results), ['中華']);
  assert.equal(writes[0].results[0].genreName, '中華');
  assert.equal(new URL(calls[0]).searchParams.get('genre'), 'G006');
});

test('all supported app genres use their HotPepper genre codes', async () => {
  const expected = [
    ['1', 'G004'], ['2', 'G005'], ['3', 'G007'], ['4', 'G008'],
    ['5', 'G001'], ['6', 'G013'], ['7', 'G006'], ['8', 'G014'],
  ];
  const responses = Array.from({ length: expected.length }, () => ({
    results: { shop: [shop('fixture-map', '架空ジャンル')] },
  }));
  const { search, calls } = mockSearch({ responses });
  for (const [appGenre] of expected) {
    await search.searchRestaurants(appGenre, '2', '架空エリア');
  }
  assert.deepEqual(
    calls.map(url => new URL(url).searchParams.get('genre')),
    expected.map(([, hotpepperGenre]) => hotpepperGenre)
  );
});

test('Italian actual genre is displayed for an Italian request', async () => {
  const { search } = mockSearch({ shops: [shop('fixture2', 'イタリアン')] });
  assert.deepEqual(headers(await search.searchRestaurants('7', '2', '架空エリア')), ['イタリアン']);
});

test('mixed results keep each actual genre and original ranking', async () => {
  const { search } = mockSearch({ shops: [shop('fixture3', '中華'), shop('fixture4', 'イタリアン・フレンチ'), shop('fixture5', '焼肉・ホルモン')] });
  const results = await search.searchRestaurants('7', '2', '架空エリア');
  assert.deepEqual(headers(results), ['中華', 'イタリアン・フレンチ', '焼肉・ホルモン']);
  assert.deepEqual(Array.from(results, r => r.hotpepperId), ['fixture3', 'fixture4', 'fixture5']);
  assert.deepEqual(Array.from(flex.buildRestaurantCarousel(results, '7', '2', '架空エリア').contents.contents,
    b => b.body.contents[0].contents[0].text), ['🥇', '🥈', '🥉']);
});

test('missing HotPepper genre uses neutral header', async () => {
  const { search } = mockSearch({ shops: [shop('fixture6')] });
  assert.deepEqual(headers(await search.searchRestaurants('7', '2', '架空エリア')), ['お店']);
});

test('old cache without genre never borrows request genre or calls APIs', async () => {
  const cached = [{ name: '架空旧キャッシュ店舗', budget: '3,000円' }];
  const { search, calls, writes } = mockSearch({ cached });
  assert.deepEqual(headers(await search.searchRestaurants('7', '2', '架空エリア')), ['お店']);
  assert.equal(calls.length, 0);
  assert.equal(writes.length, 0);
});

test('new cache keeps per-shop genre without APIs', async () => {
  const { search, calls } = mockSearch({ cached: [{ name: '架空店舗', genreName: '中華' }] });
  assert.deepEqual(headers(await search.searchRestaurants('7', '2', '架空エリア')), ['中華']);
  assert.equal(calls.length, 0);
});

test('empty, whitespace, null and malformed genre values stay neutral', () => {
  for (const genreName of ['', '   ', null, {}, 7, undefined]) {
    assert.deepEqual(headers([{ name: '架空店舗', genreName }]), ['お店']);
  }
  assert.deepEqual(headers([{ name: '架空店舗', source: 'places' }]), ['お店']);
});

test('keyword-only fallback still uses actual returned genre', async () => {
  const { search, calls } = mockSearch({ responses: [
    { results: { shop: [] } }, { results: { shop: [] } },
    { results: { shop: [shop('fixture7', '中華')] } },
  ] });
  assert.deepEqual(headers(await search.searchRestaurants('7', '2', '架空エリア')), ['中華']);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[2]).searchParams.has('genre'), false);
});

test('fallback result records the budget constraint that was removed', async () => {
  const { search } = mockSearch({ responses: [
    { results: { shop: [] } },
    { results: { shop: [shop('fixture-budget', 'イタリアン・フレンチ')] } },
  ] });
  const results = await search.searchRestaurants('7', '2', '架空エリア');
  assert.equal(results[0].searchMeta.provider, 'hotpepper');
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), ['budget']);
});

test('lunch fallback result records that the lunch filter was removed', async () => {
  const { search } = mockSearch({ responses: [
    { results: { shop: [] } },
    { results: { shop: [] } },
    { results: { shop: [shop('fixture-lunch', 'イタリアン・フレンチ')] } },
  ] });
  const results = await search.searchRestaurants('7', '2', '架空エリア', 3, { lunch: true });
  assert.equal(results[0].searchMeta.provider, 'hotpepper');
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), ['budget', 'lunch']);
});

test('keyword-only fallback records both genre and budget relaxation', async () => {
  const { search } = mockSearch({ responses: [
    { results: { shop: [] } }, { results: { shop: [] } },
    { results: { shop: [shop('fixture-any', '居酒屋')] } },
  ] });
  const results = await search.searchRestaurants('7', '2', '架空エリア');
  assert.equal(results[0].searchMeta.provider, 'hotpepper');
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), ['budget', 'genre']);
});

test('area match is checked against actual shop data and actual genre stays visible', async () => {
  const { search } = mockSearch({ shops: [
    shop('fixture-shibuya', '中華', { area: '渋谷' }),
    shop('fixture-ebisu', '海鮮・焼肉', { area: '恵比寿' }),
  ] });
  const results = await search.searchRestaurants('7', '2', '渋谷');
  assert.deepEqual(Array.from(results, result => result.hotpepperId), ['fixture-shibuya']);
  assert.equal(results[0].genreName, '中華');
  assert.deepEqual(headers(results), ['中華']);
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), []);
});

test('lunch candidates opening at 14:00 or with unknown hours are skipped, and relaxed altText stops claiming lunch', async () => {
  const late = shop('fixture-late-lunch', 'イタリアン', { open: '14:00〜23:00' });
  const unknown = shop('fixture-unknown-hours', '中華', { open: '' });
  const { search } = mockSearch({ responses: [
    { results: { shop: [late, unknown] } },
    { results: { shop: [late, unknown] } },
    { results: { shop: [late, unknown] } },
  ] });
  const results = await search.searchRestaurants('7', '2', '架空エリア', 3, { lunch: true });
  assert.equal(results[0].hotpepperId, 'fixture-late-lunch');
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), ['budget', 'lunch']);
  const card = flex.buildRestaurantCarousel(results, '7', '2', '架空エリア', '', { lunch: true });
  assert.match(card.altText, /ランチ条件を外して探したよ/);
  assert.doesNotMatch(card.altText, /のランチ（/);
});

test('fallback order keeps genre until budget, lunch, and adjacent-area stages are exhausted', async () => {
  const { search, calls } = mockSearch({ responses: [
    { results: { shop: [] } }, // original constraints
    { results: { shop: [] } }, // budget relaxed
    { results: { shop: [] } }, // lunch relaxed
    { results: { shop: [shop('fixture-neighbor', '中華', { area: '恵比寿' })] } },
    { results: { shop: [] } }, // continue gathering up to the requested count
    { results: { shop: [] } },
  ] });
  const results = await search.searchRestaurants('7', '2', '渋谷', 3, { lunch: true });
  assert.equal(calls.length, 6);
  const params = calls.map(url => new URL(url).searchParams);
  assert.deepEqual(params.map(p => p.get('genre')), Array(6).fill('G006'));
  assert.deepEqual(params.map(p => p.get('budget')), ['B006', null, null, null, null, null]);
  assert.deepEqual(params.map(p => p.get('lunch')), ['1', '1', null, null, null, null]);
  assert.deepEqual(params.map(p => p.get('keyword')), ['渋谷', '渋谷', '渋谷', '恵比寿', '表参道', '代官山']);
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), ['budget', 'lunch', 'area']);
});

test('genre is removed only after all neighboring-area searches miss', async () => {
  const { search, calls } = mockSearch({ responses: [
    { results: { shop: [] } }, { results: { shop: [] } }, { results: { shop: [] } },
    { results: { shop: [] } }, { results: { shop: [] } }, { results: { shop: [] } },
    { results: { shop: [shop('fixture-genre-last', '中華', { area: '渋谷' })] } },
    { results: { shop: [] } }, { results: { shop: [] } }, { results: { shop: [] } },
  ] });
  const results = await search.searchRestaurants('7', '2', '渋谷', 3, { lunch: true });
  assert.equal(calls.length, 10);
  const params = calls.map(url => new URL(url).searchParams);
  assert.deepEqual(params.slice(0, 6).map(p => p.get('genre')), Array(6).fill('G006'));
  assert.deepEqual(params.slice(6).map(p => p.has('genre')), Array(4).fill(false));
  assert.deepEqual(Array.from(results[0].searchMeta.relaxed), ['budget', 'lunch', 'genre']);
});

test('budget, area, lunch filter and card details remain intact', async () => {
  const { search, calls } = mockSearch({ shops: [shop('fixture8', '中華')] });
  const results = await search.searchRestaurants('7', '2', '架空エリア', 3, { lunch: true });
  const params = new URL(calls[0]).searchParams;
  assert.equal(params.get('budget'), 'B006');
  assert.equal(params.get('keyword'), '架空エリア');
  assert.equal(params.get('lunch'), '1');
  assert.deepEqual(headers(results, { lunch: true }), ['中華']);
  const card = flex.buildRestaurantCarousel(results, '7', '2', '架空エリア', '', { lunch: true, budgetLabel: '3,000円以内' });
  assert.match(card.altText, /ランチ（3,000円以内）/);
  const content = JSON.stringify(card.contents.contents[0].body);
  for (const text of ['架空店舗fixture8', '3,000円', '架空駅徒歩5分', '11:00〜22:00']) assert.ok(content.includes(text));
  assert.equal(card.contents.contents[0].header.contents[0].wrap, true);
});


test('summary describes Chinese results instead of the Italian request', () => {
  const card = flex.buildRestaurantCarousel([{ name: '架空中華店', genreName: '中華' }], '7', '2', '架空エリア');
  assert.match(card.altText, /架空エリア周辺の中華（〜4,000円）を1件見つけた/);
  assert.ok(!card.altText.includes('イタリアン'));
});

test('summary keeps a uniform actual Italian genre', () => {
  const card = flex.buildRestaurantCarousel([
    { name: '架空店舗A', genreName: ' イタリアン・フレンチ ' },
    { name: '架空店舗B', genreName: 'イタリアン・フレンチ' },
  ], '7', '2', '架空エリア');
  assert.match(card.altText, /のイタリアン・フレンチ（/);
});

test('summary stays neutral for mixed, missing and malformed actual genres', () => {
  for (const restaurants of [
    [{ name: '架空中華店', genreName: '中華' }, { name: '架空伊料理店', genreName: 'イタリアン' }],
    [{ name: '架空旧cache店' }],
    [{ name: '架空中華店', genreName: '中華' }, { name: '架空欠損店' }],
    [{ name: '架空不正店', genreName: {} }],
    [{ name: '架空空白店', genreName: '  ' }],
    [{ name: '架空Places店', source: 'places' }],
  ]) {
    const card = flex.buildRestaurantCarousel(restaurants, '7', '2', '架空エリア');
    assert.match(card.altText, /のお店（/);
    assert.ok(!card.altText.includes('のイタリアン（'));
  }
});

test('summary genre only reflects the three displayed shops and keeps prefix/budget', () => {
  const card = flex.buildRestaurantCarousel([
    { name: '架空A', genreName: '中華' }, { name: '架空B', genreName: '中華' },
    { name: '架空C', genreName: '中華' }, { name: '架空D', genreName: 'イタリアン' },
  ], '7', '2', '架空エリア', '', { budgetLabel: '3,000円以内', prefix: '架空の導入' });
  assert.match(card.altText, /^架空の導入\n架空エリア周辺の中華（3,000円以内）/);
  assert.ok(!card.altText.includes('架空D'));
  assert.equal(card.contents.contents.length, 3);
});
