'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRelaxedSearchPreamble, buildSearchAdjustmentText } = require('../search-preamble');

test('strict results keep the existing preamble', () => {
  assert.equal(
    buildRelaxedSearchPreamble('渋谷エリア・イタリアン・ランチ', {
      provider: 'hotpepper',
      relaxed: [],
    }),
    null
  );
});

test('budget fallback says the requested conditions missed before budget was removed', () => {
  assert.equal(
    buildRelaxedSearchPreamble('渋谷エリア・イタリアン・ランチ・〜4,000円', {
      provider: 'hotpepper',
      relaxed: ['budget'],
    }),
    '渋谷エリア・イタリアン・ランチ・〜4,000円で条件に合うお店が見つからなかったため、予算条件を外して探したよ🔍'
  );
});

test('combined fallback names each removed search condition', () => {
  assert.match(
    buildRelaxedSearchPreamble('新宿エリア・イタリアン・ランチ', {
      provider: 'hotpepper',
      relaxed: ['budget', 'lunch', 'area', 'genre'],
    }),
    /予算条件を外して、ランチ条件を外して、近隣エリアまで広げて、ジャンル条件を外して探したよ/
  );
});

test('carousel adjustment text uses the same ordered fallback explanation', () => {
  assert.equal(
    buildSearchAdjustmentText({ provider: 'hotpepper', relaxed: ['budget', 'lunch', 'area'] }),
    '予算条件を外して、ランチ条件を外して、近隣エリアまで広げて探したよ🔍'
  );
});

test('Places fallback is identified even when there is no filter to relax', () => {
  assert.equal(
    buildRelaxedSearchPreamble('渋谷エリア', {
      provider: 'places',
      relaxed: [],
    }),
    'HotPepperで見つからず、Google Placesでも探したよ🗺️（予算・ジャンル・ランチの一致は保証されないよ）'
  );
});
