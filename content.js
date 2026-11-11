/*
 * content.js — 在微博网页注入「一键转发」按钮，提取正文/原图/视频/作者，
 * 协调文字清洗、去水印、复制剪贴板、下载备份、打开 X。
 */
'use strict';

// 内置账号信息由 account.js 提供；独立运行/单元测试时保留同样的兜底值
const MY_X = (typeof X_ACCOUNT !== 'undefined') ? X_ACCOUNT : {
  name: '昆哥', handle: 'YikunChen1983', url: 'https://x.com/YikunChen1983',
  community: 'TapeOut社区成员：昆哥'
};

/* ---------- 站点适配 ----------
 * sites.js 按域名给出当前站点的选择器/图床/清洗规则；微博 profile 的值与
 * 改造前的硬编码完全一致，保证已有行为零回归。未知站点返回 null → 不注入。
 * WBX_TEST_HOST 仅供 Node 回归测试注入域名，浏览器里不存在。
 */
const HOST = (typeof location !== 'undefined' && location && location.hostname)
  || (typeof WBX_TEST_HOST !== 'undefined' ? WBX_TEST_HOST : 'weibo.com');
const SITE = (typeof detectSite === 'function') ? detectSite(HOST) : null;
const SITE_LABEL = (SITE && SITE.label) || '当前站点';
/* X 既是来源站又是发布目标：插件自己打开的 /intent/tweet 页面绝不能注入按钮，
 * 否则会在发推框里再叠一个「一键转发」。WBX_TEST_PATH 仅供回归测试注入路径。 */
const PAGE_PATH = (typeof location !== 'undefined' && location && location.pathname)
  || (typeof WBX_TEST_PATH !== 'undefined' ? WBX_TEST_PATH : '/');

const SETTINGS_DEFAULT = {
  // 已取消「需去水印作者 UID」列表，图片/视频都由全局开关控制
  inpaintImages: true,           // 对所有图片去水印
  inpaintVideo: true,            // 对所有视频去水印（优先取 HD 原片）
  xDomain: 'x.com',
  hashMode: 'truncate',          // truncate(删 # 及后) | stripTopics(只删话题块) | keep(不动)
  appendSignature: false,        // 是否在清洗后的正文末尾附上「昆哥 + 主页链接」
  appendSource: false,           // X 来源时是否在正文末尾附上原推文链接（默认关闭）
  enableAiComment: true,         // X 回复填写区右侧是否显示「AI 评论」按钮
  replyInputSelector: '',        // X 改版时可覆盖回复框选择器（留空用 sites.js 内置）
  enabledSites: {},              // 各站点开关；默认全部启用（值为 false 才关闭）
  // 1.4.3：临时文件 / 落盘策略
  autoDownloadBackup: false,     // 转发时自动下载图片备份（默认关：图片走剪贴板不落盘）
  tmpCleanup: true,              // 必要的临时文件（视频 / 手动下载）到期自动清理
  tmpKeepMinutes: 30,            // 保留时长（分钟），0 = 不自动清理
  // 1.4.5：AI 评论末尾的 TapeOut / $BEM 推广尾巴（默认关闭）
  promoEnabled: false,
  promoTarget: 'both',           // both | tapeout | bem
  promoCustomTapeOut: '',
  promoCustomBEM: '',
  // 1.4.8：回复框右侧只有一个 T 按钮（与 AI 评论无关，自己写完评论也能点）
  promoQuickButtons: true,
  promoQuickCount: 4,            // 兼容旧配置；1.4.8 起固定一个按钮，不再读取
  // 1.4.11：安全模式 —— T 只复制推广句、绝不碰 X 编辑器（100% 不会弄乱正文）
  promoCopyOnly: false,
  // 1.4.11：AI 评论快速模式（不思考、不并排对比、流式拿到答案就收尾）
  grokFastMode: true
};
let settings = Object.assign({}, SETTINGS_DEFAULT);

function loadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(SETTINGS_DEFAULT, (s) => {
        settings = Object.assign({}, SETTINGS_DEFAULT, s || {});
        resolve(settings);
      });
    } catch (e) { resolve(settings); }
  });
}

/* 1.4.5：设置页保存「评论末尾推广」后立即生效，已打开的 X 页面不用刷新。
 * 只同步本次新增的 4 个键，不覆盖其它运行期状态；老环境没有 onChanged 时静默跳过。 */
try {
  if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes) return;
      ['promoEnabled', 'promoTarget', 'promoCustomTapeOut', 'promoCustomBEM',
        'promoQuickButtons', 'promoQuickCount', 'promoCopyOnly', 'grokFastMode'].forEach((k) => {
        if (changes[k]) settings[k] = changes[k].newValue;
      });
    });
  }
} catch (e) { /* ignore */ }

/* 1.4.1 一次性设置迁移 —— 让「站内直连」真正生效，且不需要重载扩展。
 * 老版本(1.3.x)把用户选的「X 站内 Grok」存成了显式 grokMode="page"。
 * 1.4.0 的 pickGrokMode 遇到非 auto 会直接返回 page，于是新增的直连链路
 * 一次都没走过，用户仍卡在会报「提示词写入校验失败」的旧 DOM 页面上。
 * 用户选 page 的本意就是「免 API Key 用 X 站内 Grok」，auto 在 X 标签里优先
 * 直连、失败仍回退页面模式，语义完全兼容。这里只写 storage（后台每次请求都
 * 重新读），所以当前已加载的实例只要刷新页面就立刻切到直连。 */
function migrateGrokMode141() {
  try {
    chrome.storage.sync.get(
      ['grokMode', 'grokPreferNative', 'grokModeMigrated141'], (m) => {
        try {
          if (!m || String(m.grokMode || '').toLowerCase() !== 'page') return;
          if (m.grokPreferNative === false) return;      // 用户显式关掉直连，尊重
          if (m.grokModeMigrated141 === true) return;    // 只迁移一次，不覆盖之后的选择
          chrome.storage.sync.set({ grokMode: 'auto', grokModeMigrated141: true });
        } catch (e) {}
      });
  } catch (e) {}
}

// ---------- 样式注入 ----------
function injectStyle() {
  if (document.getElementById('wbx-style')) return;
  const css = `
  .wbx-repost-btn{
    position:absolute;top:2px;right:2px;z-index:20;
    display:inline-flex;align-items:center;gap:2px;
    padding:0 6px;height:18px;border:none;border-radius:8px;cursor:pointer;
    background:#ff7800;color:#fff;font-size:11px;line-height:18px;font-weight:600;
    box-shadow:0 1px 2px rgba(255,120,0,.4);
  }
  .wbx-repost-btn:hover{background:#ff8c1a;}
  .wbx-repost-btn:disabled{opacity:.6;cursor:default;}
  /* 转发按钮组：由 group 负责绝对定位，组内按钮回到文档流；1.3.1 起组内只有这一个按钮 */
  .wbx-btn-group{
    position:absolute;top:2px;right:2px;z-index:20;
    display:inline-flex;align-items:center;gap:4px;
  }
  .wbx-btn-group .wbx-repost-btn,.wbx-btn-group .wbx-comment-btn{position:static;}
  .wbx-comment-btn{
    display:inline-flex;align-items:center;gap:2px;
    padding:0 6px;height:18px;border:none;border-radius:8px;cursor:pointer;
    background:#6b46c1;color:#fff;font-size:11px;line-height:18px;font-weight:600;
    box-shadow:0 1px 2px rgba(107,70,193,.4);white-space:nowrap;
  }
  .wbx-comment-btn:hover{background:#7c56d6;}
  .wbx-comment-btn:disabled{opacity:.6;cursor:default;}
  /* 1.4.10：两个回复区按钮都移到「编辑区上方外侧」。
   * 1.3.1~1.4.9 用 top:2px，按钮直接压在回复正文第一行右侧（真机截图里
   * 橙 T / 紫 AI 评论盖住「…逻辑门搬到画布上」那几个字），用户点按钮时
   * 还容易先碰到文字、把光标挪到正文中间，之后写入就错位 / 重复。 */
  .wbx-comment-btn.wbx-reply-btn{
    position:absolute !important;top:-26px !important;right:6px !important;z-index:30 !important;
    height:20px !important;padding:0 8px !important;font-size:11px !important;line-height:20px !important;
    box-shadow:0 1px 4px rgba(107,70,193,.5) !important;
    user-select:none !important;-webkit-user-select:none !important;
  }
  /* 1.4.10：全页只有一个 T 按钮，贴着 AI 评论按钮左侧，同样在正文上方外侧 */
  .wbx-promo-bar{
    position:absolute !important;top:-26px !important;right:76px !important;z-index:30 !important;
    display:inline-flex !important;align-items:center;gap:2px;
  }
  /* 只在宿主真的裁剪溢出时才放开：X 的编辑区容器若 overflow:hidden 会把
   * 上移后的按钮整条裁掉。没裁剪时绝不改 X 的布局。 */
  .wbx-reply-tools-host{overflow:visible !important;}
  .wbx-promo-btn.wbx-promo-single{
    display:inline-flex !important;align-items:center;justify-content:center;
    min-width:24px;height:20px;padding:0 7px;box-sizing:border-box;
    border:none;border-radius:6px;cursor:pointer;
    background:#ff7800;color:#fff;font-size:11px;font-weight:700;line-height:20px;
    box-shadow:0 1px 3px rgba(255,120,0,.45);white-space:nowrap;
    user-select:none !important;-webkit-user-select:none !important;
  }
  .wbx-promo-btn.wbx-promo-single:hover{background:#ff8c1a;}
  /* AI 评论候选卡片：与图片托盘同级的强可见浮层，不抢 X 的焦点 */
  #wbx-comments{
    position:fixed !important;right:20px !important;bottom:20px !important;
    z-index:2147483647 !important;width:380px !important;max-height:80vh !important;
    overflow:auto !important;display:block !important;
    background:#fff !important;color:#222 !important;border:2px solid #6b46c1 !important;
    border-radius:14px !important;box-shadow:0 8px 32px rgba(0,0,0,.35) !important;
    font-size:13px !important;line-height:1.5 !important;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif !important;
    animation:wbx-g-in .22s ease-out;
  }
  .wbx-c-head{
    display:flex !important;align-items:center;justify-content:space-between;
    padding:10px 12px;background:#6b46c1 !important;color:#fff !important;font-weight:700;border-radius:12px 12px 0 0;
  }
  .wbx-c-close{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;line-height:1;}
  .wbx-c-tip{padding:8px 12px;color:#666;font-size:12px;border-bottom:1px solid #eee;}
  .wbx-c-item{padding:12px;border-bottom:1px solid #eee;}
  .wbx-c-label{font-size:11px;color:#6b46c1;font-weight:700;margin-bottom:6px;}
  .wbx-c-text{white-space:pre-wrap;word-break:break-word;color:#222;font-size:13px;line-height:1.6;}
  .wbx-c-actions{display:flex;gap:8px;margin-top:9px;}
  .wbx-c-use{
    flex:1;border:none;border-radius:8px;background:#6b46c1;color:#fff;
    font-size:12px;font-weight:700;padding:7px 6px;cursor:pointer;
  }
  .wbx-c-use:hover{background:#7c56d6;}
  .wbx-c-copy{
    border:1px solid #d9cff2;background:#f7f3ff;color:#6b46c1;border-radius:8px;
    font-size:12px;padding:7px 10px;cursor:pointer;
  }
  .wbx-c-foot{display:flex;gap:8px;padding:10px 12px;}
  .wbx-c-foot button{
    flex:1;border:1px solid #d9cff2;background:#fff;color:#6b46c1;border-radius:8px;
    font-size:12px;padding:8px;cursor:pointer;font-weight:600;
  }
  .wbx-c-foot button:hover{background:#f7f3ff;}
  .wbx-c-manual{display:flex;gap:8px;padding:0 12px 10px;}
  .wbx-c-manual button{
    flex:1;border:1px dashed #d9cff2;background:#faf8ff;color:#6b46c1;border-radius:8px;
    font-size:11px;padding:7px 5px;cursor:pointer;font-weight:600;
  }
  .wbx-c-manual button:hover{background:#f1ebff;}
  /* 1.3.2：点击 AI 评论立即出现的等待浮层，结果回来才关闭 */
  #wbx-ai-busy{
    position:fixed !important;left:50% !important;top:50% !important;transform:translate(-50%,-50%) !important;
    z-index:2147483647 !important;width:340px !important;max-width:90vw !important;box-sizing:border-box !important;
    background:#fff !important;color:#222 !important;border:2px solid #6b46c1 !important;border-radius:16px !important;
    box-shadow:0 14px 52px rgba(20,10,45,.38) !important;padding:22px 20px 18px !important;text-align:center !important;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif !important;
    animation:wbx-g-in .2s ease-out;
  }
  .wbx-busy-spin{
    width:34px;height:34px;margin:0 auto 12px;border:3px solid #e6dcff;border-top-color:#6b46c1;
    border-radius:50%;animation:wbx-spin .8s linear infinite;
  }
  @keyframes wbx-spin{to{transform:rotate(360deg)}}
  .wbx-busy-title{font-weight:700;font-size:15px;color:#4c2a91;margin-bottom:6px;}
  .wbx-busy-stage{color:#444;min-height:44px;}
  .wbx-busy-time{color:#8b7aa8;font-size:12px;margin-top:8px;}
  .wbx-busy-hint{color:#999;font-size:11px;margin-top:6px;}
  .wbx-busy-cancel{
    margin-top:12px;border:1px solid #d9cff2;background:#fff;color:#6b46c1;border-radius:8px;
    font-size:12px;padding:6px 14px;cursor:pointer;font-weight:600;
  }
  .wbx-busy-cancel:hover{background:#f7f3ff;}
  .wbx-c-diag{padding:7px 12px;background:#f4f0ff;color:#5b3b9e;font-size:11px;border-bottom:1px solid #eee;line-height:1.5;}
  .wbx-repost-mark{position:relative;}
  .wbx-repost-mark::after{
    content:"一键转发↪X";position:absolute;top:-16px;left:50%;transform:translateX(-50%);
    background:#ff7800;color:#fff;font-size:10px;padding:1px 5px;border-radius:8px;white-space:nowrap;
    opacity:0;transition:opacity .15s;pointer-events:none;
  }
  .wbx-repost-mark:hover::after{opacity:1;}
  #wbx-toast{
    position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;
    background:rgba(0,0,0,.82);color:#fff;padding:10px 16px;border-radius:10px;
    font-size:14px;max-width:80vw;box-shadow:0 4px 16px rgba(0,0,0,.3);line-height:1.5;
    white-space:pre-line;
  }
  #wbx-notice{
    position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;
    width:320px;max-width:88vw;box-sizing:border-box;background:#fff;color:#222;
    border:2px solid #6b46c1;border-radius:14px;padding:16px 16px 14px;
    box-shadow:0 12px 44px rgba(20,10,45,.34);
    font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  }
  .wbx-n-title{font-size:14px;font-weight:700;color:#4c2a91;margin-bottom:8px;}
  .wbx-n-msg{color:#333;margin-bottom:10px;}
  .wbx-n-detail{display:none;max-height:150px;overflow:auto;background:#f6f2ff;color:#5b3b9e;
    border-radius:8px;padding:9px;font-size:11px;white-space:pre-wrap;word-break:break-word;margin-bottom:10px;}
  .wbx-n-detail.open{display:block;}
  .wbx-n-actions{display:flex;gap:8px;}
  .wbx-n-actions button{flex:1;border:1px solid #d9cff2;background:#fff;color:#6b46c1;
    border-radius:8px;font-size:12px;padding:7px;cursor:pointer;}
  .wbx-n-actions button.primary{background:#6b46c1;color:#fff;border-color:#6b46c1;}
  #wbx-copybtn{
    position:fixed;right:24px;bottom:24px;z-index:999999;border:none;border-radius:10px;
    background:#1da1f2;color:#fff;padding:10px 14px;font-size:14px;cursor:pointer;font-weight:600;
    box-shadow:0 4px 16px rgba(29,161,242,.4);
  }
  #wbx-gallery{
    position:fixed !important;right:20px !important;bottom:20px !important;
    z-index:2147483647 !important;width:340px !important;max-height:78vh !important;
    overflow:auto !important;display:block !important;
    background:#fff !important;color:#222 !important;border:2px solid #ff7800 !important;
    border-radius:14px !important;box-shadow:0 8px 32px rgba(0,0,0,.35) !important;
    font-size:12px !important;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif !important;
    animation:wbx-g-in .22s ease-out;
  }
  @keyframes wbx-g-in{from{transform:translateY(18px) scale(.96);opacity:0}to{transform:none;opacity:1}}
  .wbx-g-head{
    display:flex !important;align-items:center;justify-content:space-between;
    padding:10px 12px;background:#ff7800 !important;color:#fff !important;font-weight:700;border-radius:12px 12px 0 0;
  }
  .wbx-g-close{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;line-height:1;}
  .wbx-g-open{
    display:block !important;width:calc(100% - 24px) !important;margin:10px 12px 4px !important;
    border:none !important;border-radius:9px !important;background:#1da1f2 !important;color:#fff !important;
    font-size:14px !important;font-weight:700 !important;padding:10px 8px !important;cursor:pointer;
    box-shadow:0 3px 10px rgba(29,161,242,.35) !important;
  }
  .wbx-g-open:hover{background:#1589d1 !important;}
  .wbx-g-tip{padding:8px 12px;color:#666;line-height:1.5;border-bottom:1px solid #eee;}
  .wbx-g-progress{padding:6px 12px 0;color:#d96000;font-weight:700;}
  .wbx-g-list{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px;}
  .wbx-g-item{width:96px;text-align:center;}
  .wbx-g-item img{
    width:96px;height:96px;object-fit:cover;display:block;border-radius:8px;
    border:1px solid #e5e5e5;background:#f5f5f5;
  }
  .wbx-g-item button{
    width:100%;margin-top:4px;border:none;border-radius:6px;background:#1da1f2;color:#fff;
    font-size:11px;padding:4px 0;cursor:pointer;
  }
  .wbx-g-item button:hover{background:#1589d1;}
  .wbx-g-actions{display:flex;gap:8px;padding:0 12px 12px;}
  .wbx-g-actions button{
    flex:1;border:1px solid #ff7800;background:#fff7f0;color:#d96000;border-radius:8px;
    font-size:11px;padding:7px 4px;cursor:pointer;font-weight:600;
  }
  .wbx-g-actions button:hover{background:#ffe8d0;}
  `;
  const style = document.createElement('style');
  style.id = 'wbx-style';
  style.textContent = css;
  document.head.appendChild(style);
}

