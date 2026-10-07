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

// Address-only HotPepper records need a few explicit neighborhood aliases:
// the ward name itself must not make every address in that ward an exact hit.
const ADDRESS_NEIGHBORHOODS = Object.freeze({
  '渋谷': Object.freeze({ ward: '渋谷区', names: ['道玄坂', '宇田川町'] }),
  '新宿': Object.freeze({ ward: '新宿区', names: ['歌舞伎町'] }),
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

function matchesAreaToken(value, area) {
  const name = value.normalize('NFKC').replace(/[\s　]/g, '');
  const target = area.normalize('NFKC').replace(/[\s　]/g, '');
  if (!name || !target) return false;

  let index = name.indexOf(target);
  while (index !== -1) {
    const next = name[index + target.length];
    // A ward name is not evidence that a shop is in the neighborhood sharing
    // that name: 恵比寿 is in 渋谷区, but is not the 渋谷 neighborhood.
    if (next !== '区' || target.endsWith('区')) return true;
    index = name.indexOf(target, index + target.length);
  }
  return false;
}

function matchesAddressArea(address, area) {
  if (matchesAreaToken(address, area)) return true;

  const neighborhoodRule = ADDRESS_NEIGHBORHOODS[area];
  if (!neighborhoodRule) return false;

  const normalizedAddress = address.normalize('NFKC').replace(/[\s　]/g, '');
  const wardIndex = normalizedAddress.indexOf(neighborhoodRule.ward);
  if (wardIndex === -1) return false;

  const neighborhoodStart = wardIndex + neighborhoodRule.ward.length;
  return neighborhoodRule.names.some(name => normalizedAddress.indexOf(name, neighborhoodStart) !== -1);
}

function matchesArea(shop, area) {
  if (!area) return true;

  // Use the most specific structured area available. Falling through to a
  // broader ward/city or the address after a mismatch reintroduces false hits.
  const specificArea = [
    shop?.smallAreaName,
    shop?.small_area?.name,
    shop?.areaName,
    ...(Array.isArray(shop?.areaNames) ? shop.areaNames : []),
    shop?.middleAreaName,
    shop?.middle_area?.name,
    shop?.serviceAreaName,
    shop?.service_area?.name,
  ].find(value => typeof value === 'string' && value.trim());

  if (specificArea) return matchesAreaToken(specificArea, area);
  return typeof shop?.address === 'string' && matchesAddressArea(shop.address, area);
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
