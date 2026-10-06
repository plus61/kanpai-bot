'use strict';

// Only neighborhoods with an explicit, conservative adjacency list may be used
// for the area-relaxation step. Unknown areas never broaden automatically.
const ADJACENT_AREAS = Object.freeze({
  '渋谷': ['恵比寿', '表参道', '代官山'],
  '恵比寿': ['渋谷', '代官山', '中目黒'],
  '表参道': ['渋谷', '原宿'],
  '原宿': ['表参道', '渋谷'],
  '新宿': ['代々木', '新大久保'],
  '銀座': ['有楽町', '新橋', '築地'],
  '有楽町': ['銀座', '新橋'],
  '新橋': ['銀座', '有楽町'],
  '梅田': ['北新地', '中崎町'],
  '難波': ['心斎橋', '日本橋'],
});

function getAdjacentAreas(area) {
  return ADJACENT_AREAS[String(area || '').trim()] || [];
}

function areaNamesFor(shop) {
  const names = [
    shop?.smallAreaName,
    shop?.middleAreaName,
    shop?.serviceAreaName,
    shop?.areaName,
    ...(Array.isArray(shop?.areaNames) ? shop.areaNames : []),
    shop?.address,
  ];
  return names.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
}

function matchesArea(shop, area) {
  if (!area) return true;
  return areaNamesFor(shop).some(name => name.includes(area));
}

function isLunchCandidate(openHours) {
  if (typeof openHours !== 'string' || !openHours.trim()) return false;

  // Remove parenthetical last-order notes before reading opening ranges.
  const schedule = openHours.replace(/（[^）]*）|\([^)]*\)/g, ' ');
  const starts = [...schedule.matchAll(/(?:^|[^\d])(\d{1,2}):([0-5]\d)\s*[〜～~\-−]/g)];
  if (starts.length === 0) return false;

  // A shop qualifies when at least one advertised opening period starts before
  // 14:00. Unknown hours are not evidence that it serves lunch.
  return starts.some(([, hour, minute]) => Number(hour) * 60 + Number(minute) < 14 * 60);
}

module.exports = { ADJACENT_AREAS, getAdjacentAreas, areaNamesFor, matchesArea, isLunchCandidate };
