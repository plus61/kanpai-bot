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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const HOTPEPPER_KEY = process.env.HOTPEPPER_API_KEY;
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ジャンルコード → Hotpepper genre_cd
const HOTPEPPER_GENRE = {
  '1': 'G004',  // 和食
  '2': 'G005',  // 洋食
  '3': 'G013',  // ラーメン（G007=中華より精度高）
  '4': 'G008',  // 焼肉・ホルモン
  '5': 'G001',  // 居酒屋（なんでも）
};

// 予算 → Hotpepper budget_dinner (コード)
// 参考: d002=〜1000, d003=〜2000, d005=〜3000, d006=〜4000, d007=〜5000, d008=〜6000, d009=〜7000
const HOTPEPPER_BUDGET = {
  '1': 'd003',  // 〜2,000円
  '2': 'd006',  // 〜4,000円
  '3': 'd008',  // 〜6,000円
  '4': 'd010',  // 6,000円〜
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
  return `${genre || '5'}_${budget || '2'}_${area || 'tokyo'}`.toLowerCase();
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
async function searchHotpepper(genre, budget, area, limit = 3) {
  if (!HOTPEPPER_KEY) return null;

  try {
    const genreCode = HOTPEPPER_GENRE[genre] || 'G001';
    const budgetCode = HOTPEPPER_BUDGET[budget] || 'd006';
    const keyword = encodeURIComponent(getAreaKeyword(area));

    // ジャンルコードで絞り込み（keywordにジャンル名を混ぜると件数0になりやすい）
    const url = `https://webservice.recruit.co.jp/hotpepper/gourmet/v1/` +
      `?key=${HOTPEPPER_KEY}` +
      `&keyword=${keyword}` +
      `&genre=${genreCode}` +
      `&count=${limit}` +
      `&order=4` +
      `&format=json`;

    const data = await httpsGet(url);
    const shops = data?.results?.shop;

    if (!shops || shops.length === 0) return null;

    return shops.map(s => ({
      name: s.name,
      rating: null,  // Hotpepperは評価なし
      catchCopy: s.catch,
      access: s.mobile_access || s.access,
      budget: s.budget?.average,
      open: s.open,
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
    const genreWords = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': '居酒屋' };
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
async function searchRestaurants(genre, budget, area, limit = 3) {
  const key = cacheKey(genre, budget, area);

  // 1. キャッシュチェック
  const cached = await getCache(key);
  if (cached) return cached;

  // 2. Hotpepper（無料・日本特化）
  let results = await searchHotpepper(genre, budget, area, limit);

  // 3. Hotpepper失敗時はPlacesにフォールバック
  if (!results || results.length === 0) {
    console.log('[search] Hotpepper miss, falling back to Places');
    results = await searchPlaces(genre, budget, area, limit);
  }

  // 4. キャッシュ保存（24時間）
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
 * 会話からエリアを推定
 */
function extractArea(messages) {
  const areas = Object.keys(AREA_CODES);
  const recentText = messages.slice(-10).map(m => m.message).join(' ');
  return areas.find(a => recentText.includes(a)) || null;
}

module.exports = {
  searchRestaurants,
  formatRestaurants,
  extractArea,
};
