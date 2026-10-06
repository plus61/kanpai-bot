/**
 * flex.js - LINE Flex Message ビルダー
 * お店情報をカルーセル形式で表示する
 */
const { buildSearchAdjustmentText } = require('./search-preamble');

/**
 * 予算コード → 表示文字列
 */
const BUDGET_LABEL = {
  '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜'
};

// ジャンル別アクセントカラー
const GENRE_COLOR = {
  '1': '#E8A87C', // 和食 → 温かみのある橙
  '2': '#6C8EBF', // 洋食 → 落ち着いたブルー
  '3': '#D4AC0D', // 中華 → 金
  '4': '#922B21', // 焼肉 → 深い赤
  '5': '#1A5276', // 居酒屋 → 深い紺
  '6': '#C0392B', // ラーメン → 情熱的な赤
  '7': '#2E86C1', // イタリアン → ブルー
  '8': '#7D6544', // カフェ → ブラウン
};

/**
 * 食べログアフィリエイトURL（ValueCommerce MyLink）を生成
 * sid=3765360, pid=892584846 は固定（ValueCommerceのアカウント情報）
 */
function getTabelogAffiliateUrl(shopName, area) {
  const keyword = encodeURIComponent(shopName || '');
  const sa = encodeURIComponent(area || '');
  const tabelogSearchUrl = `https://tabelog.com/rstLst/?vs=1&sa=${sa}&keyword=${keyword}`;
  return `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=3765360&pid=892584846&vc_url=${encodeURIComponent(tabelogSearchUrl)}`;
}

const BASE_URL = process.env.BASE_URL || 'https://kanpai-bot.vercel.app';

/**
 * タップ計測付きリダイレクトURLを生成
 */
function trackUrl(type, shop, groupId, genre, budget, area) {
  const params = new URLSearchParams({
    type,
    shop_id: shop.hotpepperId || '',
    shop_name: shop.name || '',
    group_id: groupId || '',
    genre: genre || '',
    budget: budget || '',
    area: area || '',
    redirect: shop.url || '',
  });
  return `${BASE_URL}/track?${params.toString()}`;
}

/**
 * 1店舗のバブル（カード）を生成
 */
function buildShopBubble(shop, index, genre, groupId, budget, area) {
  const accentColor = GENRE_COLOR[genre] || '#5D6D7E';
  const rankEmoji = ['🥇', '🥈', '🥉'][index] || `${index + 1}.`;

  // 営業時間を短縮（30文字以内）
  const openText = shop.open
    ? shop.open.replace(/\n/g, ' ').replace(/（.*?）/g, '').trim().substring(0, 35)
    : null;

  // アクセス情報を短縮
  const accessText = (shop.access || shop.address || '')
    .replace(/[　 ]+/g, ' ').trim().substring(0, 30);

  const body = {
    type: 'box',
    layout: 'vertical',
    contents: [
      // ランクバッジ
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: rankEmoji,
            size: 'lg',
            flex: 0,
          },
          {
            type: 'text',
            text: shop.name,
            weight: 'bold',
            size: 'md',
            wrap: true,
            flex: 1,
            margin: 'sm',
            color: '#1A1A1A',
          },
        ],
        alignItems: 'center',
      },
      // キャッチコピー
      ...(shop.catchCopy ? [{
        type: 'text',
        text: shop.catchCopy.substring(0, 40),
        size: 'xs',
        color: '#666666',
        wrap: true,
        margin: 'sm',
      }] : []),
      // 評価（Placesデータの場合）
      ...(shop.rating ? [{
        type: 'box',
        layout: 'horizontal',
        margin: 'sm',
        contents: [
          { type: 'text', text: '⭐', size: 'xs', flex: 0 },
          { type: 'text', text: `${shop.rating} (${shop.totalRatings}件)`, size: 'xs', color: '#888888', margin: 'xs' },
        ],
      }] : []),
      { type: 'separator', margin: 'md', color: '#EEEEEE' },
      // 詳細情報
      {
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        spacing: 'sm',
        contents: [
          ...(shop.budget ? [{
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '💰', size: 'xs', flex: 0 },
              { type: 'text', text: shop.budget.substring(0, 25), size: 'xs', color: '#444444', margin: 'xs', flex: 1, wrap: true },
            ],
          }] : []),
          ...(accessText ? [{
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '📍', size: 'xs', flex: 0 },
              { type: 'text', text: accessText, size: 'xs', color: '#444444', margin: 'xs', flex: 1, wrap: true },
            ],
          }] : []),
          ...(openText ? [{
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '🕐', size: 'xs', flex: 0 },
              { type: 'text', text: openText, size: 'xs', color: '#444444', margin: 'xs', flex: 1, wrap: true },
            ],
          }] : []),
        ],
      },
    ],
    paddingAll: '16px',
  };

  const walkinUrl = shop.url ? trackUrl('walkin', shop, groupId, genre, budget, area) : null;
  const reserveUrl = shop.url ? trackUrl('reserve', shop, groupId, genre, budget, area) : null;

  const footer = {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      // 席押さえボタン（walk-in）
      {
        type: 'button',
        action: walkinUrl
          ? { type: 'uri', label: '🏃 今すぐ席を押さえる', uri: walkinUrl }
          : { type: 'message', label: '🏃 席を押さえる', text: `${shop.name}の席を押さえたい！` },
        style: 'primary',
        color: accentColor,
        height: 'sm',
      },
      // コース予約ボタン（アフィリエイト）
      {
        type: 'button',
        action: reserveUrl
          ? { type: 'uri', label: '📋 コース予約はこちら', uri: reserveUrl }
          : { type: 'message', label: '📋 コース予約', text: `${shop.name}でコース予約したい！` },
        style: 'secondary',
        height: 'sm',
      },
      // 食べログ検索ボタン（ValueCommerceアフィリエイト）
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        margin: 'xs',
        action: {
          type: 'uri',
          label: '🍽 食べログで予約する',
          uri: getTabelogAffiliateUrl(shop.name, area),
        },
      },
    ],
    paddingAll: '12px',
    backgroundColor: '#F8F8F8',
  };

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: typeof shop.genreName === 'string' && shop.genreName.trim()
            ? shop.genreName.trim() : 'お店',
          wrap: true,
          size: 'xxs',
          color: '#FFFFFF',
          align: 'center',
        },
      ],
      backgroundColor: accentColor,
      paddingAll: '6px',
    },
    body,
    footer,
    styles: {
      body: { backgroundColor: '#FFFFFF' },
    },
  };
}

