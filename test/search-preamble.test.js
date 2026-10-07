'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { annotateBudgetAlternative, buildRelaxedSearchPreamble, buildSearchAdjustmentText } = require('../search-preamble');
const flex = require('../flex');

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

test('lower-budget fallback names the changed budget consistently in preamble and Flex altText', () => {
  const original = [{ name: '架空店', genreName: '焼肉', searchMeta: { provider: 'hotpepper', relaxed: [] } }];
  const results = annotateBudgetAlternative(original, '4', '3', '高級店');
  const disclosure = '高級店では見つからなかったため、例えば予算〜6,000円なら候補があるよ🔍（元の条件とは異なるよ）';

  assert.notEqual(results, original);
  assert.equal(buildRelaxedSearchPreamble('高級店', results[0].searchMeta), disclosure);
  const card = flex.buildRestaurantCarousel(results, '4', '3', '渋谷');
  assert.match(card.altText, /元の予算条件（高級店）では見つからなかったため、例えば予算〜6,000円なら候補があるよ/);
  assert.match(card.altText, /渋谷周辺の焼肉（別案: 〜6,000円）/);
  assert.doesNotMatch(card.altText, /（高級店）を/);
});

test('removed or unknown budget filters disclose removal without inventing an amount', () => {
  const results = annotateBudgetAlternative([{
    name: '架空店',
    searchMeta: { provider: 'hotpepper', relaxed: ['budget'] },
  }], '4', '3', '高級店');
  const preamble = buildRelaxedSearchPreamble('高級店', results[0].searchMeta);
  const card = flex.buildRestaurantCarousel(results, '4', '3', '渋谷');

  assert.match(preamble, /予算上限を外した候補/);
  assert.match(preamble, /元の条件とは異なる/);
  assert.doesNotMatch(preamble, /〜6,000円/);
  assert.match(card.altText, /元の予算条件（高級店）では見つからなかったため、予算上限を外した候補/);
  assert.match(card.altText, /予算上限なし（別案）/);
  assert.doesNotMatch(card.altText, /〜6,000円/);

  const unknownBudget = annotateBudgetAlternative([{
    name: '架空別店',
    searchMeta: { provider: 'hotpepper', relaxed: [] },
  }], '2', 'unknown');
  const unknownText = buildRelaxedSearchPreamble('渋谷エリア・焼肉・〜4,000円', unknownBudget[0].searchMeta);
  assert.match(unknownText, /予算帯を変えた別候補/);
  assert.doesNotMatch(unknownText, /例えば予算/);
});

test('unchanged budget keeps the original output and adds no alternative wording', () => {
  const original = [{ name: '架空店', genreName: '焼肉', searchMeta: { provider: 'hotpepper', relaxed: [] } }];
  const results = annotateBudgetAlternative(original, '3', '3', '5,000円以内');
  const card = flex.buildRestaurantCarousel(results, '4', '3', '渋谷', '', { budgetLabel: '5,000円以内' });

  assert.equal(results, original);
  assert.equal(buildRelaxedSearchPreamble('5,000円以内', results[0].searchMeta), null);
  assert.match(card.altText, /渋谷周辺の焼肉（5,000円以内）/);
  assert.doesNotMatch(card.altText, /別案|元の予算条件/);
});
