/**
 * search.js - お店検索エンジン（Hotpepper優先 + Supabaseキャッシュ）
 *
 * コスト構造:
 *   Hotpepper API: 無料（1日1,000件）+ アフィリエイト収益化可
 *   Google Places: フォールバックのみ（月$5以下に抑制）
 *   Supabaseキャッシュ: 24時間保持、同条件は2回目以降$0
 */
require('dotenv').config();
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const { getAdjacentAreas, matchesArea, isLunchCandidate } = require('./search-criteria');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const HOTPEPPER_KEY = process.env.HOTPEPPER_API_KEY;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Search results made with older HotPepper genre codes must not be reused.
const CACHE_KEY_VERSION = 'genre-map-v3';

// ジャンルコード → Hotpepper genre_cd
const HOTPEPPER_GENRE = {
  '1': 'G004',  // 和食
  '2': 'G005',  // 洋食
  '3': 'G007',  // 中華
  '4': 'G008',  // 焼肉・ホルモン
  '5': 'G001',  // 居酒屋（なんでも）
  '6': 'G013',  // ラーメン
  '7': 'G006',  // イタリアン・フレンチ
  '8': 'G014',  // カフェ・スイーツ
};

// 予算 → Hotpepper budget (コード)
// 参考: B004=〜2000, B006=〜4000, B009=〜6000, B010=〜7000
// ※ d* コードは無効（0件になる）→ B* コードを使うこと
const HOTPEPPER_BUDGET = {
  '1': 'B004',  // 〜2,000円
  '2': 'B006',  // 〜4,000円
  '3': 'B009',  // 〜6,000円
  '4': 'B010',  // 〜7,000円（最高額帯）
};

// エリア名 → Hotpepper large_service_area_code / service_area_code
const AREA_CODES = {
  '札幌': 'SA11', '仙台': 'SA12',
  '東京': 'SA12', '新宿': 'SA12', '渋谷': 'SA12', '池袋': 'SA12',
  '六本木': 'SA12', '銀座': 'SA12', '品川': 'SA12', '恵比寿': 'SA12',
  '中目黒': 'SA12', '表参道': 'SA12', '赤坂': 'SA12', '吉祥寺': 'SA12',
  '下北沢': 'SA12', '秋葉原': 'SA12', '中野': 'SA12', '高円寺': 'SA12',
  '三軒茶屋': 'SA12', '二子玉川': 'SA12', '自由が丘': 'SA12',
  '目黒': 'SA12', '五反田': 'SA12', '大崎': 'SA12', '浜松町': 'SA12',
  '新橋': 'SA12', '有楽町': 'SA12', '日比谷': 'SA12', '神田': 'SA12',
  '御茶ノ水': 'SA12', '上野': 'SA12', '浅草': 'SA12', '錦糸町': 'SA12',
  '横浜': 'SA14', '川崎': 'SA14', '武蔵小杉': 'SA14',
  '名古屋': 'SA23',
  '京都': 'SA26', '大阪': 'SA27', '梅田': 'SA27', '難波': 'SA27',
  '心斎橋': 'SA27', '天王寺': 'SA27',
  '神戸': 'SA28',
  '福岡': 'SA40', '博多': 'SA40', '天神': 'SA40',
};