// ---------- 图片地址升级到原图 ----------
// 微博把缩略图尺寸段换成 large；其他站没有统一尺寸规则，直接返回原地址。
const FALLBACK_SIZE_UPGRADE = {
  hostPattern: 'sinaimg\\.cn/',
  tokens: ['thumb150','thumb300','square','thumbnail','bmiddle','mw690','mw1024','mw2048','orj360','orj480','small','middle'],
  target: 'large'
};
function upgradeImageUrl(url) {
  if (!url) return url;
  let u = url.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  const cfg = (SITE && SITE.sizeUpgrade) || (SITE ? null : FALLBACK_SIZE_UPGRADE);
  if (cfg) {
    for (const t of cfg.tokens) {
      const re = new RegExp('(' + cfg.hostPattern + ')' + t + '/');
      if (re.test(u)) { u = u.replace(re, '$1' + cfg.target + '/'); break; }
    }
  }
  // X 的缩略图尺寸写在 query：?format=jpg&name=small → name=orig 才是原图。
  // 只替换这一个参数，format / 签名等其余参数原样保留。
  const q = SITE && SITE.querySize;
  if (q) {
    const re = new RegExp('([?&]' + q.key + '=)[^&#]+', 'i');
    if (re.test(u)) u = u.replace(re, '$1' + q.value);
    else u += (u.indexOf('?') >= 0 ? '&' : '?') + (q.fallback || q.key + '=' + q.value);
  }
  // 微博 large 图的 query 是无关参数；其他站（小红书签名、知乎图片参数、
  // X 的 format）的 query 含鉴权/格式信息，必须完整保留，否则请求会 403。
  return (!SITE || SITE.id === 'weibo') ? u.split('?')[0] : u;
}

// ---------- 内容单元解析 ----------
/*
 * 微博新版首页每条博文是一个 <article>，内部顺序大致是：
 *   推荐关注条 → 作者行(头像/昵称/时间/认证) → 正文 → 图片墙/视频 → 工具栏
 *
 * 统一以「正文节点」为锚点：按钮挂在它的右上角，文字/图片/视频/作者都从
 * 同一个内容单元解析，保证「看到哪条就转哪条」。
 */
const CARD_SELECTORS = (SITE && SITE.cardSelectors) || [
  'article', 'div[action-type="feed_list_item"]', 'div.card-wrap', 'div.WB_cardwrap'
];
const TEXT_SELECTORS = (SITE && SITE.textSelectors) || [
  '[node-type="feed_list_content"]', '.WB_text', '.weibo-text',
  '[data-text]', '.detail_text', '.woo-text'
];
const MEDIA_SELECTORS = (SITE && SITE.mediaSelectors) || [
  '[node-type="feed_list_media"]', '.WB_media_wrap', '.woo-picture-main',
  '[class*="picture"]', '[class*="video"]', '[class*="media"]'
];
// 头像域名：微博 tvax*/tva*.sinaimg.cn；其他站各自配置
const AVATAR_HOSTS = (SITE && SITE.avatarHosts) ||
  [/(?:^|\/\/)(?:tvax|tva)\d*\.sinaimg\.cn/i];
// 头像/昵称链接里的图一律不算内容图；各站链接结构不同，可在站点配置里覆盖
const AVATAR_LINK_SELECTOR = (SITE && SITE.avatarLinkSelector) ||
  'a[href*="/u/"], a[href*="/user/"], a[href*="/people/"]';
// 内容图必有尺寸段（微博 large / mw2000 / orj1080 ...）；其他站不强制
const CONTENT_SIZE = SITE
  ? SITE.contentSize
  : /\/(?:large|mw2000|mw1024|mw2048|mw690|orj1080|orj480|orj360|bmiddle|woriginal|original|thumb150|thumb300|small|middle|square|thumbnail)\//i;

// 图片是否属于当前站点的内容图域名；非微博站允许宽松识别通用图片 URL
function isImageHost(src) {
  if (!src) return false;
  const hosts = (SITE && SITE.imageHosts) || [/sinaimg\.cn/i];
  if (hosts.some((r) => r.test(src))) return true;
  if (SITE && SITE.allowGenericImages) {
    return /\.(?:jpg|jpeg|png|webp|gif)(?:\?|#|$)/i.test(src) ||
      /\/(?:img|image|pic|photo)\//i.test(src);
  }
  return false;
}

function isAvatarUrl(src) {
  if (AVATAR_HOSTS.some((r) => r.test(src))) return true;
  return /\/crop\.|\/avatar\/|emoji|face|50x50|180x180/i.test(src);
}

function cleanText(s) {
  return (s || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/*
 * 取正文文本时剔除插件自己注入的按钮。
 * 按钮被 append 到正文节点内部，innerText 会把「一键转发 / ⏳ 处理中…」算进正文，
 * 既污染转发到 X 的文字，也会让指纹随按钮状态变化而抖动。
 */
/* 1.3.4 真机事故防护：插件自己注入的 UI 文字。
 * 上一版回复框被重复注入 33 个「AI 评论」按钮，这些文字被当成推文正文
 * 发给 Grok（提示词里是几十个「AI 评论」），模型只回了一个 🤖，
 * 于是页面报「没读到 Grok 的回答块」。所有取正文的路径都必须先过这一层。 */
const WBX_UI_WORDS = [
  '⏳ 生成中', '⏳ 处理中', '处理中…', 'AI 评论', '一键转发',
  '再来 3 条', '复制提示词', '读取 Grok 回答', '请生成英文回复', '✦AI 生成'
];
function stripInjectedUi(raw) {
  let s = String(raw || '');
  for (const w of WBX_UI_WORDS) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'g'), ' ');
  }
  return s;
}

/* 最终发给 Grok / 用于转发前的统一清洗：去插件 UI、去 X 自身界面词、压空白、限长 */
function sanitizePostText(t) {
  let s = stripInjectedUi(String(t || ''));
  s = s.replace(/Drafts|Replying to\s*@?\S+|Post your reply|Add photos or video|Add a GIF|Generate image|Add poll|Add emoji|Schedule post|Content disclosure|Show translation|Show more/gi, ' ');
  s = cleanText(s.replace(/\s+/g, ' ')).trim();
  return s.slice(0, 1200);
}

function textOfNode(el) {
  if (!el) return '';
  let raw = el.innerText || el.textContent || '';
  try {
    // 「一键转发」和 X 上的「AI 评论」都挂在正文节点里，两个都要剔除，
    // 否则按钮文字会被当成正文转发，内容指纹也会随按钮状态抖动。
    const btns = el.querySelectorAll ? el.querySelectorAll('.wbx-repost-btn, .wbx-comment-btn') : [];
    for (const b of btns) {
      const t = String((b.innerText || b.textContent || '')).trim();
      if (t) raw = raw.split(t).join('');
    }
  } catch (e) {}
  // 按钮被禁用时文字会变成「⏳ 生成中」，上面的 split 就删不掉残留的「AI 评论」；
  // 再用固定词表全局清一遍，连续注入几十个按钮也能清干净。
  return cleanText(stripInjectedUi(raw));
}

/*
 * 转发文字清洗：默认把「正文后面第一个 # 及其后所有内容」删掉，
 * 即去掉微博的话题标签/推广尾巴。
 * 保护：若 # 出现在开头（#话题# 正文…），截断会把正文全删光，
 * 此时自动退化为「只移除 #...# 话题块」，避免转发出空内容。
 * 设置里可切换 stripTopics（只删话题块）/ keep（不处理）。
 */
