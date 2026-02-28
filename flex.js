/**
 * flex.js - LINE Flex Message ビルダー
 * お店情報をカルーセル形式で表示する
 */

/**
 * 予算コード → 表示文字列
 */
const BUDGET_LABEL = {
  '1': '〜2,000円', '2': '〜4,000円', '3': '〜6,000円', '4': '6,000円〜'
};
const GENRE_LABEL = {
  '1': '和食', '2': '洋食', '3': 'ラーメン', '4': '焼肉', '5': '居酒屋'
};

// ジャンル別アクセントカラー
const GENRE_COLOR = {
  '1': '#E8A87C', // 和食 → 温かみのある橙
  '2': '#6C8EBF', // 洋食 → 落ち着いたブルー
  '3': '#C0392B', // ラーメン → 情熱的な赤
  '4': '#922B21', // 焼肉 → 深い赤
  '5': '#1A5276', // 居酒屋 → 深い紺
};

/**
 * 1店舗のバブル（カード）を生成
 */
function buildShopBubble(shop, index, genre) {
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

  const footer = {
    type: 'box',
    layout: 'vertical',
    contents: [
      {
        type: 'button',
        action: {
          type: shop.url ? 'uri' : 'message',
          label: shop.url ? 'ホットペッパーで見る 🔗' : 'これにする！🍻',
          uri: shop.url || undefined,
          text: shop.url ? undefined : `${shop.name}にする！`,
        },
        style: 'primary',
        color: accentColor,
        height: 'sm',
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
          text: GENRE_LABEL[genre] || 'お店',
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
function buildRestaurantCarousel(restaurants, genre, budget, area) {
  if (!restaurants || restaurants.length === 0) return null;

  const areaText = area ? `${area}周辺` : '周辺';
  const genreText = GENRE_LABEL[genre] || 'お店';
  const budgetText = BUDGET_LABEL[budget] || '';

  const bubbles = restaurants.slice(0, 3).map((shop, i) =>
    buildShopBubble(shop, i, genre)
  );

  return {
    type: 'flex',
    altText: `${areaText}の${genreText}（${budgetText}）を${restaurants.length}件見つけたよ🍻`,
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
};