// エリア → keyword (Hotpepperのkeyword検索用)
function getAreaKeyword(area) {
  return area || '東京';
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

/**
 * キャッシュキー生成
 */
function cacheKey(genre, budget, area) {
  return `${CACHE_KEY_VERSION}_${genre || '5'}_${budget || '2'}_${area || 'tokyo'}`.toLowerCase();
}

/**
 * キャッシュから取得
 */
async function getCache(key) {
  try {
    const { data } = await supabase
      .from('restaurant_cache')
      .select('results, expires_at')
      .eq('cache_key', key)
      .gt('expires_at', new Date().toISOString())
      .single();
    if (data) {
      console.log(`[search] cache HIT: ${key}`);
      return data.results;
    }
  } catch (e) { /* miss */ }
  return null;
}

/**
 * キャッシュに保存
 */
async function setCache(key, results, area, genre, budget) {
  try {
    await supabase.from('restaurant_cache').upsert({
      cache_key: key,
      results,
      area,
      genre,
      budget,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'cache_key' });
  } catch (e) {
    console.error('[search] setCache error:', e.message);
  }
}

/**
 * Hotpepper APIでお店検索
 */
async function searchHotpepper(genre, budget, area, limit = 3, options = {}) {
  if (!HOTPEPPER_KEY) return null;

  try {
    const genreCode = genre ? (HOTPEPPER_GENRE[genre] || 'G001') : null;
    const budgetCode = budget ? (HOTPEPPER_BUDGET[budget] || null) : null;

    // キーワードに特殊条件を追加
    const extraKeywords = (options.keywords || []).join(' ');
    const fullKeyword = encodeURIComponent(
      [getAreaKeyword(area), extraKeywords].filter(Boolean).join(' ')
    );

    // ジャンルコードで絞り込み（keywordにジャンル名を混ぜると件数0になりやすい）
    // ※ budget は B* コードで指定すること（d* コードは0件になる）
    const startOffset = options.start || 1;
    let url = `https://webservice.recruit.co.jp/hotpepper/gourmet/v1/` +
      `?key=${HOTPEPPER_KEY}` +
      `&keyword=${fullKeyword}` +
      (genreCode ? `&genre=${genreCode}` : '') +
      (budgetCode ? `&budget=${budgetCode}` : '') +
      `&count=${limit}` +
      `&start=${startOffset}` +
      `&order=4` +
      `&format=json`;
    // ランチ検索オプション
    if (options.lunch) url += '&lunch=1';
    // 大人数対応
    if (options.partyCapacity) url += `&party_capacity=${options.partyCapacity}`;
    // 個室
    if (options.privateRoom) url += '&private_room=1';

    const data = await httpsGet(url);
    const shops = data?.results?.shop;

    if (!shops || shops.length === 0) return null;

    return shops.map(s => ({
      name: s.name,
      genreName: s.genre?.name,
      rating: null,  // Hotpepperは評価なし
      catchCopy: s.catch,
      access: s.mobile_access || s.access,
      budget: s.budget?.average,
      open: s.open,
      smallAreaName: s.small_area?.name,
      middleAreaName: s.middle_area?.name,
      serviceAreaName: s.service_area?.name,
      address: s.address,
      url: s.urls?.pc,
      hotpepperId: s.id,
    }));
  } catch (e) {
    console.error('[search] Hotpepper error:', e.message);
    return null;
  }
}

/**
 * Google Places APIでフォールバック検索
 */
async function searchPlaces(genre, budget, area, limit = 3) {
  if (!PLACES_KEY) return null;

  try {
    const genreWords = {
      '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉',
      '5': '居酒屋', '6': 'ラーメン', '7': 'イタリアン', '8': 'カフェ',
    };
    const keyword = encodeURIComponent(`${area || '東京'} ${genreWords[genre] || '居酒屋'}`);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${keyword}&type=restaurant&language=ja&key=${PLACES_KEY}`;

    const data = await httpsGet(url);
    if (data?.status !== 'OK') return null;

    return (data.results || [])
      .filter(p => (p.rating || 0) >= 3.5)
      .slice(0, limit)
      .map(p => ({
        name: p.name,
        rating: p.rating,
        totalRatings: p.user_ratings_total,
        address: p.formatted_address?.replace('日本、', '').replace(/〒\d{3}-\d{4} /, ''),
        source: 'places',
      }));
  } catch (e) {
    console.error('[search] Places fallback error:', e.message);
    return null;
  }
}

/**
 * メイン検索関数（キャッシュ → Hotpepper → Places の優先順）
 */
async function searchRestaurants(genre, budget, area, limit = 3, options = {}) {
  // Search behavior changed: never reuse results from a previous fallback policy.
  const optKey = [
    options.lunch && 'lunch',
    options.privateRoom && 'private',
    options.partyCapacity && `party-${options.partyCapacity}`,
    options.start && `start-${options.start}`,
    options.genreExplicit === false && 'implicit-genre',
    ...(Array.isArray(options.keywords) ? options.keywords.slice().sort() : []),
  ].filter(Boolean).join('_');
  const key = cacheKey(genre, budget, area) + optKey;

  // 1. キャッシュチェック（空配列[]はキャッシュヒットとみなさない）
  const cached = await getCache(key);
  if (cached && cached.length > 0) return cached;

  const requestedArea = typeof area === 'string' && area.trim() ? area.trim() : null;
  const genreExplicit = options.genreExplicit ?? Boolean(genre);
  const requestedLunch = Boolean(options.lunch);
  const neighbors = requestedArea ? getAdjacentAreas(requestedArea) : [];
  const exactScopes = [{ queryArea: requestedArea, matchArea: requestedArea, adjacent: false }];
  const adjacentScopes = neighbors.map(neighbor => ({ queryArea: neighbor, matchArea: neighbor, adjacent: true }));
  const genreLastScopes = requestedArea ? [...exactScopes, ...adjacentScopes] : exactScopes;
  const baseOptions = { ...options };
  delete baseOptions.genreExplicit;
  const requestCount = Math.min(100, Math.max(20, limit * 6));

  // Build cumulative fallbacks in the issue's order. Each step changes one
  // additional condition: budget, lunch, adjacent areas, then genre.
  const stages = [{ genre, budget, lunch: requestedLunch, scopes: exactScopes, relaxed: [] }];
  const relaxed = [];
  if (budget) {
    relaxed.push('budget');
    stages.push({ genre, budget: null, lunch: requestedLunch, scopes: exactScopes, relaxed: relaxed.slice() });
  }
  if (requestedLunch) {
    relaxed.push('lunch');
    stages.push({ genre, budget: null, lunch: false, scopes: exactScopes, relaxed: relaxed.slice() });
  }
  if (adjacentScopes.length > 0) {
    relaxed.push('area');
    stages.push({ genre, budget: null, lunch: false, scopes: adjacentScopes, relaxed: relaxed.slice() });
  }
  if (genre) {
    const genreRelaxed = genreExplicit ? relaxed.concat('genre') : relaxed.slice();
    stages.push({ genre: null, budget: null, lunch: false, scopes: genreLastScopes, relaxed: genreRelaxed });
  }

  let results = [];
  for (const stage of stages) {
    const stageResults = [];
    for (const scope of stage.scopes) {
      const stageOptions = { ...baseOptions };
      if (stage.lunch) stageOptions.lunch = true;
      else delete stageOptions.lunch;
      const found = await searchHotpepper(stage.genre, stage.budget, scope.queryArea, requestCount, stageOptions);
      for (const shop of found || []) {
        if (scope.matchArea && !matchesArea(shop, scope.matchArea)) continue;
        if (stage.lunch && !isLunchCandidate(shop.open)) continue;
        const keyPart = shop.hotpepperId || shop.name;
        if (stageResults.some(existing => (existing.hotpepperId || existing.name) === keyPart)) continue;
        const shopRelaxed = scope.adjacent
          ? [...new Set([...stage.relaxed, 'area'])]
          : stage.relaxed.filter(condition => condition !== 'area');
        stageResults.push({
          ...shop,
          searchMeta: {
            provider: 'hotpepper',
            relaxed: shopRelaxed,
            requestedArea,
            matchedArea: scope.matchArea,
          },
        });
        if (stageResults.length >= limit) break;
      }
      if (stageResults.length >= limit) break;
    }
    if (stageResults.length > 0) {
      // A final result set can mix the requested area with adjacent areas.
      // Give every result the union so callers inspecting the first shop still
      // disclose every relaxation used to build the response.
      const usedRelaxations = new Set(stageResults.flatMap(shop => shop.searchMeta?.relaxed || []));
      const relaxationOrder = ['budget', 'lunch', 'area', 'genre'];
      const responseRelaxations = relaxationOrder.filter(condition => usedRelaxations.has(condition));
      results = stageResults.slice(0, limit).map(shop => ({
        ...shop,
        searchMeta: shop.searchMeta
          ? { ...shop.searchMeta, relaxed: responseRelaxations }
          : shop.searchMeta,
      }));
      break;
    }
  }

  // 4. HotPepper miss: Places uses a free-text query, so keep its weaker
  // guarantees visible in the response metadata and validate the returned area.
  if (results.length === 0) {
    console.log('[search] Hotpepper miss, falling back to Places');
    const places = await searchPlaces(genre, budget, area, requestCount);
    const matchingPlaces = (places || []).filter(shop => !requestedArea || matchesArea(shop, requestedArea));
    const placesRelaxed = [];
    if (budget) placesRelaxed.push('budget');
    if (requestedLunch) placesRelaxed.push('lunch');
    if (genreExplicit) placesRelaxed.push('genre');
    results = matchingPlaces.slice(0, limit).map(shop => ({
      ...shop,
      searchMeta: {
        provider: 'places',
        relaxed: placesRelaxed,
        requestedArea,
        areaVerification: requestedArea ? 'address-match' : 'unspecified',
      },
    }));
  }

  // 5. キャッシュ保存（24時間）
  if (results && results.length > 0) {
    await setCache(key, results, area, genre, budget);
  }

  return results || [];
}

/**
 * 検索結果をLINEメッセージにフォーマット
 */
function formatRestaurants(restaurants, genre, budget, area) {
  const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': 'なんでも' };
  const budgetMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };

  if (!restaurants || restaurants.length === 0) return null;

  const areaText = area ? `${area}周辺` : '周辺';
  const lines = [`🔍 ${areaText}の${genreMap[genre] || 'お店'}（${budgetMap[budget] || ''}）`, ''];

  restaurants.forEach((r, i) => {
    lines.push(`${['1️⃣','2️⃣','3️⃣'][i] || `${i+1}.`} ${r.name}`);

    if (r.catchCopy) lines.push(`   ${r.catchCopy}`);
    if (r.rating) lines.push(`   ⭐ ${r.rating} (${r.totalRatings}件)`);
    if (r.budget) lines.push(`   💰 ${r.budget}`);
    if (r.access) lines.push(`   📍 ${r.access}`);
    if (r.open) lines.push(`   🕐 ${r.open.replace(/\n/g, ' ').substring(0, 30)}`);
    lines.push('');
  });

  lines.push('どれにする？🍻');
  return lines.join('\n');
}

/**
 * 会話からエリアを推定（直近メッセージ優先）
 * 最新メッセージから順に確認し、最も新しいエリア指定を返す
 */
function extractArea(messages) {
  const areas = Object.keys(AREA_CODES);
  // 直近から順にチェック（文脈引き継ぎの正確性向上）
  const orderedMessages = messages.slice(-10).reverse();
  for (const msg of orderedMessages) {
    const found = areas.find(a => msg.message.includes(a));
    if (found) return found;
  }
  return null;
}

/**
 * テキストから予算コードを推定
 * 「3000円以内」「〜4000円」などをHotpepperコードに変換
 */
function extractBudget(text) {
  // 万円パターンを先にチェック（1万、2万、1.5万 等）
  const manMatch = text.match(/([\d.]+)万円?/);
  if (manMatch) {
    const amount = parseFloat(manMatch[1]) * 10000;
    if (!isNaN(amount)) {
      if (amount <= 2000) return '1';
      if (amount <= 4000) return '2';
      if (amount <= 6000) return '3';
      return '4';
    }
  }
  // 数値＋円パターンを抽出
  const match = text.match(/([\d,]+)円/);
  if (!match) return null;
  const amount = parseInt(match[1].replace(/,/g, ''));
  if (isNaN(amount)) return null;
  if (amount <= 2000) return '1';  // ~2,000円
  if (amount <= 4000) return '2';  // ~4,000円（3,000円も含む）
  if (amount <= 6000) return '3';  // ~6,000円
  return '4';                       // 6,000円~
}

/**
 * テキストから検索オプションを抽出（ランチ・個室・大人数・デート・ベジタリアン等）
 */
function extractSearchOptions(text) {
  const options = {};

  // ランチ: キーワード or 時間帯（11:00〜14:00）
  if (/ランチ|昼ごはん|昼飯|お昼|昼食/.test(text)) options.lunch = true;
  const timeMatch = text.match(/(\d{1,2})時/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    if (hour >= 11 && hour <= 14) options.lunch = true;
  }

  // 個室: 直接指定 or デート系
  if (/個室|プライベート/.test(text)) options.privateRoom = true;
  if (/デート|カップル|2人で|二人で|記念日|誕生日|いい感じ/.test(text)) options.privateRoom = true;
  // 接待: 個室+静か系キーワード
  if (/接待|ビジネス|ちゃんとした|しっかりした/.test(text)) options.privateRoom = true;

  // 大人数: N人以上 or N人で（10人以上）
  const partyMatch = text.match(/(\d+)人(以上|で入|で食|くらい)?|(\d+)名(以上)?/);
  if (partyMatch) {
    const n = parseInt(partyMatch[1] || partyMatch[3]);
    if (n >= 10) options.partyCapacity = n;
  }
  if (/大人数|大勢|大きい(店|お店)|広い(店|お店)/.test(text)) options.partyCapacity = 10;

  // キーワード検索用（HotPepper keyword に追加する特殊条件）
  const keywords = [];
  if (/ベジタリアン|ヴィーガン|菜食|野菜/.test(text)) keywords.push('ベジタリアン');
  if (/グルテンフリー/.test(text)) keywords.push('グルテンフリー');
  if (/チェーン(店)?じゃない|個人店|こだわり/.test(text)) keywords.push('こだわり');
  if (/おしゃれ|雰囲気|いい感じ/.test(text)) keywords.push('おしゃれ');
  if (keywords.length > 0) options.keywords = keywords;

  return options;
}

module.exports = {
  searchRestaurants,
  formatRestaurants,
  extractArea,
  extractBudget,
  extractSearchOptions,
};
