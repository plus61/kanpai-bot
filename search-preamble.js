'use strict';

const RELAXED_CONDITION_LABELS = Object.freeze({
  budget: '予算条件',
  lunch: 'ランチ条件',
  genre: 'ジャンル条件',
});

function buildRelaxedSearchPreamble(conditionText, searchMeta) {
  if (!searchMeta) return null;

  const relaxed = Array.isArray(searchMeta.relaxed) ? searchMeta.relaxed : [];
  const labels = relaxed
    .map(condition => RELAXED_CONDITION_LABELS[condition])
    .filter(Boolean);
  const messages = [];

  if (labels.length > 0) {
    const description = typeof conditionText === 'string' && conditionText.trim()
      ? conditionText.trim()
      : 'ご希望の条件';
    messages.push(`${description}で条件に合うお店が見つからなかったため、${labels.join('・')}を外して探したよ🔍`);
  }

  if (searchMeta.provider === 'places') {
    messages.push('HotPepperで見つからず、Google Placesでも探したよ🗺️');
  }

  return messages.length > 0 ? messages.join('\n') : null;
}

module.exports = { buildRelaxedSearchPreamble };