function cleanRepostText(raw, mode) {
  const t = cleanText(raw);
  if (!t || mode === 'keep') return t;
  const stripTopics = (s) => cleanText(s.replace(/[#＃][^#＃]{0,80}[#＃]/g, ' '));
  if (mode === 'stripTopics') return stripTopics(t);
  const m = /[#＃]/.exec(t);
  if (!m) return t;
  const head = cleanText(t.slice(0, m.index));
  return head.length >= 6 ? head : stripTopics(t);
}

/*
 * 可选署名：在清洗后的正文末尾附上内置账号信息。
 * 默认关闭，保证「删掉 # 后内容」得到的正文保持干净；
 * 开启后由 X intent 一起预填，并做长度保护避免超出推文上限。
 */
function withSignature(text) {
  if (!settings.appendSignature) return text || '';
  const sig = `\n\n— ${MY_X.name} (@${MY_X.handle})\n${MY_X.url}`;
  const MAX = 250;
  const base = text || '';
  if (base.length + sig.length <= MAX) return base + sig;
  return base.slice(0, Math.max(0, MAX - sig.length)) + '…' + sig;
}

/*
 * 在 X 上把别人的推文转成自己的新推文时，可选附上原推链接做来源标注。
 * 只取卡片里第一条 /<用户>/status/<id> 链接（通常是本条推文的时间戳链接），
 * 不取引用推文里的链接，也不改写正文其它部分。
 */
function extractPermalink(card) {
  if (!SITE || SITE.permalink !== 'x') return '';
  try {
    for (const a of card.querySelectorAll('a[href]')) {
      const h = String(a.href || '');
      const m = /(?:x\.com|twitter\.com)\/([^/?#]+)\/status\/(\d+)/i.exec(h)
        || /^\/([^/?#]+)\/status\/(\d+)/.exec(h);
      if (m) return 'https://x.com/' + m[1] + '/status/' + m[2];
    }
  } catch (e) {}
  return '';
}

function withSource(text, card) {
  if (!settings.appendSource || !SITE || SITE.permalink !== 'x') return text || '';
  const link = extractPermalink(card);
  if (!link) return text || '';
  const suffix = '\n\n原文：' + link;
  const MAX = 250;                 // 推文上限 280，留出余量
  const base = text || '';
  if (base.length + suffix.length <= MAX) return base + suffix;
  return base.slice(0, Math.max(0, MAX - suffix.length)) + '…' + suffix;
}

function looksLikeNoise(t) {
  if (!t) return true;
  if (/关注了|的人也关注|^来自\s|小时前|分钟前|^刚刚$/.test(t)) return true;
  if (/^\d{1,2}-\d{1,2}\s|^20\d\d[-/]\d/.test(t)) return true;
  if (/^(?:关注|粉丝|微博|主页|全部|转发|评论|赞|收藏|分享|更多|\d+)$/.test(t)) return true;
  // 微博认证标签只对微博判定，其他站正文里出现「认证」等词不该被当噪声
  if ((!SITE || SITE.id === 'weibo') && t.length < 30 &&
      /(?:博主|超话|创作官|认证|视频号)/.test(t) && !/[。！？，,.!?]/.test(t)) return true;
  return false;
}

function nodeDepth(el, root) {
  let d = 0, p = el && el.parentElement;
  while (p && p !== root && d < 20) { d++; p = p.parentElement; }
  return d;
}

function scoreText(t) {
  let s = t.length;
  if (/[。！？，、；：,.!?]/.test(t)) s += 20;
  if (/#\S+#|@\S+/.test(t)) s += 15;
  if (/\d+小时前|\d+分钟前|已编辑|来自\s|关注了|的人也关注/.test(t)) s -= 60;
  if (t.length < 40 && /(转发|评论|赞|收藏)\s*\d*$/.test(t)) s -= 40;
  return s;
}

/* ---------- 作者信息头剥离 ----------
 * 微博新版把「推荐条 / 作者昵称 / 时间 / 认证标签」和正文放在同一个
 * <article> 里，启发式选出的容器常把整段作者信息一起当成正文：
 *   限宅 关注了 珑美恩雅 昨天 10:32 音乐博主 超话创作官（OaAngel超话）
 *   微博原创视频博主 说实话 如果我是汪峰…
 * innerText 会把这些节点和正文直接粘连（中文之间甚至没有空格），
 * 单靠文本正则切不干净，所以按 DOM 收集元信息块，从开头整块消费掉。
 */
const META_WORD = (SITE && SITE.metaWords) || /(?:博主|超话|创作官|主持人|认证|视频号|达人|会员)/g;
const TIME_WORD = /(?:昨天|前天|今天|刚刚|\d+\s*(?:秒|分钟|小时)前|\d{1,2}:\d{2}|\d{1,2}-\d{1,2}|\d{4}-\d{2}-\d{2})/;
const TOOL_WORD = /^(?:转发|评论|赞|收藏|分享|更多)(?:\s*\d+)?$/;

function isMetaText(t, n) {
  const s = cleanText(t);
  // 正文再长也不能当成「作者信息块」；只有短的头部/标签节点才算
  if (!s || s.length > 80) return false;
  if (/^来自\s/.test(s)) return true;
  if (TOOL_WORD.test(s)) return true;
  if (/关注了/.test(s) && s.length < 30 && !/[。！？]/.test(s)) return true;
  if (TIME_WORD.test(s) && s.length < 60 && !/[。！？，、]/.test(s)) return true;
  const words = (s.match(META_WORD) || []).length;
  if (words >= 2 && s.length < 60 && !/[。！？，、]/.test(s)) return true;
  if (n && String(n.tagName || '').toUpperCase() === 'A') {
    const href = (n.getAttribute && n.getAttribute('href')) || '';
    // 正文里的 @提及也是 /u/ 链接，靠开头的 @ 区分
    if (/\/u\/\d+/.test(href) && !/^[@#]/.test(s) && s.length <= 24) return true;
  }
  return false;
}

function collectMetaFragments(card, el) {
  const out = new Set();
  try {
    card.querySelectorAll('div, span, a, p, section, header, li').forEach((n) => {
      if (n === el) return;
      const t = cleanText(n.innerText || n.textContent || '');
      if (!isMetaText(t, n)) return;
      out.add(t);
      // 推荐条常带尾巴「…的人也关注」，真实作者行紧接在「关注了」后面，
      // 额外收一个短前缀，保证粘连时也能剥掉
      const k = t.indexOf('关注了');
      if (k >= 0) out.add(t.slice(0, k + 3));
    });
  } catch (e) {}
  // 长片段优先：一次删掉整条作者行，避免留下「昨天 10:32」这类残片
  return Array.from(out).sort((a, b) => b.length - a.length);
}

// 忽略双方空白差异，把 frag 当作 s 的前缀消费，返回消费到的位置
function consumePrefix(s, frag) {
  let i = 0;
  for (let j = 0; j < frag.length; j++) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (/\s/.test(frag[j])) continue;
    if (i >= s.length || s[i] !== frag[j]) return -1;
    i++;
  }
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function stripMetaTail(s) {
  let out = s;
  for (let k = 0; k < 4; k++) {
    const next = out
      .replace(/\s+(?:转发|评论|赞|收藏|分享|更多)\s*\d*\s*$/g, '')
      .replace(/\s+来自\s*\S+\s*$/g, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

// 纯昵称片段（「珑美恩雅」）只有后面还接着时间/认证信息时才算作者行，
// 否则正文恰好以某人名字开头时会被误删。
function isNameFrag(f) {
  return !TIME_WORD.test(f) && !(f.match(META_WORD) || []).length &&
    !/关注了|来自/.test(f) && !TOOL_WORD.test(f);
}

// 取正文：先按 DOM 元信息块剥掉作者信息头，再去掉工具栏尾巴
function bodyText(card, el) {
  const raw = textOfNode(el);
  if (!raw) return '';
  const frags = (card && card.querySelectorAll) ? collectMetaFragments(card, el) : [];
  let s = raw;
  let changed = true;
  for (let guard = 0; changed && guard < 12; guard++) {
    changed = false;
    for (const f of frags) {
      const cut = consumePrefix(s, f);
      if (cut <= 0 || s.length - cut < 4) continue;
      const rest = s.slice(cut, cut + 8);
      if (isNameFrag(f) && !(TIME_WORD.test(rest) || (rest.match(META_WORD) || []).length)) continue;
      s = s.slice(cut);
      changed = true;
      break;
    }
  }
  const out = cleanText(stripMetaTail(s));
  // 保护：别把短正文误删成空，宁可保留原文
  return out.length >= 4 || out === raw ? out : raw;
}

function findTextNode(card) {
  const hits = new Set();
  TEXT_SELECTORS.forEach((s) => {
    try { card.querySelectorAll(s).forEach((n) => hits.add(n)); } catch (e) {}
  });
  const scored = [];
  hits.forEach((n) => {
    const raw = textOfNode(n);
    const t = bodyText(card, n);
    if (t.length >= 4 && !looksLikeNoise(t)) {
      scored.push({ n, len: t.length, meta: raw.length - t.length });
    }
  });
  if (scored.length) {
    // X 等带引用推文的卡片：命中多个正文节点时按 DOM 顺序取第一个（主推文），
    // 不能按长度排序，否则更长的引用推文会被当成正文转发走。
    if (SITE && SITE.preferFirstText) return scored[0].n;
    // 长度相同则优先「不含元信息」的节点：按钮要锚在正文，不是作者行
    scored.sort((a, b) => (b.len - a.len) || (a.meta - b.meta));
    return scored[0].n;
  }
  const cands = [];
  try {
    card.querySelectorAll('div, p, span, section').forEach((el) => {
      if (el.closest && el.closest('[node-type="feed_list_options"], .card-act, footer')) return;
      if (isMetaText(textOfNode(el), el)) return;
      // 排除嵌套卡片/原生按钮，但忽略插件自己注入的「一键转发」按钮
      if (el.querySelector) {
        const blockers = Array.from(el.querySelectorAll('article, button'));
        const isOurs = (n) => /\bwbx-(?:repost|comment)-btn\b/.test(String((n && n.className) || ''));
        if (blockers.some((n) => !isOurs(n))) return;
      }
      const raw = textOfNode(el);
      const t = bodyText(card, el);
      if (t.length >= 6 && !looksLikeNoise(t)) {
        // 元信息删得越多，说明这个容器越可能是「作者行+正文」的大壳子，降低优先级
        const meta = raw.length - t.length;
        cands.push({ el, score: scoreText(t) - meta * 2, depth: nodeDepth(el, card) });
      }
    });
  } catch (e) {}
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score - a.score) || (b.depth - a.depth));
  return cands[0].el;
}

function findMediaRoot(card) {
  for (const s of MEDIA_SELECTORS) {
    try {
      const n = card.querySelector(s);
      if (n && (n.querySelectorAll('img').length || n.querySelectorAll('video').length)) return n;
    } catch (e) {}
  }
  return card;
}

/*
 * 图片懒加载：各站把真实地址放在 src / data-src / data-original / srcset，
 * 顺序由站点配置决定（微信几乎只在 data-src，知乎偏好 data-original）。
 */
function pickImageSrc(im) {
  const keys = (SITE && SITE.imageAttrs) ||
    ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-original-src'];
  for (const k of keys) {
    const v = im.getAttribute && im.getAttribute(k);
    if (v && isImageHost(v)) return v;
  }
  const ss = im.getAttribute && im.getAttribute('srcset');
  if (ss) {
    const m = /https?:\/\/[^\s,]+/i.exec(ss);
    if (m && isImageHost(m[0])) return m[0];
  }
  return (im.src && isImageHost(im.src)) ? im.src : '';
}

// 部分站点把九宫格渲染成 div 的 CSS 背景图，而不是 <img>
function bgImageUrl(el) {
  try {
    let s = (el.getAttribute && el.getAttribute('style')) || '';
    if (!s && typeof getComputedStyle === 'function') {
      s = (getComputedStyle(el).backgroundImage || '').toString();
    }
    const hostPat = (SITE && SITE.imageHostPattern) || 'sinaimg\\.cn';
    const re = new RegExp(
      "url\\(['\"]?((?:https?:)?\\/\\/[^'\")\\s]+" + hostPat + "[^'\")\\s]+)['\"]?\\)", 'i');
    const m = re.exec(String(s).replace(/\\\//g, '/'));
    return m && isImageHost(m[1]) ? m[1] : '';
  } catch (e) { return ''; }
}

function collectContentImages(root, strict) {
  const urls = [];
  const push = (src) => {
    if (!src || !isImageHost(src)) return;
    if (isAvatarUrl(src)) return;
    if (/^data:image|\/loading|placeholder|blank\.gif|1x1/i.test(src)) return;
    // 宽松识别图片的站点要额外排除 logo / 二维码等装饰图
    if (SITE && SITE.allowGenericImages && /logo|icon|sprite|qrcode|banner/i.test(src)) return;
    if (strict && CONTENT_SIZE && !CONTENT_SIZE.test(src)) return;
    const up = upgradeImageUrl(src);
    if (up && !urls.includes(up)) urls.push(up);
  };
  try {
    root.querySelectorAll('img').forEach((im) => {
      // 头像/昵称链接里的图一律不算内容图
      if (im.closest && im.closest(AVATAR_LINK_SELECTOR)) return;
      push(pickImageSrc(im));
    });
    root.querySelectorAll('[style]').forEach((el) => push(bgImageUrl(el)));
    // 纯 CSS 类设置的背景图（没有 inline style）也要能采到
    root.querySelectorAll('div[class*="picture"], li[class*="picture"], div[class*="pic"], li[class*="pic"]')
      .forEach((el) => {
        if (el.getAttribute && el.getAttribute('style')) return;
        push(bgImageUrl(el));
      });
  } catch (e) {}
  return urls;
}

/*
 * 多图最容易漏采：微博把九宫格拆到多个媒体容器，旧代码只取
 * findMediaRoot() 命中的「第一个」容器，于是 3/9 张图只剩首图，
 * 托盘因为 images.length === 1 根本不会弹。改成遍历所有媒体容器
 * + 整卡严格兜底，按升级后的 large 地址去重合并。
 */
/*
 * 微博把九宫格的全部 pic_ids / pic_infos 放在 React props、内联 JSON 或
 * data-* 里，页面上往往只渲染首图（其余滚动/点开才加载）。从整卡 HTML
 * 里补抓内容图地址，才能一次拿到全部，而不是只转走第一张。
 */
function collectEmbeddedImageUrls(card) {
  const out = [];
  // 只有微博的尺寸段规则明确；其他站不做内联补抓，避免把整页推荐图采进来
  const tokens = SITE ? SITE.embeddedTokens
    : 'large|mw2000|mw2048|mw1024|mw690|orj1080|orj480|bmiddle|woriginal|original';
  if (!tokens) return out;
  try {
    const html = String(card.innerHTML || '')
      .replace(/\\\//g, '/').replace(/&amp;/g, '&')
      .replace(/\\u002F/gi, '/').replace(/\\u003A/gi, ':');
    const hostPat = (SITE && SITE.imageHostPattern) || 'sinaimg\\.cn';
    const re = new RegExp(
      '(?:https?:)?\\/\\/[\\w.-]*' + hostPat + '\\/(?:' + tokens +
      ')\\/[^\\s"\'<>,;)\\\\]+?\\.(?:jpg|jpeg|png|webp|gif)', 'gi');
    (html.match(re) || []).forEach((u) => {
      const full = u.startsWith('//') ? 'https:' + u : u;
      if (isAvatarUrl(full)) return;
      const up = upgradeImageUrl(full);
      if (up && !out.includes(up)) out.push(up);
    });
  } catch (e) {}
  return out;
}

function collectAllContentImages(card) {
  const out = [];
  const seen = new Set();
  const addAll = (root, strict) => {
    collectContentImages(root, strict).forEach((u) => {
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    });
  };
  MEDIA_SELECTORS.forEach((s) => {
    try { card.querySelectorAll(s).forEach((n) => addAll(n, false)); } catch (e) {}
  });
  addAll(card, true);
  // 内联数据补抓放在最后：DOM 里已渲染的图保持原顺序（首图仍是剪贴板那张）
  collectEmbeddedImageUrls(card).forEach((u) => {
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  });
  // 微博单条最多 9 张内容图；异常页面（推荐流/广告）不能无限采下去
  return out.slice(0, 9);
}

// ---------- 视频地址提取 ----------
// 微博视频有三种形态：直接 <video src=mp4>、<source src=mp4>、
// 播放器用 blob:(MSE) 而真实地址藏在 data-* / 内联 HTML 里。
// 三条路径都试；仍拿不到时由 offscreen 用 bid 走公开接口兜底。
function normUrl(u) {
  let v = String(u || '')
    .replace(/\\\//g, '/').replace(/&amp;/g, '&')
    .replace(/\\u002F/gi, '/').replace(/\\u003A/gi, ':')
    .trim();
  if (!v || /^blob:/i.test(v)) return '';
  if (v.startsWith('//')) return 'https:' + v;
  return /^https?:\/\//i.test(v) ? v : '';
}

function collectVideoUrls(card) {
  const out = [];
  const videoRe = (!SITE || SITE.id === 'weibo') ? /\.mp4|video\.weibocdn\.com/i : /\.mp4/i;
  const add = (u) => {
    const v = normUrl(u);
    if (v && videoRe.test(v) && !out.includes(v)) out.push(v);
  };
  try {
    card.querySelectorAll('video, source').forEach((v) => {
      add(v.getAttribute('src'));
      add(v.getAttribute('data-src'));
      add(v.src);
      add(v.currentSrc);
    });
  } catch (e) {}
  try {
    card.querySelectorAll('[data-src], [data-url], [data-video], [data-mp4], a[href]').forEach((el) => {
      ['data-src', 'data-url', 'data-video', 'data-mp4', 'href'].forEach((k) => add(el.getAttribute(k)));
    });
  } catch (e) {}
  // 兜底：整卡 HTML 里的 mp4 链接（React props / 内联 JSON 里常出现）
  try {
    const html = String(card.innerHTML || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    (html.match(/https?:\/\/[^"'\s<>]+?\.mp4[^"'\s<>]*/gi) || []).forEach(add);
  } catch (e) {}
  return out;
}

function hasVideoElement(card) {
  try { return card.querySelectorAll('video, [class*="video"]').length > 0; } catch (e) { return false; }
}

function extractUid(card) {
  try {
    const links = card.querySelectorAll('a[href]');
    for (const a of links) {
      const m = /weibo\.com\/(\d{5,})\/[A-Za-z0-9]{6,}/.exec(a.href || '');
      if (m) return m[1];
    }
    for (const a of links) {
      const m = /weibo\.com\/(?:u|n)\/(\d{5,})/.exec(a.href || '');
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

function extractBid(card) {
  try {
    for (const a of card.querySelectorAll('a[href]')) {
      const h = a.href || '';
      let m = /weibo\.com\/\d{5,}\/([A-Za-z0-9]{6,})/.exec(h);
      if (m) return m[1];
      m = /(?:m\.weibo\.cn\/status\/|\/detail\/|\/status\/)([A-Za-z0-9]{6,})/.exec(h);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

// 统一解析：按钮、文字、图片、视频、作者都来自同一个内容单元
function resolvePost(card) {
  const textNode = findTextNode(card);
  const text = bodyText(card, textNode);
  const imageUrls = collectAllContentImages(card);
  const videoUrls = collectVideoUrls(card);
  const hasVideo = hasVideoElement(card) || videoUrls.length > 0;
  // bid / uid 是微博专属的公开接口参数；其他站不能拿去请求 m.weibo.cn
  const isWeibo = !SITE || SITE.permalink === 'weibo';
  return {
    card, textNode, text, imageUrls, videoUrls, hasVideo,
    bid: isWeibo ? extractBid(card) : null,
    uid: isWeibo ? extractUid(card) : null
  };
}

/*
 * 微博首页无限滚动会复用 <article> 节点：往下滚后同一个 DOM 节点里的
 * 内容已经换成另一条博文，但旧按钮和旧数据还挂在上面。
 * 指纹只用「bid + 正文前 40 字」，故意不含图片地址 —— 懒加载填 src
 * 不应触发重建，否则滚动时按钮会不停闪烁。
 */
function postFingerprint(post) {
  return [post.bid || '', (post.text || '').slice(0, 40)].join('|');
}

// 轻量指纹：已注入的卡片在每轮扫描时只算 bid + 正文，不重复扫图片/视频/innerHTML
function quickFingerprint(card) {
  const tn = findTextNode(card);
  return postFingerprint({
    bid: extractBid(card),
    text: bodyText(card, tn)
  });
}

// ---------- 找卡片 + 注入按钮 ----------
function getCards() {
  // 合并所有选择器（而不是命中第一个就 break）：无限滚动插入的新卡片
  // 可能用不同容器，漏一种是「往下拉没按钮」的常见原因
  const set = new Set();
  for (const s of CARD_SELECTORS) {
    try { document.querySelectorAll(s).forEach((el) => set.add(el)); } catch (e) {}
  }
  const all = Array.from(set);
  return all.filter((c) => !all.some((o) => o !== c && o.contains && o.contains(c)));
}

function findAnchor(card, textNode) {
  if (!textNode) return null;
  const tag = (textNode.tagName || '').toUpperCase();
  if (tag === 'DIV' || tag === 'SECTION' || tag === 'P' || tag === 'ARTICLE') return textNode;
  let el = textNode.parentElement;
  for (let i = 0; i < 2 && el && el !== card; i++) {
    const t = (el.tagName || '').toUpperCase();
    if (t === 'DIV' || t === 'SECTION' || t === 'P') return el;
    el = el.parentElement;
  }
  return textNode;
}

function ensureRelative(el) {
  try {
    if (!el.style) return;
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    // 宿主自己已有定位上下文（absolute/fixed/relative）就不要改，避免破坏微博布局
    if (cs && cs.position && cs.position !== 'static') return;
    // important：微博的 CSS 常带更高优先级，普通 inline 会被覆盖导致按钮飘走
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty('position', 'relative', 'important');
    } else {
      el.style.position = 'relative';
    }
  } catch (e) {
    if (el.style) el.style.position = 'relative';
  }
}

/* 1.4.10：按钮已上移到编辑区上方外侧，若宿主正好 overflow:hidden 会被整条裁掉。
 * 只在真的检测到裁剪时才放开，没裁剪时一个样式都不碰，避免破坏 X 的布局。 */
function allowReplyToolsOutside(host) {
  try {
    if (!host || !host.style || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(host);
    if (!cs) return;
    const clipped = String(cs.overflow || '').indexOf('hidden') !== -1 ||
      String(cs.overflowY || '').indexOf('hidden') !== -1;
    if (!clipped) return;
    if (host.classList && host.classList.add) host.classList.add('wbx-reply-tools-host');
    else if (typeof host.style.setProperty === 'function') {
      host.style.setProperty('overflow', 'visible', 'important');
    }
  } catch (e) { /* 取不到样式就不动 X 的布局 */ }
}

function markNativeRepost(card) {
  const bar = card.querySelector('[node-type="feed_list_options"], .card-act, footer');
  const scope = bar || card;
  let n = 0;
  try {
    scope.querySelectorAll('a, button, li, span').forEach((el) => {
      if (n >= 1) return;
      const txt = (el.innerText || el.textContent || '').replace(/\s/g, '');
      if (txt.includes('转发') && !el.dataset.wbxMarked && el.className !== 'wbx-repost-btn') {
        el.dataset.wbxMarked = '1';
        el.classList.add('wbx-repost-mark');
        el.title = (el.title ? el.title + '；' : '') + '点内容右上角「一键转发」';
        n++;
      }
    });
  } catch (e) {}
}

function injectIntoCard(card) {
  /*
   * 修复：早退校验用 quickFingerprint(card)，保存的却曾经是
   * postFingerprint(post)（两者口径不同，bid/文本清洗结果常不一致）。
   * 结果每轮扫描都判定「内容变了」→ 删掉按钮再建 → 触发 MutationObserver
   * → 再扫描 → 无限自触发循环，按钮节点活不过几百毫秒，用户点击直接丢失。
   * 现在校验和保存统一用同一个 qfp，内容不变时一律早退、不再碰 DOM。
   */
  const qfp = quickFingerprint(card);
  // 1.3.1 起「AI 评论」按钮移到 X 回复填写区右侧，卡片上只留「一键转发」。
  const existing = card.querySelector('.wbx-btn-group') || card.querySelector('.wbx-repost-btn');
  const groupIntact = existing && (String(existing.className || '').indexOf('wbx-btn-group') === -1 ||
    (existing.querySelector && existing.querySelector('.wbx-repost-btn')));
  if (existing && groupIntact && card.contains(existing) && card.dataset.wbxFp === qfp) return;

  const post = resolvePost(card);
  if (!post.text && !post.imageUrls.length && !post.hasVideo) return;

  // 内容变了 / 按钮被框架删掉 → 移除旧按钮重建
  if (existing) { try { existing.remove(); } catch (e) {} }
  // 1.3.1 迁移：老版本把「AI 评论」挂在卡片正文里，全部清掉，改由回复区注入
  try {
    card.querySelectorAll('.wbx-comment-btn').forEach((n) => {
      if (!String(n.className || '').includes('wbx-reply-btn')) n.remove();
    });
  } catch (e) {}
  delete card.dataset.wbxInjected;

  // 纯图/纯视频微博可能没有正文节点：退化到媒体墙，它同样位于内容区而非作者行
  let anchorNode = post.textNode;
  if (!anchorNode) {
    const media = findMediaRoot(card);
    if (media !== card) anchorNode = media;
    else {
      const v = card.querySelector('video');
      if (v && v.parentElement) anchorNode = v.parentElement;
    }
  }
  if (!anchorNode) return;
  const host = findAnchor(card, anchorNode);
  if (!host || !host.appendChild) return;
  ensureRelative(host);
  markNativeRepost(card);

  const btn = document.createElement('button');
  btn.className = 'wbx-repost-btn';
  btn.type = 'button';
  btn.textContent = '一键转发';
  btn.title = 'TapePost · 整理正文与配图，手动发送到 X · v1.4.18';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 不用闭包里的 card：DOM 复用后它可能已不是当前这条；从按钮向上找真实宿主
    const liveCard = (btn.closest && btn.closest(CARD_SELECTORS.join(','))) || card;
    // 不缓存 post：点击瞬间重新解析，才能拿到滚动/懒加载后的真实正文和图片
    return onRepost(liveCard, btn);
  });

  const group = document.createElement('div');
  group.className = 'wbx-btn-group';
  group.appendChild(btn);

  host.appendChild(group);
  card.dataset.wbxFp = qfp;   // 与早退判断同口径，切勿改成 postFingerprint(post)
  card.dataset.wbxInjected = '1';
}

/* ---------- 1.3.1：X 回复填写区右侧的「AI 评论」按钮 ----------
 * 实测（2026-11-08，已登录 x.com）：点推文的「回复」会跳 /compose/post 弹窗，
 * 输入框 <div aria-label="Post text" role="textbox" contenteditable>，
 * 空值旁显示「Post your reply」，下方工具栏末尾是 Reply 按钮。
 * 主发推框也用 aria-label="Post text"，所以必须靠 Replying to / Post your reply
 * 这类上下文判定，不能只按选择器抓。按钮挂在输入框父容器（编辑区）右上角，
 * 选中候选后直接写回这个框，不再另开 intent 发推页。
 */
const REPLY_CFG = (SITE && SITE.reply) || {
  inputSelectors: ['div[aria-label="Post text"][role="textbox"]'],
  scopeSelectors: ['[role="dialog"]'],
  sendSelectors: ['[data-testid="tweetButtonInline"]'],
  replyHints: ['Replying to', 'Post your reply'],
  postHints: ["What's happening"]
};

function replyInputSelectors() {
  const custom = String((settings && settings.replyInputSelector) || '').trim();
  return custom ? custom.split(',').map((s) => s.trim()).filter(Boolean) : REPLY_CFG.inputSelectors;
}

function queryReplyNodes(selectors) {
  const out = [];
  const seen = new Set();
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      });
    } catch (e) { /* 单个选择器非法不影响其它 */ }
  }
  return out;
}

function nodeText(n) {
  if (!n) return '';
  try { return String(n.innerText || n.textContent || ''); } catch (e) { return ''; }
}

/* 判定用的大范围容器：向上找到包含「Replying to」或 Reply 发送按钮的那一层。
 * 挂按钮不用它（否则会飘到整个弹窗右上角），只用输入框的父容器。 */
function replyScopeOf(input) {
  let el = input && input.parentElement;
  let best = el;
  const hints = REPLY_CFG.replyHints || [];
  const sendSel = (REPLY_CFG.sendSelectors || []).join(',');
  for (let i = 0; i < 8 && el; i++) {
    const tag = String(el.tagName || '').toLowerCase();
    // 不能让 scope 一路涨到 body：否则「回复弹窗 + 首页主发推框」同页时，
    // 主发推框会读到弹窗里的 Replying to，被误判成回复框。
    if (tag === 'body' || tag === 'html') break;
    const t = nodeText(el);
    const hasHint = hints.some((h) => t.indexOf(h) !== -1);
    const hasSend = !!(sendSel && el.querySelector && el.querySelector(sendSel));
    const isDialog = el.getAttribute && /^(dialog)$/.test(String(el.getAttribute('role') || '')) ||
      String(el.getAttribute && el.getAttribute('aria-modal') || '') === 'true';
    if (hasHint || hasSend || isDialog) best = el;
    if (isDialog) break;
    el = el.parentElement;
  }
  return best || (input && input.parentElement);
}

/* 1.3.4：X 详情页的「内联回复框」刷新后不带「Replying to / Post your reply」
 * 文案，只剩一个文字为 Reply 的发送按钮。只靠文案线索会判定失败，
 * 用户就会看到「AI 评论按钮不见了 / 点了没反应」。 */
function hasReplySendButton(scope) {
  if (!scope || !scope.querySelectorAll) return false;
  try {
    const btns = Array.from(scope.querySelectorAll('button, [role="button"]'));
    return btns.some((b) => /^(?:Reply|回复)$/i.test(String(nodeText(b) || '').trim()));
  } catch (e) { return false; }
}

function isReplyInput(input, scope) {
  if (!input) return false;
  // 插件自己的候选面板里也可能有 textbox，别把它当回复框
  if (input.closest && input.closest('[id="wbx-comments"]')) return false;
  const blob = nodeText(scope) + ' ' + nodeText(input) + ' ' +
    String((input.getAttribute && input.getAttribute('aria-label')) || '') + ' ' +
    String((input.getAttribute && input.getAttribute('data-placeholder')) || '');
  const hints = REPLY_CFG.replyHints || [];
  const postHints = REPLY_CFG.postHints || [];
  const hasReply = hints.some((h) => blob.indexOf(h) !== -1);
  const hasMain = postHints.some((h) => blob.indexOf(h) !== -1);
  const inDialog = !!(input.closest && input.closest('[role="dialog"],[aria-modal="true"]'));
  const inlineSend = !!(scope && scope.querySelector &&
    scope.querySelector((REPLY_CFG.sendSelectors || []).join(',')));
  return (hasReply || inlineSend || hasReplySendButton(scope) || (inDialog && !hasMain)) && !hasMain;
}

function findReplyComposers() {
  const out = [];
  for (const input of queryReplyNodes(replyInputSelectors())) {
    const scope = replyScopeOf(input);
    if (!isReplyInput(input, scope)) continue;
    const host = (input.parentElement && input.parentElement.appendChild) ? input.parentElement : input;
    out.push({ input: input, scope: scope, host: host });
  }
  return out;
}

function injectedReplyButtons() {
  try { return Array.from(document.querySelectorAll('.wbx-reply-btn')); }
  catch (e) { return []; }
}

function injectedPromoBars() {
  try { return Array.from(document.querySelectorAll('.wbx-promo-bar')); }
  catch (e) { return []; }
}

function currentPromoCustom() {
  return {
    tapeout: settings.promoCustomTapeOut || '',
    bem: settings.promoCustomBEM || ''
  };
}

/* 1.4.8：只保留一个 T 按钮 —— 每次点击从「内置 + 自定义」池里随机取一句，
 * 并排除上一次那句，保证连点不会出现同一句、也不会叠加第二句。 */
function nextQuickPromoLine(prev, extra) {
  if (typeof TapePromo === 'undefined') return '';
  const p = TapePromo.pools(currentPromoCustom());
  const target = settings.promoTarget || 'both';
  const all = (target === 'tapeout') ? p.tapeout
    : (target === 'bem') ? p.bem
      : p.tapeout.concat(p.bem);
  const unique = all.filter((x, i) => x && all.indexOf(x) === i);
  // extra 是「当前回复框末尾实际那句」：用户手工改过 / 删过之后也要排除它，
  // 否则点 T 可能随机到同一句，看起来像「点了没反应」。
  const usable = unique.filter((x) => x !== prev && x !== extra);
  const pool = usable.length ? usable : unique.filter((x) => x !== extra);
  const finalPool = pool.length ? pool : unique;
  return finalPool[Math.floor(Math.random() * finalPool.length)] || '';
}

function injectAiButton(c) {
  const host = c.host;
  if (!host || !host.appendChild) return;
  // 内容不变时一律早退：注入按钮本身会触发 MutationObserver，删了重建会自触发死循环。
  // 但每轮扫描都要把按钮重新绑到「当前这个」输入框：X 会复用 DOM 节点，
  // 缓存的旧引用会把候选写进另一个评论区。
  let btn = Array.prototype.filter.call(host.children || [],
    (n) => String(n.className || '').indexOf('wbx-reply-btn') !== -1)[0];
  if (!btn) {
    ensureRelative(host);
    btn = document.createElement('button');
    btn.className = 'wbx-comment-btn wbx-reply-btn';
    btn.type = 'button';
    btn.textContent = 'AI 评论';
    btn.title = 'TapePost · 生成 3 条回复候选，手动发送';
    btn.__wbxReply = true;
    /* 1.4.9：mousedown 默认会把焦点从 contenteditable 抢到按钮上，
     * 之后 execCommand('insertText') 就没有正确的编辑目标 → 文字写不进回复框。 */
    btn.addEventListener('mousedown', (e) => { if (e.preventDefault) e.preventDefault(); });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 点击瞬间实时定位，避免 X 重渲染后闭包里拿到旧的回复框
      const list = findReplyComposers();
      const live = list.find((x) => x.input === btn.__wbxInput) ||
        list.find((x) => x.scope === btn.__wbxScope);
      const ctx = resolveReplyContext(btn, live && live.scope);
      return onAiComment(ctx, btn);
    });
    host.appendChild(btn);
  }
  btn.__wbxInput = c.input;
  btn.__wbxScope = c.scope;
}

/* =========================================================================
 * 1.4.8：T 按钮写回 —— 只发一次「原生编辑命令」，绝不自己改 DOM。
 *
 * 真机复盘（X 详情页）：1.4.7 点 T 后回复框里只剩一句推广语、用户写的正文
 * 整段消失；再点又出现重复。根因有三条：
 *  ① 用 textContent 拼全文算索引，但 X 把换行渲染成 <br>（没有文本节点），
 *     算出来的字符偏移与真实编辑器对不上；
 *  ② matchTail 的模糊匹配会把「正文 + 推广句」整段判成推广句 → start=0 → 全删；
 *  ③ range.deleteContents() / textContent= 直接改 DOM，X 的受控编辑器
 *     state 不同步，下一次输入就把旧文字还原回来 → 重复、乱序。
 *
 * 1.4.8 的五条硬规则：
 *  ① 不 innerText 拼全文重写、不 selectAll、不 range.deleteContents、
 *     不 textContent= / innerText=、不派发合成 InputEvent；
 *  ② 只用 document.execCommand('insertText' / 'delete')，让编辑器自己走
 *     beforeinput → 同步内部 state；
 *  ③ 只选中「末尾那一句」的字符范围，正文分段 / @ / emoji / 配图一律不动；
 *  ④ 末尾识别只做「与内置 / 自定义话术完全一致」的精确匹配，认不出就不写、
 *     只提示并复制，绝不模糊猜、绝不追加成第二句；
 *  ⑤ 回复框由按钮所在容器实时定位，不缓存 scope、不 fallback 到别的框。
 * ========================================================================= */
/* 1.4.9：不再用「上次带入的是哪句」这种额外状态做判断。
 * 一切以点击瞬间回复框里的真实文本为准，用户手工删改后立刻能恢复正常工作。 */

/* 手写递归收集文本节点：不依赖 TreeWalker，X 改版或老环境都能工作。
 * 跳过插件自己注入的按钮 / 候选面板，避免把 UI 文案算进正文。 */
function collectReplyTextNodes(root, out) {
  const kids = root && root.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (!n) continue;
    if (n.nodeType === 3) {
      const t = String(n.nodeValue == null ? '' : n.nodeValue);
      if (!t) continue;
      const owner = n.parentElement;
      if (owner && owner.closest &&
          owner.closest('.wbx-promo-bar,.wbx-reply-btn,[id="wbx-comments"]')) continue;
      out.push({ node: n, text: t });
    } else if (n.nodeType === 1 && n.childNodes) {
      const cls = String(n.className || '');
      if (cls.indexOf('wbx-promo-bar') !== -1 || cls.indexOf('wbx-reply-btn') !== -1 ||
          n.id === 'wbx-comments') continue;
      collectReplyTextNodes(n, out);
    }
  }
  return out;
}

function replyTextNodes(input) {
  try { return input ? collectReplyTextNodes(input, []) : []; }
  catch (e) { return []; }
}

function replyPlainText(input) {
  const nodes = replyTextNodes(input);
  return nodes.length ? nodes.map((x) => x.text).join('') : nodeText(input);
}

function pointInNodes(nodes, idx) {
  let acc = 0;
  for (let i = 0; i < nodes.length; i++) {
    const len = nodes[i].text.length;
    if (idx <= acc + len) {
      return { node: nodes[i].node, offset: Math.max(0, Math.min(len, idx - acc)) };
    }
    acc += len;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last.node, offset: last.text.length } : null;
}

/* 末尾精确识别：只认与内置 / 自定义话术一字不差的一整句。
 * 用户改过标点、删过字就返回 '' —— 此时不写、不删、不乱猜。 */
function knownPromoLines() {
  if (typeof TapePromo === 'undefined') return [];
  const p = TapePromo.pools(currentPromoCustom());
  return p.tapeout.concat(p.bem).filter(Boolean);
}

function findTrailingPromo(full) {
  if (!full) return '';
  const t = (typeof TapePromo !== 'undefined') ? TapePromo.rtrim(full) : String(full).trim();
  let best = '';
  knownPromoLines().forEach((l) => {
    if (l.length > best.length && t.slice(-l.length) === l) best = l;
  });
  return best;
}

function fullContainsKnownPromo(full) {
  if (!full) return false;
  return knownPromoLines().some((l) => full.indexOf(l) >= 0);
}

/* 1.4.10：数一数回复框里到底有几句已知推广句。
 * 真机截图里同一句「顺带一提：TapeOut 把 NAND…」出现了两遍并粘在一起，
 * 之后每点一次 T 都可能再叠一句。只要已经多于一律停手，绝不继续自动写。 */
function countKnownPromo(full) {
  if (!full) return 0;
  let n = 0;
  knownPromoLines().forEach((l) => {
    if (!l) return;
    let i = full.indexOf(l);
    while (i >= 0) { n++; i = full.indexOf(l, i + l.length); }
  });
  return n;
}

/* 1.4.10：写回结束（成功、失败、中途停手）都必须把选区收成一个光标点。
 * selectReplyTail 会选中末尾整句；如果 execCommand 被 X 吃掉或用户中途点了别处，
 * 那段字会一直保持灰色选中态，下一次输入从选区开始替换 → 正文重复、手动改就乱。 */
function collapseReplySelection() {
  try {
    if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || typeof sel.getRangeAt !== 'function') return;
    const r = sel.getRangeAt(0);
    if (!r || typeof r.collapse !== 'function') return;
    r.collapse(false);                       // 收拢到选区末尾
    if (sel.removeAllRanges) sel.removeAllRanges();
    if (sel.addRange) sel.addRange(r);       // 保留一个折叠的光标，别让编辑器失焦
  } catch (e) { /* 测试桩 / 老环境没有完整 Selection 就跳过 */ }
}

/* 1.4.9：末尾那句是否被用户手工改写过 —— 只用于「停手」，绝不用于删除。
 * 1.4.8 只做全文精确包含判断：用户改了一个标点就认不出来，插件会把改过的
 * 推广句当成普通正文再叠一句新的，看起来就是「手动改就乱」。
 * 只在最后一段里比对，要求归一化相同或高相似度；从不删任何字符。 */
function hasEditedPromoTail(full) {
  if (!full || typeof TapePromo === 'undefined') return false;
  const parts = TapePromo.rtrim(full).split(/[\r\n]+/);
  const tail = parts[parts.length - 1] || '';
  if (tail.length < 8) return false;
  const nt = TapePromo.normalize(tail);
  const known = knownPromoLines();
  for (let i = 0; i < known.length; i++) {
    const line = known[i];
    if (nt && nt === TapePromo.normalize(line)) return true;
    if (TapePromo.similarity(tail, line) >= 0.86) return true;
    // 分隔符被手工删掉时，推广句会跟正文粘在同一段
    if (tail.length > line.length &&
        TapePromo.similarity(tail.slice(-line.length), line) >= 0.9) return true;
  }
  return false;
}

/* 1.4.9：注入时就把「这个按钮属于哪个输入框」记下来，点击时直接用它。
 * 旧版按 host.querySelectorAll(...)[0] 抓第一个，X 详情页一个容器里套着
 * 多个 textbox 时就会写到另一个评论区（真机「文字没写对在回复框」）。 */
function isLiveReplyInput(el, bar) {
  if (!el || !el.parentElement) return false;
  // 按钮和输入框必须挂在同一个 host；否则宁可不写，也绝不跨区乱写
  if (bar && bar.parentElement && el.parentElement !== bar.parentElement) return false;
  try {
    if (typeof document !== 'undefined' && document.contains && !document.contains(el)) return false;
  } catch (e) { /* 测试桩没有 contains */ }
  return true;
}

function promoInputFor(bar) {
  const bound = bar && bar.__wbxInput;
  if (isLiveReplyInput(bound, bar)) return bound;
  const host = bar && bar.parentElement;
  if (!host || typeof host.querySelectorAll !== 'function') return null;
  const sels = replyInputSelectors().concat([
    '[contenteditable="true"][role="textbox"]', '[role="textbox"][contenteditable]'
  ]);
  const found = [];
  for (let i = 0; i < sels.length; i++) {
    let list;
    try { list = host.querySelectorAll(sels[i]); } catch (e) { continue; }
    for (let j = 0; j < list.length; j++) {
      const el = list[j];
      if (!el || found.indexOf(el) !== -1) continue;
      if (el.closest && el.closest('#wbx-comments')) continue;
      found.push(el);
    }
  }
  // 容器里有多于一个输入框时不敢猜：让用户点进要写的那个框再按 T
  if (found.length !== 1) return null;
  return isLiveReplyInput(found[0], bar) ? found[0] : null;
}

function applyReplySelection(input, range) {
  try {
    if (input.focus) input.focus();
    if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
    const sel = window.getSelection();
    if (!sel || !sel.removeAllRanges || !sel.addRange) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch (e) { return false; }
}

/* 光标移到编辑器末尾（首次带入用） */
function selectReplyEnd(input) {
  try {
    if (typeof document.createRange !== 'function') return false;
    const r = document.createRange();
    if (!r.selectNodeContents || !r.collapse) return false;
    r.selectNodeContents(input);
    r.collapse(false);
    return applyReplySelection(input, r);
  } catch (e) { return false; }
}

/* 只选中末尾 count 个字符（换句 / 清除用），绝不碰 <br>、绝不覆盖正文。
 * trailingJunk：X 常在末尾放零宽占位符，识别时已 rtrim 掉，这里要把它们
 * 排除在选区之外，否则会少选推广句的最后一个字、留下半句。 */
function selectReplyTail(input, count, trailingJunk) {
  try {
    const nodes = replyTextNodes(input);
    const total = nodes.reduce((n, x) => n + x.text.length, 0);
    const end = total - (trailingJunk || 0);
    if (!count || end < count || typeof document.createRange !== 'function') return false;
    const a = pointInNodes(nodes, end - count);
    const b = pointInNodes(nodes, end);
    if (!a || !b) return false;
    const r = document.createRange();
    if (!r.setStart || !r.setEnd) return false;
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return applyReplySelection(input, r);
  } catch (e) { return false; }
}

/* 唯一的写入口：浏览器原生编辑命令，触发真实 beforeinput / input。
 * 失败就返回 false，绝不退回「直接改 DOM」的兜底。 */
function nativeReplyEdit(input, command, text) {
  try {
    if (typeof document.execCommand !== 'function') return false;
    if (command === 'delete') return !!document.execCommand('delete');
    return !!document.execCommand('insertText', false, String(text == null ? '' : text));
  } catch (e) { return false; }
}

function copyPromoLine(line) {
  if (!line) return;
  try {
    // 纯文本复制：不要走带图片的剪贴板通道，避免 ClipboardItem 在页面里抛异常
    if (typeof copyTextFallback === 'function') copyTextFallback(line);
    else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(line);
  } catch (e) { /* 剪贴板不可用时只靠提示 */ }
}

/* ==========================================================================
 * 1.4.11：唯一的写入口 —— 一次「全量替换」，等价于用户自己按 Cmd+A 后重新输入。
 *
 * 真机取证（v1.4.10 仍复现）：回复框里同一句推广句粘着出现两遍、之后整个框
 * 不可编辑。根因不是「没重载」，而是旧写法用跨文本节点的局部 Range 选中末尾
 * 那句再 delete / insertText。X 的受控编辑器不认这种外部选区：
 *   - insertText 退化成「在当前光标处追加」→ 换句变成叠加第二句；
 *   - 局部删除 + 外部选区让编辑器 state 与 DOM 失步 → 之后打字没反应。
 * 现在只做一次标准选区（selectNodeContents = 全选，用户级操作）+ 一次
 * insertText，把「完整最终文本」先算好再写；绝不局部删改、绝不重试。
 * ========================================================================== */
function rewriteReplyOnce(input, finalText) {
  try {
    if (!input || typeof document.execCommand !== 'function') return false;
    if (input.focus) input.focus();
    if (typeof document.createRange !== 'function' ||
        typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
    const sel = window.getSelection();
    if (!sel || !sel.removeAllRanges || !sel.addRange) return false;
    const r = document.createRange();
    if (!r.selectNodeContents) return false;
    r.selectNodeContents(input);
    sel.removeAllRanges();
    sel.addRange(r);
    return !!document.execCommand('insertText', false, String(finalText == null ? '' : finalText));
  } catch (e) { return false; }
}

/* 富文本保护：正文里有 @ 提及、emoji 图片、链接卡片、配图时，全量纯文本重写
 * 会把它们丢掉。这种时候一律降级为「只复制推广句，用户自己粘贴」。 */
function replyHasRichContent(input) {
  try {
    if (!input || typeof input.querySelectorAll !== 'function') return false;
    const sel = 'img, a[role="link"], [contenteditable="false"], [data-testid="emoji"], [data-testid^="tweetPhoto"]';
    return input.querySelectorAll(sel).length > 0;
  } catch (e) { return false; }
}

/* X 会把 \n 变成 <br> / 新段落，而 replyPlainText 跳过 <br>，所以比较时
 * 统一去掉所有空白，只校验「内容字符序列」是否一字不差。 */
function normReplyText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

/* line 为空 = 右键清除推广句；否则 = 带入 / 换一句。 */
function applyQuickPromo(bar, line) {
  if (!bar || bar.__wbxBusy) return;   // 连点 / 事件冒泡重复触发，一律只处理一次
  bar.__wbxBusy = true;
  try {
    if (typeof TapePromo === 'undefined') return;
    const input = promoInputFor(bar);
    if (!input) {
      showToast('没找到当前回复框：请先点开「回复」，或刷新 X 页面后重试。', 6000);
      return;
    }
    const full = TapePromo.rtrim(replyPlainText(input));
    const tail = findTrailingPromo(full);                 // 精确：一字不差才认
    const body = TapePromo.rtrim(tail ? full.slice(0, full.length - tail.length) : full);

    /* 1.4.11：安全模式 / 含富文本时完全不碰编辑器，只复制 + 聚焦。
     * 这是 100% 不会弄乱正文的退路，手动粘贴后回复框始终可编辑。 */
    if (settings.promoCopyOnly === true || replyHasRichContent(input)) {
      copyPromoLine(line || tail || '');
      if (input.focus) input.focus();
      showToast(settings.promoCopyOnly === true
        ? '安全模式：推广句已复制，光标已回到回复框，按 Cmd/Ctrl+V 粘贴即可（不会改动你写的内容）。'
        : '回复里有 @ / 表情 / 配图，为避免弄丢它们已停止自动写入；推广句已复制，请自行粘贴。', 6000);
      return;
    }

    /* 已有 >=2 句推广句：一律停手，绝不继续自动写，避免越点越乱。 */
    if (line && countKnownPromo(full) > 1) {
      copyPromoLine(line);
      showToast('回复框里已经有不止一句推广句，已停止写入；请右键 T 去掉末尾那句，或手动删掉多余的一句。', 7000);
      return;
    }

    /* 话术还在、但不在末尾或被手工改写：无法安全定位，停手不删任何字符。 */
    if (!tail && (fullContainsKnownPromo(full) || hasEditedPromoTail(full))) {
      copyPromoLine(line);
      showToast(line
        ? '推广句已被手工改动或不在末尾，为避免弄乱正文已停止写入；新句已复制，请自行粘贴 / 删旧句。'
        : '推广句已被手工改动，已停止自动删除，请手动删掉那一行。', 7000);
      bar.__wbxPromoLine = '';
      return;
    }

    if (!line && !tail) { showToast('当前回复框末尾没有可去掉的推广句。', 3000); return; }

    // 随机到当前末尾那句时再取一次，保证「点一下一定换一句」
    if (line && tail && tail === line) {
      const alt = nextQuickPromoLine(tail, tail);
      if (!alt || alt === tail) {
        showToast('话术池里只有这一句，暂时换不了；可以在设置里补充自定义话术。', 3500);
        return;
      }
      line = alt;
    }

    // 完整最终文本：正文一个字不改，推广句单独成一段（\n\n），或右键只留正文
    // 分隔符用本地常量：TapePromo 的共享 API 不暴露 SEP，取不到会拼出 "undefined"
    const finalText = line ? (body ? body + '\n\n' + line : line) : body;
    if (normReplyText(finalText) === normReplyText(full)) {
      showToast('内容没有变化，未写入。', 2500);
      return;
    }

    if (!rewriteReplyOnce(input, finalText)) {
      rewriteReplyOnce(input, full);          // 尽力把原文写回去，绝不留下半截状态
      copyPromoLine(line);
      showToast('X 编辑器拒绝了写入，已恢复原文；推广句已复制，请手动粘贴。', 7000);
      return;
    }

    // 写后只读校验：异常只恢复 + 提示，绝不重试（重试正是重复的来源）
    const after = TapePromo.rtrim(replyPlainText(input));
    const prefixOk = !body || normReplyText(after).indexOf(normReplyText(body)) === 0;
    const once = !line || after.split(line).length - 1 === 1;
    const sane = prefixOk && once && normReplyText(after) === normReplyText(finalText);
    if (!sane) {
      rewriteReplyOnce(input, full);
      copyPromoLine(line);
      showToast('写入结果不对，已恢复原文；推广句已复制到剪贴板，请手动粘贴。', 7000);
      return;
    }

    bar.__wbxPromoLine = line;
    showToast(line
      ? '已带入推广句（单独一段）；再点一次 T 换一句，右键可去掉。'
      : '已去掉推广句，你写的正文一个字都没动。', 3000);
  } finally {
    collapseReplySelection();   // 成功 / 失败 / 中途停手都不留灰色选中块
    bar.__wbxBusy = false;
  }
}

/* 1.4.9：整个 X 页面只有一个 T 按钮，只挂在「当前正在编辑的回复框」右侧。
 * 左键 = 随机带入 / 换一句（排除当前末尾那句）；右键 = 去掉末尾推广句。
 * 注入时绑定真实 input，点击时不再重新猜输入框。 */
function injectPromoBar(c) {
  const host = c.host;
  if (!host || !host.appendChild) return;
  let bar = Array.prototype.filter.call(host.children || [],
    (n) => String(n.className || '').indexOf('wbx-promo-bar') !== -1)[0];
  if (!bar || bar.parentElement !== host) {
    ensureRelative(host);
    bar = document.createElement('div');
    bar.className = 'wbx-promo-bar';
    bar.__wbxPromoLine = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wbx-promo-btn wbx-promo-single';
    b.textContent = 'T';
    b.title = 'TapePost v1.4.18 · 点一下随机带入一句推广，再点换一句（不重复、不动正文）；右键去掉推广句';
    // 保住 contenteditable 的焦点与选区：mousedown 默认行为会让按钮抢焦点，
    // 之后 insertText 就写不进这个回复框了（真机「文字没写对」的根因之一）。
    b.addEventListener('mousedown', (e) => { if (e.preventDefault) e.preventDefault(); });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = promoInputFor(bar);
      const tail = input ? findTrailingPromo(TapePromo.rtrim(replyPlainText(input))) : '';
      applyQuickPromo(bar, nextQuickPromoLine(bar.__wbxPromoLine || '', tail));
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyQuickPromo(bar, '');
    });
    bar.appendChild(b);
    host.appendChild(bar);
  }
  // 每轮扫描刷新绑定：X 复用 DOM 节点时，按钮不会还指向上一个回复框
  bar.__wbxInput = c.input;
  bar.__wbxScope = c.scope;
}

/* 1.4.9：全局只保留「一组」回复区按钮（AI 评论 + T）。
 * 旧版对 findReplyComposers() 里的每个 composer 都注入一遍，X 详情页同时
 * 存在主回复框 / 嵌套回复框 / 引用框时就会冒出一排按钮，点哪个都可能
 * 写进另一个框 —— 真机反馈「很多按钮」「文字没写对在回复框」。 */
let lastFocusedReplyInput = null;
try {
  document.addEventListener('focusin', (e) => {
    const t = e && e.target;
    if (!t) return;
    if (t.isContentEditable || (t.getAttribute && t.getAttribute('role') === 'textbox')) {
      lastFocusedReplyInput = t;
    }
  }, true);
} catch (e) { /* 环境不支持 focusin 时退化为 activeElement + 单 composer 判定 */ }

function pickActiveComposer(composers) {
  if (!composers || !composers.length) return null;
  const active = (typeof document !== 'undefined') ? document.activeElement : null;
  const byFocus = composers.find((c) => c.input === active);
  if (byFocus) return byFocus;
  if (lastFocusedReplyInput) {
    const byLast = composers.find((c) => c.input === lastFocusedReplyInput);
    if (byLast) return byLast;
  }
  if (composers.length === 1) return composers[0];
  // 多个回复框、又没明确焦点：优先弹窗里的那个；再不明确就先不挂按钮，
  // 等用户点进某个框（focusin）再出现，绝不随便挑一个把字写错地方。
  return composers.find((c) => c.input.closest &&
    c.input.closest('[role="dialog"],[aria-modal="true"]')) || null;
}

function injectIntoReplyComposers() {
  if (!SITE || SITE.id !== 'x') return;
  const aiOn = settings.enableAiComment !== false;
  const quickOn = settings.promoQuickButtons !== false;
  // 关掉开关时只清自己那一类，不动页面上其它插件的按钮
  if (!aiOn) injectedReplyButtons().forEach((n) => { if (n.remove) n.remove(); });
  if (!quickOn) injectedPromoBars().forEach((n) => { if (n.remove) n.remove(); });
  if (!aiOn && !quickOn) return;
  const composers = findReplyComposers();
  const target = pickActiveComposer(composers);
  const host = target && target.host;

  // 凡是没挂在目标 host 上的按钮一律清掉：页面里永远只有一组
  [injectedReplyButtons(), injectedPromoBars()].forEach((list) => {
    list.forEach((n) => {
      if (!host || n.parentElement !== host) { if (n.remove) n.remove(); }
    });
  });
  if (!host) return;
  /* 1.3.4 关键修复：host.children 是 HTMLCollection，没有 .filter！
   * 每轮扫描都往回复框里再塞按钮会累积到 33 个，按钮文字还会被当成推文正文。 */
  ['wbx-reply-btn', 'wbx-promo-bar'].forEach((cls) => {
    const mine = Array.prototype.filter.call(host.children || [],
      (x) => String(x.className || '').indexOf(cls) !== -1);
    for (let i = 1; i < mine.length; i++) { if (mine[i].remove) mine[i].remove(); }
  });
  allowReplyToolsOutside(host);        // 只在宿主裁剪溢出时放开，避免上移后的按钮被裁掉
  if (aiOn) injectAiButton(target);
  if (quickOn) injectPromoBar(target);
}

/* 回复弹窗里被回复的推文正文：优先弹窗内的 article，其次按钮所在 article，
 * 再退到详情页的 tweetDetail。找不到时 onAiComment 会给出明确提示。 */
function resolveReplyContext(btn, scope) {
  try {
    if (scope && scope.querySelector) {
      const a = scope.querySelector('article[data-testid="tweet"],[data-testid="tweetDetail"],article');
      if (a) return a;
    }
    if (btn && btn.closest) {
      const a = btn.closest('article');
      if (a) return a;
    }
    return document.querySelector('[data-testid="tweetDetail"]') || null;
  } catch (e) { return null; }
}

/* 把候选写进 X 的 contenteditable 回复框。execCommand('insertText') 会触发
 * 真实 input 事件，React 受控组件能识别（1.3.0 的 Grok 输入框已验证同一机制）。
 * 框里已有草稿时追加一行，绝不静默覆盖用户写的内容。 */
function writeIntoReply(input, text) {
  if (!input || !text) return false;
  try {
    /* 1.4.11：与 T 按钮统一走「一次全量替换」，不再用「折叠光标 + 追加」。
     * 追加式 insertText 在 X 的受控编辑器里会插入半截 state，表现为文字
     * 重复 / 之后不可编辑；含富文本时直接拒绝，交由候选面板的复制兜底。 */
    if (replyHasRichContent(input)) return false;
    const existing = nodeText(input).trim();
    const finalText = existing ? existing + '\n\n' + text : text;
    const ok = rewriteReplyOnce(input, finalText);
    if (!ok) rewriteReplyOnce(input, existing);   // 失败时恢复原文
    collapseReplySelection();
    return ok;
  } catch (e) { collapseReplySelection(); return false; }
}

function applyCommentToReply(text, btn) {
  if (!btn || !btn.__wbxReply) return false;
  // 1.4.9：按钮注入时绑定的那个输入框优先；不再 fallback 到 list[0]
  const bound = btn.__wbxInput;
  if (bound && bound.parentElement) {
    try {
      if (typeof document !== 'undefined' && document.contains && !document.contains(bound)) return false;
    } catch (e) { /* 测试桩没有 contains */ }
    return writeIntoReply(bound, text);
  }
  const list = findReplyComposers();
  const target = list.find((c) => c.input === bound) ||
    list.find((c) => c.scope === btn.__wbxScope);
  return target ? writeIntoReply(target.input, text) : false;
}

/* 插件自己打开的 X 发布页不注入「一键转发」按钮：否则发推框里会再叠一个。
 * 1.3.1：/compose/post 也是用户点「回复」后的弹窗页，卡片按钮同样不注入，
 * 但「AI 评论」要照常注入到回复框右侧——这两件事拆开处理。
 * 只放在扫描入口判定（不放 init），X 是 SPA，返回时间线后还能恢复扫描。 */
function isXIntentPage() {
  if (!SITE || SITE.id !== 'x') return false;
  const p = String(PAGE_PATH || '/').toLowerCase();
  return p.indexOf('/intent/') === 0 || p.indexOf('/i/flow/') === 0 ||
    p.indexOf('/compose/') === 0;
}

function scanAndInject() {
  if (!isXIntentPage()) {
    try { getCards().forEach(injectIntoCard); } catch (e) { /* ignore */ }
  }
  // 回复框可能在时间线内联展开，也可能在 /compose/post 弹窗里，两种都要扫
  try { injectIntoReplyComposers(); } catch (e) { /* ignore */ }
}

// ---------- 点击处理 ----------
// 重新加载扩展后，页面里旧的 content script 会变成「孤儿上下文」，
// 此时任何 chrome.* 调用都会抛 Extension context invalidated。
// 提前判定并给出可操作提示，避免只看到一句笼统报错。
function isStaleContext() {
  try {
    // 上下文失效时访问 chrome.runtime 本身就会抛 Extension context invalidated；
    // 用 sendMessage 是否可用来判定，比依赖 runtime.id 更稳（部分环境不暴露 id）。
    return !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function';
  } catch (e) {
    return true;
  }
}

async function onRepost(card, btn) {
  if (isStaleContext()) {
    showToast(`插件刚重新加载过，旧按钮已失效：请刷新${SITE_LABEL}页面（Cmd+R）后再点「一键转发」。`, 9000);
    return;
  }
  // 每次点击都重新解析：解决「滚动后 DOM 复用导致转到旧内容」和「图片懒加载」
  const post = resolvePost(card);
  const { imageUrls: urls, videoUrls, hasVideo, bid } = post;
  // 「删 # 后内容」是微博话题规则；其他站一律保留原文，避免误删正文
  const hashMode = (!SITE || SITE.id === 'weibo') ? settings.hashMode : 'keep';
  const cleaned = cleanRepostText(post.text, hashMode);
  const text = withSource(withSignature(cleaned), card);
  const inpaintImages = !!settings.inpaintImages;
  const inpaintVideo = !!settings.inpaintVideo;
  // 只有微博的水印检测规则明确；其他站水印压在图上/位置不固定，原图保留最安全
  const wmEnabled = (!SITE || SITE.watermark === 'detect') ? inpaintImages : false;
  // 视频 HD 原片接口是微博专属，其他站直接取页面直链
  const videoHd = (!SITE || SITE.videoApi === 'weibo') ? inpaintVideo : false;
  if (!cleaned && !urls.length && !hasVideo) {
    showToast(`未识别到本条内容的正文、内容图或视频（${SITE_LABEL}结构可能改版），已取消转发。`, 8000);
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 处理中…'; }

  const preview = cleaned ? (cleaned.length > 28 ? cleaned.slice(0, 28) + '…' : cleaned) : '（无正文）';
  const cleanedNote = (hashMode !== 'keep' && post.text !== cleaned && /[#＃]/.test(post.text)) ? '（已删 # 后内容）' : '';
  const sigNote = settings.appendSignature ? '｜含署名' : '';
  const wmNote = `｜图${wmEnabled ? '去水印' : '原图'}｜视频${videoHd ? '去水印' : '原片'}`;
  showToast(`处理中｜${SITE_LABEL}｜正文：${preview}${cleanedNote}${sigNote}｜内容图 ${urls.length} 张｜视频 ${hasVideo ? 1 : 0} 个${wmNote}`);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'CROSSPOST',
      payload: {
        text,
        imageUrls: urls,
        videoUrls,
        hasVideo,
        bid,
        inpaint: wmEnabled ? { enabled: true } : { enabled: false },
        inpaintVideo: videoHd
      }
    });
    if (btn) { btn.disabled = false; btn.textContent = '一键转发'; }
    await handleResult(resp || {});
  } catch (e) {
    const why = String(e && e.message || e);
    if (/Extension context invalidated|Receiving end does not exist|Could not establish connection/i.test(why)) {
      showToast(`插件后台连接断开（多半是刚重新加载过扩展）：请刷新${SITE_LABEL}页面 Cmd+R，再点「一键转发」；仍不行就到 chrome://extensions 重新加载一次。`, 10000);
    } else {
      showToast('发送失败：' + why, 8000);
    }
    if (btn) { btn.disabled = false; btn.textContent = '一键转发'; }
  }
}

// ---------- X 一键评论：Grok 生成 3 条候选，选一条后由用户手动回复 ----------
/*
 * 与「一键转发」保持同一套原则：插件只生成 / 写入，绝不自动发布。
 * 1.3.1 主路径：按钮就在回复填写区右侧，选中候选后直接写进当前回复框，
 * 不再另开 intent 发推页。找不到回复框 / 写入失败时才退回 intent 预填 +
 * 剪贴板兜底，保证功能不会倒退。
 */
function extractXStatusId(card) {
  try {
    const m = /\/status\/(\d+)/.exec(extractPermalink(card));
    if (m) return m[1];
  } catch (e) {}
  try {
    const m = /\/status\/(\d+)/.exec(String(PAGE_PATH || ''));
    if (m) return m[1];
  } catch (e) {}
  return '';
}

/* 回复弹窗页 URL 是 /compose/post，没有 status id；从弹窗里的原推链接取。 */
function extractXStatusIdFromScope(scope) {
  try {
    const a = scope && scope.querySelector && scope.querySelector('a[href*="/status/"]');
    if (a) {
      const m = /\/status\/(\d+)/.exec(String(a.getAttribute('href') || a.href || ''));
      if (m) return m[1];
    }
  } catch (e) {}
  return '';
}

/* 弹窗里拿不到规整的 article 时，用「Replying to」上方的原推文本做上下文，
 * 去掉 X 自己的 UI 文案，避免把占位符当推文正文发给 Grok。 */
function contextTextFromScope(scope) {
  // 1.3.4：scope 里可能混着几十个插件按钮，必须先剥掉插件 UI 文字再谈上下文
  return sanitizePostText(nodeText(scope)).slice(0, 600);
}

/* 1.3.4：回复弹窗里最可靠的正文来源是 X 官方的 [data-testid="tweetText"]。
 * 上一版靠启发式 findTextNode 扫整个 scope，把回复框工具栏和插件按钮
 * 都算进「推文正文」。这里优先取被回复推文的官方正文节点。 */
function replyTweetText(scope, card) {
  const sels = [
    '[data-testid="tweetDetail"] [data-testid="tweetText"]',
    'article[data-testid="tweet"] [data-testid="tweetText"]',
    '[data-testid="tweetText"]'
  ];
  const roots = [];
  if (scope && scope.querySelector) roots.push(scope);
  if (card && card.querySelector && roots.indexOf(card) === -1) roots.push(card);
  for (const root of roots) {
    for (const sel of sels) {
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll(sel)); } catch (e) { nodes = []; }
      for (const n of nodes) {
        const t = sanitizePostText(textOfNode(n));
        if (t.length >= 4) return t;
      }
    }
  }
  // 详情页的 scope 可能只包住回复框，被回复推文在 scope 外面
  try {
    const n = document.querySelector(sels.join(','));
    if (n) {
      const t = sanitizePostText(textOfNode(n));
      if (t.length >= 4) return t;
    }
  } catch (e) {}
  return '';
}

async function copyTextFallback(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* X 的 CSP / 焦点策略常挡住 clipboard.writeText，走下面兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = !!(document.execCommand && document.execCommand('copy'));
    if (ta.remove) ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* 1.3.2：等待浮层 —— 点击即出现，结果回来 / 报错后才关闭。
 * 网页版 Grok 会先输出思考过程，经常十几秒无反馈，之前只有一个 6 秒 toast，
 * 用户根本看不出「到底有没有在跑」。 */
let aiBusyTimer = null;

function hideAiBusy() {
  if (aiBusyTimer) { try { clearInterval(aiBusyTimer); } catch (e) {} aiBusyTimer = null; }
  const n = document.getElementById('wbx-ai-busy');
  if (n && n.remove) n.remove();
}

function showAiBusy(label) {
  hideAiBusy();
  const box = document.createElement('div');
  box.id = 'wbx-ai-busy';
  box.appendChild(makeCommentEl('div', 'wbx-busy-spin'));
  box.appendChild(makeCommentEl('div', 'wbx-busy-title', label || 'Grok 正在生成 3 条回复候选'));
  const stage = makeCommentEl('div', 'wbx-busy-stage', '正在连接 X 站内 Grok…');
  const time = makeCommentEl('div', 'wbx-busy-time', '已等待 0.0 秒');
  box.appendChild(stage);
  box.appendChild(time);
  box.appendChild(makeCommentEl('div', 'wbx-busy-hint',
    settings.grokFastMode === false ? '完整模式，最长约 90 秒。' : '快速模式：不思考、通常 5~15 秒，最长约 30 秒。'));
  const cancel = makeCommentEl('button', 'wbx-busy-cancel', '关闭等待提示');
  cancel.type = 'button';
  cancel.title = '只关提示，不中断后台生成';
  cancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideAiBusy();
    showToast('已关闭提示，后台仍在生成。', 3500);
  });
  box.appendChild(cancel);
  document.body.appendChild(box);

  const t0 = Date.now();
  const fast = settings.grokFastMode !== false;
  const stages = fast ? [
    [0, '正在连接 X 站内 Grok…'],
    [1500, '提示词已发出，等待 Grok 回答…'],
    [4000, 'Grok 正在写 3 条短评…'],
    [12000, '还在等 Grok 收尾…'],
    [24000, '接近超时，可关闭提示改用手动模式。']
  ] : [
    [0, '正在连接 X 站内 Grok…'],
    [2500, '提示词已写入，等待 Grok 开始回答…'],
    [8000, 'Grok 正在生成 3 条候选…'],
    [22000, '还在等 Grok 输出，请稍候…'],
    [45000, '接近超时，可关闭提示改用手动模式。']
  ];
  aiBusyTimer = setInterval(() => {
    if (document.getElementById && document.getElementById('wbx-ai-busy') !== box) {
      hideAiBusy();
      return;
    }
    const sec = (Date.now() - t0) / 1000;
    time.textContent = '已等待 ' + sec.toFixed(1) + ' 秒';
    let s = stages[0][1];
    for (const st of stages) if (sec * 1000 >= st[0]) s = st[1];
    stage.textContent = s;
  }, 400);
  return box;
}

async function onAiComment(card, btn) {
  if (!SITE || SITE.id !== 'x') return;
  if (isStaleContext()) {
    showNotice('插件刚重载', '请刷新 X 页面后再点「AI 评论」。',
      '重新加载扩展后，旧 X 标签里的内容脚本已失效。刷新该页面（Cmd+R）即可重新注入。');
    return;
  }
  const scope = (btn && btn.__wbxScope) || null;
  let text = '';
  // 1.3.4：优先用 X 官方 tweetText 节点，避开回复框工具栏与插件按钮
  try { text = replyTweetText(scope, card); } catch (e) {}
  if (!text) { try { if (card) text = resolvePost(card).text || ''; } catch (e) {} }
  if (!text && scope) text = contextTextFromScope(scope);
  text = sanitizePostText(text);
  if (!text) {
    showNotice('没读到推文正文', '已取消生成，请刷新 X 页面重试。',
      '可能只剩插件按钮文字、纯图推文，或 X 页面结构改版。为避免把界面文字发给 Grok，本次已取消。');
    return;
  }
  const statusId = extractXStatusId(card) || extractXStatusIdFromScope(scope);
  let permalink = '';
  try { permalink = card ? extractPermalink(card) : ''; } catch (e) {}
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中'; }
  showAiBusy('Grok 正在生成 3 条回复候选');
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GROK_COMMENTS',
      payload: { text, statusId, url: permalink }
    });
    if (resp && resp.prepared) {
      showNotice('提示词已填好', '请到 Grok 里手动发送，再点「读取 Grok 回答」。',
        '当前设为「不自动发送」。回答出现后，用候选面板的「读取 Grok 回答」收回来。');
      return;
    }
    if (!resp || !resp.ok) {
      const rawErr = String((resp && resp.error) || '后台没有响应');
      // 1.4.15：回答解析类失败刷新页面没用，别一律让用户去刷新/查签名
      const parseIssue = /思考|没解析|没返回可用评论|被截断|最终回答帧|回答帧/.test(rawErr);
      const tip = parseIssue
        ? '建议：再点一次「AI 评论」；仍失败可到 Grok 设置关掉「AI 快速模式」重试，或用「复制提示词（手动）」兜底。'
        : '建议：刷新 X 页面 → 设置里「测试当前模式」看诊断；也可用「复制提示词（手动）」兜底。';
      showNotice('生成失败', briefError(rawErr) + '，点「详情」看原因。',
        rawErr + '\n\n' + tip);
      return;
    }
    showCommentPicker(resp.comments || [], statusId, card, btn, text, resp.mode,
      Object.assign({ strict: resp.strict }, resp.diagnostics || {}));
  } catch (e) {
    const rawErr = String((e && e.message) || e);
    showNotice('调用失败', briefError(rawErr) + '，点「详情」看原因。',
      rawErr + '\n\n建议：刷新 X 页面；刚重载过扩展时尤其需要。超时可用「复制提示词（手动）」兜底。');
  } finally {
    hideAiBusy();
    if (btn) { btn.disabled = false; btn.textContent = 'AI 评论'; }
  }
}

function makeCommentEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* 1.4.5：两条生成路径（站内直连 / 手动读回回答）都汇到这里，
 * 所以推广尾巴只在这一处注入，不会出现漏加或重复加。
 * 只在用户显式勾选时生效；未加载 promo.js 时安静降级为原始候选。 */
function buildCommentTexts(comments, exclude) {
  const raw = (comments || []).map((c) => String(c == null ? '' : c));
  if (settings.promoEnabled !== true || typeof TapePromo === 'undefined') {
    return { texts: raw, lines: [], enabled: false };
  }
  const out = TapePromo.decorate(raw, {
    target: settings.promoTarget,
    custom: {
      tapeout: settings.promoCustomTapeOut || '',
      bem: settings.promoCustomBEM || ''
    },
    exclude: exclude || []
  });
  return { texts: out.texts, lines: out.lines, enabled: true };
}

function showCommentPicker(comments, statusId, card, btn, postText, mode, diag, exclude) {
  const old = document.getElementById('wbx-comments');
  if (old && old.remove) old.remove();
  const panel = document.createElement('div');
  panel.id = 'wbx-comments';
  const promo = buildCommentTexts(comments, exclude);

  const head = makeCommentEl('div', 'wbx-c-head');
  const modeLabel = mode === 'page' ? 'X 站内 Grok · 免 Key' : (mode === 'api' ? 'xAI API' : 'Grok');
  head.appendChild(makeCommentEl('span', '', `${modeLabel} 生成的 ${comments.length} 条回复候选`));
  const close = makeCommentEl('button', 'wbx-c-close', '×');
  close.type = 'button';
  close.title = '关闭';
  close.addEventListener('click', () => { if (panel.remove) panel.remove(); });
  head.appendChild(close);
  panel.appendChild(head);
  panel.appendChild(makeCommentEl('div', 'wbx-c-tip', promo.enabled
    ? '选一条写入回复框；末尾已随机附一句 TapeOut / $BEM 介绍，可点「🎲 换一批」更换。'
    : '选一条写入回复框，由你手动发送。'));
  // 1.3.2：把「是否真的触发 Grok / 读到回答」明确显示出来，不再静默兜底
  if (diag && mode === 'page') {
    const bits = [diag.hasAnswer === false ? '⚠️ 未确认读到 Grok 回答，请核对' : '✅ 已确认读到 Grok 回答'];
    if (diag.promptSent === false) bits.push('提示词可能未发出');
    if (diag.strict === false) bits.push('网页 Grok 未按 JSON 输出，按原文解析');
    if (diag.stable) bits.push('等待状态 ' + diag.stable);
    panel.appendChild(makeCommentEl('div', 'wbx-c-diag', bits.join(' · ')));
  }

  promo.texts.forEach((c, i) => {
    const item = makeCommentEl('div', 'wbx-c-item');
    item.appendChild(makeCommentEl('div', 'wbx-c-label', '候选 ' + (i + 1)));
    item.appendChild(makeCommentEl('div', 'wbx-c-text', c));
    const actions = makeCommentEl('div', 'wbx-c-actions');

    const use = makeCommentEl('button', 'wbx-c-use', '写入回复框');
    use.type = 'button';
    use.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 1.3.1 主路径：直接写进按钮旁边那个回复框，不再另开 intent 页面
      const wrote = applyCommentToReply(c, btn);
      if (wrote) {
        showToast('已写入回复框，手动点「回复」。', 3500);
        copyTextFallback(c);
        if (panel.remove) panel.remove();
        return;
      }
      // 兜底：X 改版导致找不到回复框 / 写入被拒时，退回官方 intent 预填
      const domain = settings.xDomain === 'twitter.com' ? 'twitter.com' : 'x.com';
      const params = new URLSearchParams();
      params.set('text', c);
      if (statusId) params.set('in_reply_to', statusId);
      const url = 'https://' + domain + '/intent/tweet?' + params.toString();
      // window.open 必须放在任何 await 之前：否则用户手势丢失，弹窗会被 Chrome 拦掉
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        showNotice('发布页被拦截', '文字可手动复制。', '请允许本站弹出窗口；候选卡片里的文字可直接复制。');
      }
      copyTextFallback(c).then((ok) => {
        showNotice('已改用 X 预填页', ok ? '文字已复制，确认后手动发送。' : '请在候选卡片里复制文字。',
          statusId ? '没能写入当前回复框，已改用 X 官方预填页。'
                   : '没取到本条推文 ID，已打开新发推框；要回复请粘到该推文的回复框。');
      });
    });
    actions.appendChild(use);

    const copy = makeCommentEl('button', 'wbx-c-copy', '复制');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const ok = await copyTextFallback(c);
      copy.textContent = ok ? '已复制 ✓' : '复制失败';
      setTimeout(() => { copy.textContent = '复制'; }, 1500);
    });
    actions.appendChild(copy);
    item.appendChild(actions);
    panel.appendChild(item);
  });

  const foot = makeCommentEl('div', 'wbx-c-foot');
  const again = makeCommentEl('button', '', '🔄 重新生成');
  again.type = 'button';
  again.addEventListener('click', () => {
    if (panel.remove) panel.remove();
    const liveCard = (btn && btn.__wbxReply)
      ? resolveReplyContext(btn, btn.__wbxScope)
      : ((btn && btn.closest && btn.closest(CARD_SELECTORS.join(','))) || card);
    return onAiComment(liveCard, btn);
  });
  const dismiss = makeCommentEl('button', '', '关闭');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => { if (panel.remove) panel.remove(); });
  foot.appendChild(again);
  if (promo.enabled) {
    const reroll = makeCommentEl('button', '', '🎲 换一批');
    reroll.type = 'button';
    reroll.title = '不重新生成评论，只换末尾的推广句';
    reroll.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (panel.remove) panel.remove();
      showCommentPicker(comments, statusId, card, btn, postText, mode, diag, promo.lines);
    });
    foot.appendChild(reroll);
  }
  foot.appendChild(dismiss);
  panel.appendChild(foot);

  // 非 API 模式的手动兜底：复制提示词自己粘进 Grok 发送 → 读回回答再解析
  const manual = makeCommentEl('div', 'wbx-c-manual');
  const prep = makeCommentEl('button', '', '📋 复制提示词（手动）');
  prep.type = 'button';
  prep.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    showAiBusy('正在把提示词填进 Grok');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'GROK_PAGE_PREPARE',
        payload: { kind: 'comments', text: postText || '' }
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '后台没有返回提示词');
      const ok = await copyTextFallback(r.prompt || '');
      showToast(ok
        ? '已复制提示词并填进 Grok 输入框：请到 Grok 里按发送，回答出来后点「读取 Grok 回答」。'
        : '提示词已填进 Grok 输入框（剪贴板被拒绝），请手动发送后点「读取 Grok 回答」。', 9000);
    } catch (err) {
      showToast('准备提示词失败：' + String(err && err.message || err) +
        '。请确认已登录 x.com 且 Grok 可用，或在设置里点「打开 Grok 页面」。', 10000);
    } finally {
      hideAiBusy();
    }
  });
  const read = makeCommentEl('button', '', '📥 读取 Grok 回答');
  read.type = 'button';
  read.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    showAiBusy('正在读取 Grok 回答');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'GROK_PAGE_READ',
        payload: { kind: 'comments', text: postText || '' }
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '后台没有返回');
      if (!r.comments || !r.comments.length) throw new Error('还没读到 3 条可用候选：请等 Grok 回答完整生成，或到 Grok 里让它重新按 JSON 输出后再点。');
      if (panel.remove) panel.remove();
      showCommentPicker(r.comments, statusId, card, btn, postText, r.mode,
        Object.assign({ strict: r.strict }, r.diagnostics || {}));
      showToast(r.strict === false
        ? '已读回回答，但网页 Grok 没严格按 JSON 输出，以下按原文解析，请自行核对。'
        : '已从 X 站内 Grok 读回回答，选一条即可回复。', 8000);
    } catch (err) {
      showToast('读取失败：' + String(err && err.message || err) +
        '。请确认 Grok 回答已生成完毕、X 标签仍打开。', 10000);
    } finally {
      hideAiBusy();
    }
  });
  manual.appendChild(prep);
  manual.appendChild(read);
  panel.appendChild(manual);
  document.body.appendChild(panel);
}

