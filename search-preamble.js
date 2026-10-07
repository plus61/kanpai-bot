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
const BUDGET_LABELS = Object.freeze({
  '1': '〜2,000円',
  '2': '〜4,000円',
  '3': '〜6,000円',
  '4': '〜7,000円',
});

function annotateBudgetAlternative(restaurants, originalBudget, actualBudget, originalLabel) {
  if (!Array.isArray(restaurants) || restaurants.length === 0 || !originalBudget || !actualBudget || String(originalBudget) === String(actualBudget)) {
    return restaurants;
  }

  const budgetWasRemoved = restaurants.some(restaurant =>
    Array.isArray(restaurant?.searchMeta?.relaxed) && restaurant.searchMeta.relaxed.includes('budget')
  );
  const budgetAlternative = {
    kind: budgetWasRemoved ? 'removed' : 'changed',
    originalLabel: originalLabel || (String(originalBudget) === '4' ? '高予算帯' : BUDGET_LABELS[String(originalBudget)]) || null,
    ...(!budgetWasRemoved ? { alternativeLabel: BUDGET_LABELS[String(actualBudget)] || null } : {}),
  };

  return restaurants.map(restaurant => ({
    ...restaurant,
    searchMeta: {
      ...(restaurant?.searchMeta || {}),
      budgetAlternative,
    },
  }));
}

function annotateDroppedKeywords(restaurants, droppedKeywords) {
  if (!Array.isArray(restaurants) || restaurants.length === 0 || !Array.isArray(droppedKeywords)) return restaurants;
  const keywords = [...new Set(droppedKeywords.filter(keyword => typeof keyword === 'string' && keyword.trim()).map(keyword => keyword.trim()))];
  if (keywords.length === 0) return restaurants;

  return restaurants.map(restaurant => ({
    ...restaurant,
    searchMeta: {
      ...(restaurant?.searchMeta || {}),
      droppedKeywords: keywords,
    },
  }));
}

function buildBudgetAlternativeText(searchMeta, conditionText) {
  const alternative = searchMeta?.budgetAlternative;
  if (!alternative) return '';

  const requested = typeof conditionText === 'string' && conditionText.trim()
    ? `${conditionText.trim()}では`
    : alternative.originalLabel
      ? `元の予算条件（${alternative.originalLabel}）では`
      : '元の予算条件では';
  if (alternative.kind === 'removed') {
    return `${requested}見つからなかったため、予算上限を外した候補を出すよ🔍（元の条件とは異なるよ）`;
  }
  if (alternative.alternativeLabel) {
    return `${requested}見つからなかったため、例えば予算${alternative.alternativeLabel}なら候補があるよ🔍（元の条件とは異なるよ）`;
  }
  return `${requested}見つからなかったため、予算帯を変えた別候補を出すよ🔍（元の条件とは異なるよ）`;
}

function buildDroppedKeywordsText(searchMeta, conditionText) {
  const keywords = Array.isArray(searchMeta?.droppedKeywords)
    ? [...new Set(searchMeta.droppedKeywords.filter(keyword => typeof keyword === 'string' && keyword.trim()).map(keyword => keyword.trim()))]
    : [];
  if (keywords.length === 0) return '';

  const original = typeof conditionText === 'string' && conditionText.trim()
    ? `「${conditionText.trim()}」では条件に合うお店が見つからなかったため`
    : '元の条件では見つからなかったため';
  const dietary = keywords.some(keyword => /ベジタリアン|ヴィーガン|菜食|グルテンフリー|アレルギー/.test(keyword));
  const caveat = dietary ? '（食事制約への適合は未確認だよ）' : '（元の条件に合うとは限らないよ）';
  return `${original}、検索キーワード（${keywords.join('・')}）を外した候補を出すよ🔍${caveat}`;
}

function buildSearchAdjustmentText(searchMeta) {
  if (!searchMeta) return '';
  const relaxed = Array.isArray(searchMeta.relaxed) ? searchMeta.relaxed : [];
  const hasBudgetAlternative = Boolean(searchMeta.budgetAlternative);
  const adjustments = relaxed.filter(condition => !(condition === 'budget' && hasBudgetAlternative))
    .map(condition => RELAXED_CONDITION_ACTIONS[condition])
    .filter(Boolean);
  const messages = [];
  if (hasBudgetAlternative) messages.push(buildBudgetAlternativeText(searchMeta));
  const droppedKeywordsText = buildDroppedKeywordsText(searchMeta);
  if (droppedKeywordsText) messages.push(droppedKeywordsText);
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
    const actions = relaxed
      .filter(condition => condition !== 'budget' || !searchMeta.budgetAlternative)
      .map(condition => RELAXED_CONDITION_ACTIONS[condition])
      .filter(Boolean);
    if (actions.length > 0) {
      messages.push(`${description}で条件に合うお店が見つからなかったため、${actions.join('、')}探したよ🔍`);
    }
  }

  if (searchMeta.budgetAlternative) {
    messages.push(buildBudgetAlternativeText(searchMeta, conditionText));
  }

  const droppedKeywordsText = buildDroppedKeywordsText(searchMeta, conditionText);
  if (droppedKeywordsText) messages.push(droppedKeywordsText);

  if (searchMeta.provider === 'places') messages.push(adjustmentText.split('\n').slice(-1)[0]);

  return messages.length > 0 ? messages.join('\n') : null;
}

function buildSearchConditionText({ area, genre, budget, budgetLabel, lunch } = {}) {
  const genreLabels = {
    '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉',
    '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン・フレンチ', '8': 'カフェ',
  };
  const budgetLabels = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };
  return [
    area && `${area}エリア`,
    genre && genreLabels[genre],
    lunch && 'ランチ',
    budgetLabel || (budget && budgetLabels[budget]),
  ].filter(Boolean).join('・');
}

module.exports = {
  annotateDroppedKeywords,
  annotateBudgetAlternative,
  buildDroppedKeywordsText,
  buildBudgetAlternativeText,
  buildRelaxedSearchPreamble,
  buildSearchAdjustmentText,
  buildSearchConditionText,
};
