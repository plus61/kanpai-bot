'use strict';

// Offline integration regression: generated replies use fabricated results
// and an in-memory search mock. No API, database, credentials, or endpoints.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flex = require('../flex');
const searchPreamble = require('../search-preamble');

function loadBrainHarness(searchResults) {
  const calls = [];
  const search = {
    extractArea(messages) {
      const text = Array.isArray(messages) ? messages.map(message => message.message || '').join(' ') : String(messages || '');
      return text.includes('渋谷') ? '渋谷' : null;
    },
    extractBudget(text) {
      const manMatch = String(text || '').match(/([\d.]+)万(?:円)?/);
      const yenMatch = String(text || '').match(/([\d,]+)円/);
      const amount = manMatch
        ? Number(manMatch[1]) * 10000
        : yenMatch ? Number(yenMatch[1].replace(/,/g, '')) : NaN;
      if (!Number.isFinite(amount)) return null;
      if (amount <= 2000) return '1';
      if (amount <= 4000) return '2';
      if (amount <= 6000) return '3';
      return '4';
    },
    extractSearchOptions(text) {
      return String(text || '').includes('ベジタリアン') ? { keywords: ['ベジタリアン'] } : {};
    },
    async searchRestaurants(...args) {
      calls.push(args);
      assert.ok(searchResults.length, 'Unexpected search call');
      return searchResults.shift();
    },
  };
  class OpenAI {
    constructor() {
      this.chat = { completions: { async create() { throw new Error('Unexpected OpenAI call'); } } };
    }
  }
  const mocks = new Map([
    ['dotenv', { config() {} }],
    ['openai', OpenAI],
    ['./search', search],
    ['./search-preamble', searchPreamble],
    ['./flex', flex],
  ]);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'brain.js'), 'utf8'), {
    module,
    exports: module.exports,
    require(name) {
      if (mocks.has(name)) return mocks.get(name);
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: { OPENAI_API_KEY: 'fixture-only' } },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: 'brain.js' });
  return { brain: module.exports, calls };
}

function shop(id, relaxed = []) {
  return {
    hotpepperId: id,
    name: `fixture-${id}`,
    genreName: '焼肉',
    budget: '5,000円',
    address: '東京都渋谷区道玄坂二丁目',
    open: '17:00〜22:00',
    searchMeta: { provider: 'hotpepper', relaxed },
  };
}

const threeShops = (relaxed = []) => [shop('a', relaxed), shop('b', relaxed), shop('c', relaxed)];

test('condition-update retry discloses that the returned budget exceeds the original cap', async () => {
  const { brain, calls } = loadBrainHarness([[], threeShops()]);
  const request = '渋谷で焼肉を3000円以内で';
  const response = await brain.generateFreeResponse([
    { display_name: 'fixture-user', message: request },
  ], request, 'fixture-user');

  assert.deepEqual(calls.map(call => call[1]), ['2', '3']);
  assert.equal(response.length, 2);
  const [preamble, card] = response;
  assert.match(preamble.text, /渋谷エリア・焼肉・3000円以内では見つからなかったため、例えば予算〜6,000円/);
  assert.match(card.altText, /別案: 〜6,000円/);
  assert.doesNotMatch(card.altText, /条件変更OK！3000円以内で探し直した/);
  assert.doesNotMatch(card.altText, /検索キーワード|食事制約への適合/);
});

test('more-results retry preserves the prior exact budget and labels the new cap as an alternative', async () => {
  const { brain, calls } = loadBrainHarness([[], threeShops()]);
  const response = await brain.generateFreeResponse([
    { display_name: 'fixture-user', message: '渋谷で焼肉を3000円以内で探して' },
  ], '他にも？', 'fixture-user');

  assert.deepEqual(calls.map(call => call[1]), ['2', '3']);
  assert.equal(response.length, 2);
  const [preamble, card] = response;
  assert.match(preamble.text, /渋谷エリア・焼肉・3000円以内では見つからなかったため、例えば予算〜6,000円/);
  assert.match(card.altText, /別案: 〜6,000円/);
});

test('keyword fallback restores the original budget and discloses that dietary fit is unverified', async () => {
  const { brain, calls } = loadBrainHarness([[], [], threeShops()]);
  const request = '渋谷でベジタリアンの焼肉を3000円以内で';
  const response = await brain.generateFreeResponse([
    { display_name: 'fixture-user', message: request },
  ], request, 'fixture-user');

  assert.deepEqual(calls.map(call => call[1]), ['2', '3', '2']);
  assert.deepEqual(calls.map(call => [...(call[4].keywords || [])]), [
    ['ベジタリアン'], ['ベジタリアン'], [],
  ]);
  const preamble = Array.isArray(response) ? response.find(message => message.type === 'text') : null;
  const card = Array.isArray(response) ? response.find(message => message.type === 'flex') : response;
  assert.equal(card?.type, 'flex');
  assert.match(preamble?.text || '', /「渋谷エリア・焼肉・3000円以内」では条件に合うお店が見つからなかったため、検索キーワード（ベジタリアン）を外した候補/);
  assert.match(preamble?.text || '', /食事制約への適合は未確認だよ/);
  assert.match(card.altText, /検索キーワード（ベジタリアン）を外した候補/);
  assert.match(card.altText, /食事制約への適合は未確認だよ/);
  assert.match(card.altText, /渋谷周辺の焼肉（3000円以内）を3件/);
  assert.doesNotMatch(card.altText, /条件変更OK|別案|〜6,000円/);
});

test('keyword removal combined with an unfiltered result reports both changes without reviving the budget alternative', async () => {
  const { brain, calls } = loadBrainHarness([[], [], threeShops(['budget'])]);
  const request = '渋谷でベジタリアンの焼肉を3000円以内で';
  const response = await brain.generateFreeResponse([
    { display_name: 'fixture-user', message: request },
  ], request, 'fixture-user');

  assert.deepEqual(calls.map(call => call[1]), ['2', '3', '2']);
  assert.deepEqual(calls.map(call => [...(call[4].keywords || [])]), [
    ['ベジタリアン'], ['ベジタリアン'], [],
  ]);
  const preamble = Array.isArray(response) ? response.find(message => message.type === 'text') : null;
  const card = Array.isArray(response) ? response.find(message => message.type === 'flex') : response;
  assert.equal(card?.type, 'flex');
  assert.match(preamble?.text || '', /3000円以内.*予算条件を外して/);
  assert.match(preamble?.text || '', /検索キーワード（ベジタリアン）を外した候補/);
  assert.match(preamble?.text || '', /食事制約への適合は未確認だよ/);
  assert.match(card.altText, /検索キーワード（ベジタリアン）を外した候補/);
  assert.match(card.altText, /予算条件を外して/);
  assert.match(card.altText, /食事制約への適合は未確認だよ/);
  assert.doesNotMatch(card.altText, /条件変更OK|例えば予算〜6,000円|別案: 〜6,000円/);
});