// ---------- 结果处理 ----------
function base64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/*
 * 页面上下文的二级剪贴板兜底：只写媒体（文字由 X intent 预填），
 * 写不进去才退化为纯文字。避免同一个 ClipboardItem 多格式带来的
 * 「X 只挑图片、文字丢失」或「预填+粘贴重复」。
 */
async function tryWriteClipboardInPage(text, images) {
  const textBlob = new Blob([text || ''], { type: 'text/plain' });
  const pngBlob = images.length ? new Blob([images[0]], { type: 'image/png' }) : null;
  const attempts = [];
  if (pngBlob) attempts.push({ reps: { 'image/png': pngBlob }, text: false, media: 'image' });
  attempts.push({ reps: { 'text/plain': textBlob }, text: true, media: 'none' });
  let lastErr = '';
  for (const a of attempts) {
    try {
      await navigator.clipboard.write([new ClipboardItem(a.reps)]);
      return { ok: true, text: a.text, media: a.media, error: '' };
    } catch (e) {
      lastErr = e && e.name ? e.name + ': ' + e.message : String(e);
    }
  }
  return { ok: false, text: false, media: 'none', error: lastErr };
}

async function handleResult(msg) {
  const results = msg.results || [];
  const text = msg.text || '';
  if (msg.error) { showToast('处理失败：' + msg.error); return; }

  const b64List = results.filter((r) => r.ok && r.data).map((r) => r.data);
  const images = b64List.map(base64ToU8);
  const failedItems = results.filter((r) => !r.ok);
  const failed = failedItems.length;
  const failReason = failedItems.map((r) => r.error).filter(Boolean)[0];
  const video = msg.video || null;
  const wmDone = results.filter((r) => r.ok && r.wm && r.wm.changed).length;
  const wmSkip = results.filter((r) => r.ok && r.wm && !r.wm.changed).length;

  // 主路径：offscreen（扩展上下文）已把「文字 + 首图/视频」写进同一个 ClipboardItem
  let clipboardOk = !!msg.clipboardOk;
  let clipboardTextOk = !!msg.clipboardText;
  let clipboardMedia = msg.clipboardMedia || 'none';
  let copyErr = msg.clipboardError || '';

  // 二级兜底：offscreen 失败时，在页面里再试（此时还没 window.open，页面仍聚焦）
  if (!clipboardOk && (images.length || text)) {
    const fb = await tryWriteClipboardInPage(text, images);
    clipboardOk = fb.ok;
    clipboardTextOk = fb.text;
    clipboardMedia = fb.media;
    copyErr = fb.ok ? '' : fb.error;
  }

  const firstImageInClipboard = clipboardOk && clipboardMedia === 'image';
  /* 1.4.3：默认不落盘。图片优先走剪贴板 / 托盘逐张复制；
   * 只有用户显式开启「自动下载备份」时才在转发时额外下载，
   * 且这些文件统一进 TapePost_tmp/ 并按保留时长自动清理。 */
  if (settings.autoDownloadBackup) {
    if (b64List.length > 1) {
      const toDownload = firstImageInClipboard ? b64List.slice(1) : b64List;
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', images: toDownload }).catch(() => {});
    } else if (b64List.length === 1 && !firstImageInClipboard) {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', images: b64List }).catch(() => {});
    }
  }

  // 文字始终预填进 X（最可靠）；剪贴板只放媒体，Ctrl+V 贴图不会带出重复文字
  const xUrl = 'https://' + (settings.xDomain || 'twitter.com') + '/intent/tweet?text=' + encodeURIComponent(text || '');
  const multi = images.length > 1;
  /*
   * 多图时不能自动 window.open：新标签会立刻抢走焦点，而托盘挂在微博页，
   * 用户眼前只有 X，根本看不到「多图复制」入口（这正是之前反馈的问题）。
   * 改为先把托盘弹在本页，由托盘上的醒目按钮再打开 X（文字照样预填）。
   */
  const opened = multi ? null : window.open(xUrl, '_blank');
  if (!opened && text && !clipboardTextOk && !multi) {
    try { await navigator.clipboard.writeText(text); clipboardTextOk = true; } catch (e) {}
  }

  let tip = multi
    ? `已整理 ${images.length} 张干净图，右下角「图片托盘」已弹出：先逐张复制或拼成长图，再点托盘顶部的「打开 X 发推」按钮（正文自动预填），到 X 里 Ctrl+V 粘贴。`
    : (clipboardTextOk
      ? '已打开 X（文字已预填，也已进剪贴板）。'
      : '已打开 X（文字已预填）。');
  if (firstImageInClipboard) tip += ' 干净首图已复制到剪贴板，Ctrl+V 贴入即可。';
  else if (clipboardOk && clipboardMedia === 'video') tip += ' 视频已写入剪贴板，可在 X 里 Ctrl+V 试试。';
  else if (images.length) tip += ` 图片自动复制失败（${copyErr || '剪贴板不可用'}），请点「📋 复制图片到剪贴板」，或点托盘「下载到临时目录」。`;

  if (images.length === 1 && !firstImageInClipboard) {
    tip += settings.autoDownloadBackup
      ? ' 首图已存入临时目录，请拖入 X（到期自动清理）。'
      : ' 需要本地文件时点浮层按钮下载到临时目录。';
  }
  // 数量诊断：识别到几张、成功几张，多图漏采/下载失败一眼可见
  if (results.length) tip += ` 内容图 ${results.length} 张 → 干净图 ${images.length} 张。`;
  if (results.length > 1 && images.length <= 1) {
    tip += '（只采到 1 张：往下滚一下再点，或用托盘「下载到临时目录」取文件）';
  }
  if (video) {
    if (video.ok) tip += ` 视频已存入临时目录（${video.source || '原片'}），请拖入 X；到期自动清理。`;
    else tip += ` 视频处理失败：${video.error || '未知原因'}。`;
  }
  if (!opened && !multi) tip += '（X 弹窗被拦截/打不开，已尝试把文字复制到剪贴板）';
  if (!images.length && !video) tip += ' 无媒体，仅文字。';
  if (wmDone || wmSkip) {
    tip += ` 去水印：${wmDone} 张已处理${wmSkip ? `、${wmSkip} 张未检测到水印（原图保留）` : ''}。`;
  }
  if (failed) tip += `（${failed} 张图获取失败${failReason ? '：' + failReason : ''}）`;
  if (multi && settings.autoDownloadBackup) tip += ' 其余图也已存入临时目录。';
  // 把实际转发走的文字回显出来：一旦作者信息/话题尾巴又混进来，点一次就能看见
  const bodyPreview = text ? (text.length > 42 ? text.slice(0, 42) + '…' : text) : '（无正文）';
  showToast(tip + '\n转发正文：' + bodyPreview, 9000);

  // 多图用托盘（逐张复制本身就是「真实点击手势」的保底），不再叠一个浮动复制按钮
  if (multi) showGallery(text, images, b64List, xUrl);
  if (!firstImageInClipboard && images.length === 1) showCopyButton(text, images);
}

