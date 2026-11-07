/*
 * sites.js — 站点适配层（单一配置来源）
 *
 * 每个站点只填一份「怎么找到内容 / 哪些图算内容图 / 图床怎么防盗链 /
 * 文字怎么清洗 / 水印怎么处理」。content.js 里不再写死微博，
 * 通用内核（按钮注入、指纹防错、去水印、剪贴板、多图托盘、打开 X）全部复用。
 *
 * 新增站点：在下面加一个 profile，并在 manifest.json 里补
 * content_scripts.matches / host_permissions / web_accessible_resources.matches，
 * 再到 background.js 的 SITE_REFERER_RULES 补图床 Referer 即可。
 *
 * 注意：选择器按各站公开 DOM 结构写，站点改版时优先靠 findTextNode() 的
 * 通用启发式兜底（遍历 div/p/span 打分），不必马上改这里。
 */
'use strict';

var SITE_PROFILES = {
  weibo: {
    id: 'weibo',
    label: '微博',
    hosts: ['weibo.com', 'weibo.cn', 'm.weibo.cn'],
    cardSelectors: [
      'article',
      'div[action-type="feed_list_item"]',
      'div.card-wrap',
      'div.WB_cardwrap'
    ],
    textSelectors: [
      '[node-type="feed_list_content"]', '.WB_text', '.weibo-text',
      '[data-text]', '.detail_text', '.woo-text'
    ],
    mediaSelectors: [
      '[node-type="feed_list_media"]', '.WB_media_wrap', '.woo-picture-main',
      '[class*="picture"]', '[class*="video"]', '[class*="media"]'
    ],
    imageHosts: [/sinaimg\.cn/i],
    avatarHosts: [/(?:^|\/\/)(?:tvax|tva)\d*\.sinaimg\.cn/i, /\/crop\.|\/avatar\//i],
    imageHostPattern: 'sinaimg\\.cn',
    imageAttrs: ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-original-src'],
    contentSize: /\/(?:large|mw2000|mw1024|mw2048|mw690|orj1080|orj480|orj360|bmiddle|woriginal|original|thumb150|thumb300|small|middle|square|thumbnail)\//i,
    sizeUpgrade: { hostPattern: 'sinaimg\\.cn/', tokens: ['thumb150', 'thumb300', 'square', 'thumbnail', 'bmiddle', 'mw690', 'mw1024', 'mw2048', 'orj360', 'orj480', 'small', 'middle'], target: 'large' },
    embeddedTokens: 'large|mw2000|mw2048|mw1024|mw690|orj1080|orj480|bmiddle|woriginal|original',
    allowGenericImages: false,
    referer: 'https://weibo.com/',
    refererHosts: ['sinaimg.cn', 'weibocdn.com'],
    hashDefault: 'truncate',
    watermark: 'detect',
    videoApi: 'weibo',
    permalink: 'weibo',
    // 必须与改造前 content.js 的 META_WORD 完全一致（含 g 标志）：
    // isMetaText() 用 String.match(...).length 统计命中次数来判定作者信息块
    metaWords: /(?:博主|超话|创作官|主持人|认证|视频号|达人|会员)/g,
  },

  zhihu: {
    id: 'zhihu',
    label: '知乎',
    hosts: ['zhihu.com', 'zhuanlan.zhihu.com', 'daily.zhihu.com'],
    cardSelectors: [
      'article', '.ContentItem', '.AnswerItem', '.PinItem', '.Post-Main',
      '.Question-mainColumn', '.RichContent', '.Card'
    ],
    textSelectors: [
      '.RichText', '.ztext', '.CopyrightRichText-richText', '.Post-RichText',
      '[itemprop="text"]', '.RichContent-inner', '.ContentItem-title'
    ],
    mediaSelectors: [
      'figure', '.RichText', '.origin_image', '[class*="image"]',
      '[class*="img"]', '.Post-RichTextContainer'
    ],
    imageHosts: [/zhimg\.com/i, /zhihu\.com\/.*\.(?:jpg|png|webp)/i],
    avatarHosts: [/\/avatar\/|avatar.*zhimg|zhimg\.com\/.*\/[a-f0-9]{32}\._\d+x\d+/i],
    imageHostPattern: '(?:zhimg\\.com|zhihu\\.com)',
    // 知乎原图常在 data-original / data-actualsrc，src 是缩略图
    imageAttrs: ['data-original', 'data-actualsrc', 'data-src', 'src', 'data-lazy-src', 'data-url'],
    contentSize: null,
    sizeUpgrade: null,
    embeddedTokens: '',
    allowGenericImages: true,
    referer: 'https://www.zhihu.com/',
    refererHosts: ['zhimg.com'],
    hashDefault: 'keep',
    watermark: 'off',
    videoApi: null,
    permalink: 'generic',
    metaWords: /来自\s|关注了|赞同\s*\d+|评论\s*\d+|阅读全文|显示全部/gi,
  },

  wechat: {
    id: 'wechat',
    label: '微信公众号',
    hosts: ['weixin.qq.com', 'mp.weixin.qq.com'],
    // 公众号是单篇文章，不是信息流：整篇 #js_content 就是唯一「卡片」
    cardSelectors: [
      '#js_content', '.rich_media_content', '#page-content', 'article',
      '.rich_media_area_primary'
    ],
    textSelectors: [
      '#js_content', '.rich_media_content', 'section',
      '[class*="content"]', 'p'
    ],
    mediaSelectors: [
      '#js_content', '.rich_media_content', 'figure', '[class*="img"]',
      '[class*="image"]', 'section'
    ],
    imageHosts: [/mmbiz\.qpic\.cn/i, /qpic\.cn/i],
    avatarHosts: [/mmbiz\.qlogo\.cn/i, /\/avatar\/|qlogo/i],
    imageHostPattern: 'qpic\\.cn',
    // 微信图片真实地址几乎只在 data-src，src 是 1x1 占位
    imageAttrs: ['data-src', 'data-original', 'data-croporisrc', 'src', 'data-lazy-src'],
    contentSize: null,
    sizeUpgrade: null,
    embeddedTokens: '',
    allowGenericImages: false,
    referer: 'https://mp.weixin.qq.com/',
    refererHosts: ['qpic.cn'],
    hashDefault: 'keep',
    watermark: 'off',
    videoApi: null,
    permalink: 'generic',
    metaWords: /来自\s|点击上方|关注我们|长按二维码|预览时标签不可点/gi,
  },

  bilibili: {
    id: 'bilibili',
    label: 'B站动态',
    hosts: ['bilibili.com', 't.bilibili.com', 'space.bilibili.com'],
    cardSelectors: [
      '.bili-dyn-item', '.dyn-card', '.bili-dyn-list__item',
      '.card', 'article', '[class*="dyn-item"]'
    ],
    textSelectors: [
      '.bili-dyn-content__orig__desc', '.dyn-content', '.bili-dyn-text',
      '.bili-dyn-content__desc', '[class*="desc"]', '.text'
    ],
    mediaSelectors: [
      '.bili-dyn-content__orig__major', '.dyn-card', '.bili-album',
      '[class*="album"]', '[class*="picture"]', '[class*="preview"]', '[class*="media"]'
    ],
    imageHosts: [/hdslb\.com/i, /bfsstatic\.com/i],
    avatarHosts: [/\/bfs\/face\//i, /\/avatar\//i, /i[0-9]\.hdslb\.com\/bfs\/face/i],
    imageHostPattern: 'hdslb\\.com',
    imageAttrs: ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url'],
    contentSize: null,
    // B站图片 @320w_320h_1c.webp 这类尾巴可以去掉拿原图
    sizeUpgrade: null,
    embeddedTokens: '',
    allowGenericImages: true,
    referer: 'https://t.bilibili.com/',
    refererHosts: ['hdslb.com', 'bfsstatic.com'],
    hashDefault: 'stripTopics',
    watermark: 'off',
    videoApi: null,
    permalink: 'generic',
    metaWords: /来自\s|关注了|转发\s*\d+|评论\s*\d+|点赞\s*\d+|赞\s*\d+/gi,
  },

  douban: {
    id: 'douban',
    label: '豆瓣广播',
    hosts: ['douban.com', 'm.douban.com'],
    cardSelectors: [
      '.status-item', '.new-status', '.status-wrapper', '[data-aid]',
      '.status-item-wrapper', 'article'
    ],
    textSelectors: [
      '.status-saying', '.status-content', '.text', '.bd',
      '[class*="status"] [class*="text"]', '.review-short'
    ],
    mediaSelectors: [
      '.status-photo', '.status-image', '[class*="photo"]', 'figure',
      '.bd', '[class*="image"]'
    ],
    imageHosts: [/doubanio\.com/i],
    avatarHosts: [/\/u\d+\/\d+\.jpg|\/avatar\/|icon_user/i, /doubanio\.com\/view\/photo\/icon/i],
    imageHostPattern: 'doubanio\\.com',
    imageAttrs: ['src', 'data-src', 'data-original', 'data-lazy-src'],
    contentSize: null,
    sizeUpgrade: null,
    embeddedTokens: '',
    allowGenericImages: true,
    referer: 'https://www.douban.com/',
    refererHosts: ['doubanio.com'],
    hashDefault: 'keep',
    watermark: 'off',
    videoApi: null,
    permalink: 'generic',
    metaWords: /来自\s|关注了|响应\s*\d+|赞\s*\d+|转发\s*\d+|来自豆瓣App/gi,
  },

  xiaohongshu: {
    id: 'xiaohongshu',
    label: '小红书',
    hosts: ['xiaohongshu.com', 'edith.xiaohongshu.com'],
    cardSelectors: [
      '.note-item', '#noteContainer', '.feeds-page', '.note-detail',
      'section', 'article'
    ],
    textSelectors: [
      '#detail-desc', '.desc', '.note-text', '.title',
      '[class*="desc"]', '[class*="content"]'
    ],
    mediaSelectors: [
      '.swiper-slide', '.note-slider', '[class*="slider"]', '[class*="image"]',
      '[class*="carousel"]', '.media-container'
    ],
    imageHosts: [/xhscdn\.com/i, /xiaohongshu\.com\/.*\.(?:jpg|png|webp)/i],
    avatarHosts: [/\/avatar\/|sns-avatar|ci\.xiaohongshu\.com/i],
    imageHostPattern: '(?:xhscdn\\.com|xiaohongshu\\.com)',
    imageAttrs: ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url'],
    contentSize: null,
    sizeUpgrade: null,
    embeddedTokens: '',
    allowGenericImages: true,
    referer: 'https://www.xiaohongshu.com/',
    refererHosts: ['xhscdn.com'],
    hashDefault: 'stripTopics',
    // 小红书水印压在图上且带用户号，位置不固定：不做自动去水印，避免毁图
    watermark: 'off',
    videoApi: null,
    permalink: 'generic',
    metaWords: /来自\s|关注了|编辑于|收藏\s*\d+|评论\s*\d+|点赞\s*\d+/gi,
  },

  /*
   * X（原 Twitter）：把时间线上看到的推文「一键转成自己的新推文」。
   * 文字预填进 intent/tweet，配图复制到剪贴板/托盘，仍旧由本人手动发送，
   * 不调用任何自动发推接口、也不点原生转推按钮。
   *
   * 注意：X 与「转发目标」是同一个域，content script 会同时跑在 X 上，
   * 因此 content.js 里必须排除 /intent/、/i/flow/ 等发布页，避免自注入。
   */
  x: {
    id: 'x',
    label: 'X（推文）',
    hosts: ['x.com', 'twitter.com'],
    cardSelectors: [
      'article[data-testid="tweet"]',
      '[data-testid="tweetDetail"]',
      'article'
    ],
    textSelectors: [
      '[data-testid="tweetText"]', '.tweet-text'
    ],
    mediaSelectors: [
      '[data-testid="tweetPhoto"]', '[data-testid="attachments"]',
      '[data-testid="tweet-images"]', '[data-testid="videoComponent"]',
      '[class*="media"]'
    ],
    // 只认 /media/ 与视频封面；profile_images / profile_banners 是头像和背景
    imageHosts: [/pbs\.twimg\.com\/(?:media|ext_tw_video_thumb)\//i],
    avatarHosts: [
      /pbs\.twimg\.com\/profile_images\//i, /pbs\.twimg\.com\/profile_banners\//i,
      /abs\.twimg\.com/i, /\/emoji\//i
    ],
    // X 的头像在 Tweet-User-Avatar 容器里；不要用 a[href*="/user/"] 这类
    // 通用规则，否则用户昵称恰好叫 user/people 时内容图会被整条排除。
    avatarLinkSelector: '[data-testid="Tweet-User-Avatar"]',
    // CSS 背景图/内联正则用的域名锚点：写成 twimg.com 才能匹配 pbs.twimg.com
    imageHostPattern: 'twimg\\.com',
    imageAttrs: ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url'],
    contentSize: null,
    sizeUpgrade: null,
    // X 缩略图尺寸写在 query：?format=jpg&name=small → name=orig 才是原图。
    // 不能剥 query（format 也是必要参数），所以走 querySize 而不是 sizeUpgrade。
    querySize: { key: 'name', value: 'orig', fallback: 'format=jpg&name=orig' },
    // 内联补抓容易把引用推文/推荐卡片里的图采进来，X 只采 DOM 里已渲染的原图
    embeddedTokens: '',
    allowGenericImages: false,
    referer: 'https://x.com/',
    refererHosts: ['twimg.com'],
    hashDefault: 'keep',
    // X 图片本身不带平台水印；视频多为 HLS/blob，拿不到干净 mp4，一律不做处理
    watermark: 'off',
    videoApi: null,
    permalink: 'x',
    // X 卡片里可能有「主推文 + 引用推文」两段 tweetText，引用推文常常更长；
    // 按文本长度打分会选错，这里按 DOM 顺序取第一个（主推文在前）。
    preferFirstText: true,
    // 顺带兼容用户装的 X 辅助插件注入的账号统计标签（不是推文正文）
    metaWords: /(?:涌浪\s*[\d.]+\/分|粉丝比|互粉号|回复\s*\d+|转推\s*\d+|喜欢\s*\d+|查看翻译|推广|关注了|来自\s)/gi,
  }
};

function detectSite(hostname) {
  var h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!h) return SITE_PROFILES.weibo;
  for (var id in SITE_PROFILES) {
    if (!Object.prototype.hasOwnProperty.call(SITE_PROFILES, id)) continue;
    var hosts = SITE_PROFILES[id].hosts || [];
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i].replace(/^www\./, '');
      if (h === host || h.slice(-(host.length + 1)) === '.' + host) return SITE_PROFILES[id];
    }
  }
  return null;
}

// background / 测试环境不共享 content script 的全局，这里给一个可导入的出口
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SITE_PROFILES: SITE_PROFILES, detectSite: detectSite };
}
