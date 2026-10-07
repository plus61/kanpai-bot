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
    extractSearchOptions() { return {}; },
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

function shop(id) {
  return {
    hotpepperId: id,
    name: `fixture-${id}`,
    genreName: '焼肉',
    budget: '5,000円',
    address: '東京都渋谷区道玄坂二丁目',
    open: '17:00〜22:00',
    searchMeta: { provider: 'hotpepper', relaxed: [] },
  };
}

const threeShops = () => [shop('a'), shop('b'), shop('c')];

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