/* ---------- 多图托盘 ----------
 * Chrome 的剪贴板一次只能放一张图（多个 ClipboardItem 会被拒绝），
 * X 又只认粘贴/拖入。所以多图给一个可交互托盘：
 *   逐张复制（真实点击手势，成功率最高）→ 切到 X 粘贴，可重复累加到 4 张
 *   拼成一张长图 → 一次 Ctrl+V 带全部，绕开 4 张上限
 *   全部下载 → 拖入 X 或留档
 */
async function copyPng(u8) {
  const blob = new Blob([u8], { type: 'image/png' });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

async function makeCollage(images) {
  const bitmaps = await Promise.all(images.map((u8) =>
    createImageBitmap(new Blob([u8], { type: 'image/png' }))));
  const maxW = Math.min(1200, Math.max.apply(null, bitmaps.map((b) => b.width || 1)));
  const gap = 8, MAXH = 6000;
  let rows = bitmaps.map((b) => ({
    b,
    w: maxW,
    h: Math.max(1, Math.round((b.height || 1) * maxW / (b.width || 1)))
  }));
  let total = rows.reduce((s, r) => s + r.h, 0) + gap * (rows.length - 1);
  if (total > MAXH) {
    const k = MAXH / total;
    rows = rows.map((r) => ({ b: r.b, w: Math.round(r.w * k), h: Math.round(r.h * k) }));
    total = MAXH;
  }
  const canvas = document.createElement('canvas');
  canvas.width = maxW;
  canvas.height = total;
  const ctx = canvas.getContext('2d');
  if (ctx.fillStyle !== undefined) ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let y = 0;
  for (const r of rows) {
    ctx.drawImage(r.b, (canvas.width - r.w) / 2, y, r.w, r.h);
    y += r.h + gap;
  }
  bitmaps.forEach((b) => { try { if (b.close) b.close(); } catch (e) {} });
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('拼图编码失败')), 'image/png');
    } catch (e) { reject(e); }
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function showGallery(text, images, b64List, xUrl) {
  const old = document.getElementById('wbx-gallery');
  if (old && old.remove) { try { old.remove(); } catch (e) {} }
  const panel = document.createElement('div');
  panel.id = 'wbx-gallery';
  panel.setAttribute('data-wbx-count', String(images.length));

  const copied = new Set();
  const head = document.createElement('div');
  head.className = 'wbx-g-head';
  const title = document.createElement('span');
  title.textContent = `干净图 ${images.length} 张`;
  const progress = document.createElement('span');
  progress.className = 'wbx-g-progress';
  const updateProgress = (all) => {
    const n = all ? images.length : copied.size;
    progress.textContent = `已复制 ${n}/${images.length}`;
  };
  updateProgress(false);
  const close = document.createElement('button');
  close.className = 'wbx-g-close';
  close.textContent = '×';
  close.addEventListener('click', () => { try { panel.remove(); } catch (e) {} });
  head.appendChild(title);
  head.appendChild(progress);
  head.appendChild(close);
  panel.appendChild(head);

  // 多图时 X 由用户点这个按钮再打开：先复制图片、再开 X，托盘不会被抢焦点盖掉
  const openX = document.createElement('button');
  openX.className = 'wbx-g-open';
  openX.textContent = '🚀 打开 X 发推（正文已预填）';
  openX.addEventListener('click', () => {
    const w = window.open(xUrl, '_blank');
    if (!w && text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) {}
      }
      showToast('X 弹窗被拦截，已把正文复制到剪贴板，请手动打开 X 粘贴。');
    } else {
      showToast('X 已打开，正文已预填；在发布框按 Ctrl+V 粘贴刚才复制的图片。');
    }
  });
  panel.appendChild(openX);

  const tip = document.createElement('div');
  tip.className = 'wbx-g-tip';
  tip.textContent = '① 复制第 N 张 / 拼长图 → ② 打开 X → ③ Ctrl+V。默认不落盘；需要文件才点「下载到临时目录」，到期自动清理。';
  panel.appendChild(tip);

  const list = document.createElement('div');
  list.className = 'wbx-g-list';
  images.forEach((u8, i) => {
    const item = document.createElement('div');
    item.className = 'wbx-g-item';
    const img = document.createElement('img');
    let src = '';
    try { src = URL.createObjectURL(new Blob([u8], { type: 'image/png' })); } catch (e) {}
    if (!src) src = 'data:image/png;base64,' + (b64List[i] || '');
    img.setAttribute('src', src);
    img.setAttribute('alt', '第 ' + (i + 1) + ' 张');
    const b = document.createElement('button');
    b.textContent = '复制第 ' + (i + 1) + ' 张';
    b.addEventListener('click', async () => {
      try {
        await copyPng(u8);
        copied.add(i);
        updateProgress(false);
        b.textContent = '✅ 已复制';
        showToast(`第 ${i + 1}/${images.length} 张已进剪贴板（已复制 ${copied.size} 张）：点「打开 X 发推」后按 Ctrl+V 贴上；其它张再回来点。`);
        setTimeout(() => { b.textContent = '复制第 ' + (i + 1) + ' 张'; }, 2500);
      } catch (e) {
        b.textContent = '❌ 失败';
        showToast('复制失败：' + (e && e.message || e) + '，请改用「下载到临时目录」');
      }
    });
    item.appendChild(img);
    item.appendChild(b);
    list.appendChild(item);
  });
  panel.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'wbx-g-actions';
  const collage = document.createElement('button');
  collage.textContent = '拼成长图并复制';
  collage.addEventListener('click', async () => {
    try {
      const u8 = await makeCollage(images);
      await copyPng(u8);
      updateProgress(true);
      collage.textContent = '✅ 长图已复制';
      showToast(`${images.length} 张已拼成一张长图并复制：点「打开 X 发推」后按 Ctrl+V 一次贴上。`);
      setTimeout(() => { collage.textContent = '拼成长图并复制'; }, 3000);
    } catch (e) {
      showToast('拼图失败：' + (e && e.message || e) + '，请改用逐张复制或临时目录');
    }
  });
  const dl = document.createElement('button');
  dl.textContent = '下载到临时目录';
  dl.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'DOWNLOAD', images: b64List }).catch(() => {}); } catch (e) {}
    showToast(`已存 ${b64List.length} 张到临时目录，到期自动清理。`);
  });
  const clean = document.createElement('button');
  clean.textContent = '🧹 清理临时文件';
  clean.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'TMP_CLEAN' }, (r) => {
        // 1.4.4：端口可能在后台回包前关闭，必须同步读取 lastError
        const err = chrome.runtime && chrome.runtime.lastError;
        showToast(!err && r && r.ok
          ? `已清理 ${r.removed || 0} 个文件${r.remaining ? `，剩 ${r.remaining} 个` : '，本机无残留'}`
          : '清理失败，请在设置面板重试');
      });
    } catch (e) { showToast('清理失败，请在设置面板重试'); }
  });
  actions.appendChild(collage);
  actions.appendChild(dl);
  actions.appendChild(clean);
  panel.appendChild(actions);

  document.body.appendChild(panel);
}

