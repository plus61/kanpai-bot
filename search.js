/**
 * search.js - Google Places APIでお店検索
 * 予算・ジャンル・エリアから実際のお店を取得する
 */
require('dotenv').config();
const https = require('https');

const PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ジャンルコード → 検索キーワード
const GENRE_KEYWORDS = {
  '1': '和食 居酒屋',
  '2': 'イタリアン フレンチ 洋食',
  '3': '中華',
  '4': '焼肉 焼き鳥',
  '5': '居酒屋',
};

// 予算 → 価格レベル（Google Places: 1〜4）
const BUDGET_LEVEL = {
  '1': '1',   // 〜2000円
  '2': '2',   // 〜4000円
  '3': '3',   // 〜6000円
  '4': '4',   // 6000円〜
};

/**
 * HTTPSリクエストのユーティリティ
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

/**
 * テキストからエリアを推定（簡易版）
 */
function extractArea(messages) {
  const areaKeywords = [
    '渋谷', '新宿', '六本木', '銀座', '池袋', '品川', '秋葉原',
    '恵比寿', '中目黒', '表参道', '赤坂', '虎ノ門', '浜松町',
    '梅田', '難波', '心斎橋', '天王寺', '神戸', '京都', '名古屋',
    '博多', '天神', '横浜', '川崎', '吉祥寺', '下北沢',
  ];

  const recentText = messages.slice(-10).map(m => m.message).join(' ');
  for (const area of areaKeywords) {
    if (recentText.includes(area)) return area;
  }
  return null; // エリア不明
}

/**
 * Google Places APIでお店を検索
 * @param {string} genre - ジャンルコード (1-5)
 * @param {string} budget - 予算コード (1-4)
 * @param {string} area - エリア名（例: "渋谷"）
 * @param {number} limit - 件数
 */
async function searchRestaurants(genre, budget, area, limit = 3) {
  if (!PLACES_API_KEY) {
    console.log('[search] No Google Places API key');
    return [];
  }

  try {
    const keyword = GENRE_KEYWORDS[genre] || '居酒屋';
    const priceLevel = BUDGET_LEVEL[budget] || '2';
    const location = area ? `${area} ` : '東京 ';
    const query = encodeURIComponent(`${location}${keyword}`);

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${query}` +
      `&type=restaurant` +
      `&language=ja` +
      `&key=${PLACES_API_KEY}`;

    const data = await httpsGet(url);

    if (!data || data.status !== 'OK') {
      console.log('[search] Places API error:', data?.status);
      return [];
    }

    // 価格レベルでフィルタリング（±1の範囲）
    const targetLevel = parseInt(priceLevel);
    const filtered = (data.results || [])
      .filter(place => {
        if (!place.price_level) return true; // 不明は含める
        return Math.abs(place.price_level - targetLevel) <= 1;
      })
      .filter(place => place.rating >= 3.5) // 評価3.5以上
      .slice(0, limit);

    return filtered.map(place => ({
      name: place.name,
      rating: place.rating,
      totalRatings: place.user_ratings_total,
      priceLevel: place.price_level,
      address: place.formatted_address?.replace('日本、', '').replace(/〒\d{3}-\d{4} /, ''),
      placeId: place.place_id,
    }));
  } catch (e) {
    console.error('[search] searchRestaurants error:', e.message);
    return [];
  }
}

/**
 * 検索結果をLINEメッセージにフォーマット
 */
function formatRestaurants(restaurants, genre, budget, area) {
  const genreMap = { '1': '和食', '2': '洋食', '3': '中華', '4': '焼肉', '5': 'なんでも' };
  const budgetMap = { '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜' };

  if (restaurants.length === 0) {
    return null; // フォールバック用
  }

  const areaText = area ? `${area}周辺` : '近く';
  const lines = [
    `🔍 ${areaText}の${genreMap[genre] || ''}（${budgetMap[budget] || ''}）`,
    '',
  ];

  restaurants.forEach((r, i) => {
    const stars = '⭐'.repeat(Math.round(r.rating || 0));
    const priceStr = r.priceLevel ? '¥'.repeat(r.priceLevel) : '';
    lines.push(`${i + 1}️⃣ ${r.name}`);
    lines.push(`   ${stars} ${r.rating || '?'} (${r.totalRatings || 0}件) ${priceStr}`);
    if (r.address) {
      const shortAddr = r.address.split('、').slice(-2).join('、');
      lines.push(`   📍 ${shortAddr}`);
    }
    lines.push('');
  });

  lines.push('どれにする？🍻');
  return lines.join('\n');
}

module.exports = {
  searchRestaurants,
  formatRestaurants,
  extractArea,
};
