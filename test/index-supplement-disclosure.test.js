'use strict';

// Offline integration regression: index.js runs against in-memory fixtures and
// mocked dependencies; no LINE, HTTP, database, or external search is called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flex = require('../flex');
const searchPreamble = require('../search-preamble');

function loadIndexHarness({ recentMessages, searchResults }) {
  const routes = { get: new Map(), post: new Map() };
  const app = {
    get(route, ...handlers) { routes.get.set(route, handlers); return this; },
    post(route, ...handlers) { routes.post.set(route, handlers); return this; },
    listen() { return { close() {} }; },
  };
  const express = () => app;
  express.json = () => function jsonParser() {};

  const replies = [];
  const lineClient = {
    async replyMessage(request) { replies.push(request); return {}; },
    async getGroupMemberProfile() { return { displayName: 'fixture-user' }; },
  };
  class MessagingApiClient {
    constructor() { return lineClient; }
  }

  const memory = {
    async getRecentMessages() { return recentMessages; },
    async getGroupFoodHistory() { return []; },
    async upsertMember() {},
    async logMessage() {},
    async touchGroupActivity() {},
    async updateLastBotMessage() {},
    async recordFood() {},
  };
  const brain = {
    async extractFoodFromText() { return { found: false }; },
    guessGenreFromMessages() { return '7'; },
  };
  const searchCalls = [];
  const search = {
    extractArea() { return '渋谷'; },
    extractSearchOptions() { return {}; },
    extractBudget() { return '4'; },
    async searchRestaurants(...args) {
      searchCalls.push(args);
      assert.ok(searchResults.length, 'Unexpected search call');
      return searchResults.shift();
    },
  };
  const kanji = {
    setLineClient() {},
    startCron() {},
    async checkDMTimeout() {},
  };
  const collector = { setLineClient() {} };
  const supabase = { createClient() { return {}; } };
  const mocks = new Map([
    ['dotenv', { config() {} }],
    ['express', express],
    ['@line/bot-sdk', { messagingApi: { MessagingApiClient } }],
    ['@supabase/supabase-js', supabase],
    ['./memory', memory],
    ['./brain', brain],
    ['./kanji', kanji],
    ['./collector', collector],
    ['./flex', flex],
    ['./search-preamble', searchPreamble],
    ['./search', search],
  ]);
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(name) {
      if (mocks.has(name)) return mocks.get(name);
      return require(name);
    },
    process: { env: { NODE_ENV: 'production' } },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: 'index.js' });

  return { routes, replies, searchCalls, module };
}

function shop(id, area, relaxed) {
  return {
    hotpepperId: id,
    name: `fixture-${id}`,
    genreName: 'イタリアン',
    budget: '4,000円',
    access: area,
    address: `東京都${area}一丁目`,
    open: '17:00〜22:00',
    url: `https://example.invalid/${id}`,
    searchMeta: {
      provider: 'hotpepper',
      relaxed,
      requestedArea: '渋谷',
      matchedArea: area,
    },
  };
}

test('high-end supplement discloses union of relaxations across displayed shops', async () => {
  const shibuya = shop('shibuya', '渋谷', []);
  const ebisu = shop('ebisu', '恵比寿', ['budget', 'area']);
  const omotesando = shop('omotesando', '表参道', ['lunch', 'area', 'genre']);
  const harness = loadIndexHarness({
    recentMessages: [{
      display_name: 'fixture-user',
      message: '渋谷で接待向けのイタリアンを教えて',
    }],
    searchResults: [[shibuya], [ebisu], [omotesando]],
  });
  const handlers = harness.routes.post.get('/webhook');
  assert.ok(handlers?.length);
  const handleWebhook = handlers[handlers.length - 1];
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  await handleWebhook({
    body: {
      events: [{
        type: 'message',
        replyToken: 'fixture-reply',
        source: { type: 'group', groupId: 'fixture-group', userId: 'fixture-user' },
        message: { type: 'text', text: '渋谷で接待向けのイタリアンを教えて' },
      }],
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(harness.searchCalls.length, 3);
  assert.deepEqual(
    harness.searchCalls.map(call => call[0]),
    ['7', '7', '2'],
  );
  assert.equal(harness.replies.length, 1);
  const [textMessage, flexMessage] = harness.replies[0].messages;
  const expectedDisclosure = '予算条件を外して、ランチ条件を外して、近隣エリアまで広げて、ジャンル条件を外して探したよ';
  assert.match(textMessage.text, new RegExp(expectedDisclosure));
  assert.match(flexMessage.altText, new RegExp(expectedDisclosure));
  assert.match(flexMessage.altText, /渋谷近隣/);
  assert.doesNotMatch(flexMessage.altText, /渋谷周辺/);
  assert.deepEqual(shibuya.searchMeta.relaxed, []);
});
