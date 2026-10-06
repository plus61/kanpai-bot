'use strict';

const RELAXED_CONDITION_LABELS = Object.freeze({
  budget: '予算条件',
  lunch: 'ランチ条件',
  area: '指定エリアから近隣エリアへ',
  genre: 'ジャンル条件',
});
const RELAXED_CONDITION_ACTIONS = Object.freeze({
  budget: '予算条件を外して',
  lunch: 'ランチ条件を外して',
  area: '近隣エリアまで広げて',
  genre: 'ジャンル条件を外して',
});

function buildSearchAdjustmentText(searchMeta) {
  if (!searchMeta) return '';
  const relaxed = Array.isArray(searchMeta.relaxed) ? searchMeta.relaxed : [];
  const adjustments = relaxed
    .map(condition => RELAXED_CONDITION_ACTIONS[condition])
    .filter(Boolean);
  const messages = [];
  if (adjustments.length > 0) messages.push(`${adjustments.join('、')}探したよ🔍`);
  if (searchMeta.provider === 'places') {
    messages.push('HotPepperで見つからず、Google Placesでも探したよ🗺️（予算・ジャンル・ランチの一致は保証されないよ）');
  }
  return messages.join('\n');
}

function buildRelaxedSearchPreamble(conditionText, searchMeta) {
  if (!searchMeta) return null;

  const relaxed = Array.isArray(searchMeta.relaxed) ? searchMeta.relaxed : [];
  const adjustmentText = buildSearchAdjustmentText(searchMeta);
  const hasRelaxations = relaxed.some(condition => RELAXED_CONDITION_LABELS[condition]);
  const messages = [];

  if (hasRelaxations) {
    const description = typeof conditionText === 'string' && conditionText.trim()
      ? conditionText.trim()
      : 'ご希望の条件';
    const actions = relaxed.map(condition => RELAXED_CONDITION_ACTIONS[condition]).filter(Boolean);
    messages.push(`${description}で条件に合うお店が見つからなかったため、${actions.join('、')}探したよ🔍`);
  }

  if (searchMeta.provider === 'places') messages.push(adjustmentText.split('\n').slice(-1)[0]);

  return messages.length > 0 ? messages.join('\n') : null;
}

function buildSearchConditionText({ area, genre, budget, lunch } = {}) {
  const genreLabels = {
    '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉',
    '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン・フレンチ', '8': 'カフェ',
  };
  const budgetLabels = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
  return [
    area && `${area}エリア`,
    genre && genreLabels[genre],
    lunch && 'ランチ',
    budget && budgetLabels[budget],
  ].filter(Boolean).join('・');
}

module.exports = { buildRelaxedSearchPreamble, buildSearchAdjustmentText, buildSearchConditionText };