// 用户真实点击触发，user activation 一定有效，是最可靠的保底路径
function showCopyButton(text, images) {
  let b = document.getElementById('wbx-copybtn');
  if (b) b.remove();
  b = document.createElement('button');
  b.id = 'wbx-copybtn';
  b.textContent = '📋 复制图片到剪贴板';
  b.addEventListener('click', async () => {
    const fb = await tryWriteClipboardInPage(text, [images[0]]);
    if (fb.ok) {
      b.textContent = '✅ 已复制，切到 X 按 Ctrl+V';
      setTimeout(() => b.remove(), 3000);
    } else {
      b.textContent = '❌ 仍失败：' + fb.error + '，请在设置里开启自动下载';
    }
  });
  document.body.appendChild(b);
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(msg, ms = 3000) {
  let t = document.getElementById('wbx-toast');
  if (!t) { t = document.createElement('div'); t.id = 'wbx-toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (t) t.style.display = 'none'; }, ms);
}

/* 1.4.2 文案精简：长报错只给一句结论，完整诊断收进简洁弹窗。 */
function briefError(raw) {
  const s = String(raw || '');
  if (/401|403|认证|authenticate/i.test(s)) return 'X 会话认证失败，请刷新 X 页面';
  if (/没响应|Receiving end|Could not establish|没有响应|连接/i.test(s)) return '连接失效，请刷新 X 页面';
  if (/没解析|没读到|解析不出|没返回/i.test(s)) return 'Grok 没返回可用候选';
  if (/超时|timeout/i.test(s)) return '生成超时，请重试';
  if (/ct0|登录|会话已失效/i.test(s)) return '请先登录 X 并刷新页面';
  if (/429|限流/i.test(s)) return '触发限流，稍后再试';
  return 'Grok 生成失败';
}

function showNotice(title, short, detail) {
  const old = document.getElementById('wbx-notice');
  if (old && old.remove) old.remove();
  const box = document.createElement('div');
  box.id = 'wbx-notice';
  const h = document.createElement('div');
  h.className = 'wbx-n-title';
  h.textContent = title || '提示';
  const m = document.createElement('div');
  m.className = 'wbx-n-msg';
  m.textContent = short || '';
  const d = document.createElement('div');
  d.className = 'wbx-n-detail';
  d.textContent = detail || short || '';
  box.appendChild(h);
  box.appendChild(m);
  box.appendChild(d);
  const actions = document.createElement('div');
  actions.className = 'wbx-n-actions';
  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = '详情';
  more.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    d.classList.toggle('open');
    more.textContent = d.classList.contains('open') ? '收起' : '详情';
  });
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'primary';
  ok.textContent = '知道了';
  ok.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (box.remove) box.remove();
  });
  actions.appendChild(more);
  actions.appendChild(ok);
  box.appendChild(actions);
  document.body.appendChild(box);
}

// ---------- 初始化 ----------
function init() {
  // 未适配的站点不注入任何按钮；已适配但在设置里被关掉也不注入
  if (!SITE) return;
  migrateGrokMode141();   // 一次性把老设置 grokMode="page" 升级为 auto（刷新页面即生效）
  injectStyle();
  loadSettings().then(() => {
    if (settings.enabledSites && settings.enabledSites[SITE.id] === false) return;
    scanAndInject();
    let timer = null;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(scanAndInject, 400);
    };
    const obs = new MutationObserver(debounced);
    obs.observe(document.body, { childList: true, subtree: true });
    // 滚动时立即校验卡片指纹：DOM 复用后按钮要跟着换到新内容上
    let scrollTimer = null;
    const onScroll = () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(scanAndInject, 150);
    };
    try { window.addEventListener('scroll', onScroll, { passive: true }); } catch (e) {}
    // 微博首页常是内部 div 滚动（window 收不到 scroll），capture 才能捕获
    try { document.addEventListener('scroll', onScroll, { passive: true, capture: true }); } catch (e) {}
    setInterval(scanAndInject, 2500);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