/**
 * カルーセル形式のFlex Messageを生成
 */
function buildRestaurantCarousel(restaurants, genre, budget, area, groupId = '', options = {}) {
  if (!restaurants || restaurants.length === 0) return null;

  const searchMeta = restaurants[0]?.searchMeta;
  const relaxed = new Set(Array.isArray(searchMeta?.relaxed) ? searchMeta.relaxed : []);
  const areaText = area ? (relaxed.has('area') ? `${area}近隣` : `${area}周辺`) : '周辺';
  // 要約も表示対象の店舗データから作る。混在・欠損は中立表示にする。
  const genreNames = restaurants.slice(0, 3).map(shop =>
    typeof shop.genreName === 'string' ? shop.genreName.trim() : ''
  );
  const genreText = genreNames[0] && genreNames.every(name => name === genreNames[0])
    ? genreNames[0] : 'お店';
  // S04: ユーザーが明示した予算があればそれを表示（例: "3,000円以内"）
  const budgetText = relaxed.has('budget') ? '予算条件を緩和' : (options.budgetLabel || BUDGET_LABEL[budget] || '');
  const mealTypeText = options.lunch && !relaxed.has('lunch') ? 'ランチ' : genreText;

  const bubbles = restaurants.slice(0, 3).map((shop, i) =>
    buildShopBubble(shop, i, genre, groupId, budget, area)
  );

  // altTextに店名を含めて応答の具体性を高める
  const shopNames = restaurants.slice(0, 3).map(s => s.name).join('、');
  const prefixes = [options.prefix, buildSearchAdjustmentText(searchMeta)].filter(Boolean);
  const prefix = prefixes.length > 0 ? `${prefixes.join('\n')}\n` : '';
  return {
    type: 'flex',
    altText: `${prefix}${areaText}の${mealTypeText}（${budgetText}）を${restaurants.length}件見つけたよ🍻\n${shopNames}\n詳細はカードをチェック！`,
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };
}

/**
 * シンプルな確認バブル（DM集計後に送るやつ）
 */
function buildSummaryBubble(summary) {
  return {
    type: 'flex',
    altText: summary,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📊 みんなの本音', weight: 'bold', size: 'md', color: '#1A5276' },
          { type: 'separator', margin: 'md' },
          ...summary.split('\n').filter(l => l.trim()).map(line => ({
            type: 'text',
            text: line,
            size: 'sm',
            margin: 'sm',
            wrap: true,
            color: line.startsWith('💰') || line.startsWith('🍽') ? '#1A1A1A' : '#666666',
          })),
        ],
        paddingAll: '16px',
      },
    },
  };
}

module.exports = {
  buildRestaurantCarousel,
  buildShopBubble,
  buildSummaryBubble,
  getTabelogAffiliateUrl,
};
