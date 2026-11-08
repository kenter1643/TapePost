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
  enableAiComment: true,         // X 推文上是否显示「AI 评论」按钮
  enabledSites: {}               // 各站点开关；默认全部启用（值为 false 才关闭）
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
  /* 两个按钮并排：由 group 负责绝对定位，组内按钮回到文档流，避免叠在一起 */
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
  return cleanText(raw);
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
        el.title = (el.title ? el.title + '；' : '') + '如需去水印并转发到 X，请点内容右上角橙色「一键转发」按钮';
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
  // X 站点额外挂一个「AI 评论」；开关变化也要能触发重建，所以纳入指纹校验
  const wantComment = !!(SITE && SITE.id === 'x') && settings.enableAiComment !== false;
  const commentFlag = wantComment ? '1' : '0';
  const existing = card.querySelector('.wbx-btn-group') || card.querySelector('.wbx-repost-btn');
  const groupIntact = existing && (String(existing.className || '').indexOf('wbx-btn-group') === -1 ||
    (existing.querySelector && existing.querySelector('.wbx-repost-btn')));
  if (existing && groupIntact && card.contains(existing) &&
      card.dataset.wbxFp === qfp && card.dataset.wbxCommentMode === commentFlag) return;

  const post = resolvePost(card);
  if (!post.text && !post.imageUrls.length && !post.hasVideo) return;

  // 内容变了 / 按钮被框架删掉 → 移除旧按钮重建
  if (existing) { try { existing.remove(); } catch (e) {} }
  // 老版本残留的独立评论按钮（没包在 group 里）也一并清掉
  try { card.querySelectorAll('.wbx-comment-btn').forEach((n) => n.remove()); } catch (e) {}
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
  btn.title = 'TapePost · 提取本条内容正文+全部内容图/视频，清洗后复制并打开 X 让你手动发送 · v1.2.0';
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

  if (wantComment) {
    const cbtn = document.createElement('button');
    cbtn.className = 'wbx-comment-btn';
    cbtn.type = 'button';
    cbtn.textContent = 'AI 评论';
    cbtn.title = 'TapePost · 用 Grok 按设定提示词生成 3 条回复候选，选一条后预填到 X 回复框（由你手动发送）';
    cbtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const liveCard = (cbtn.closest && cbtn.closest(CARD_SELECTORS.join(','))) || card;
      return onAiComment(liveCard, cbtn);
    });
    group.appendChild(cbtn);
  }

  host.appendChild(group);
  card.dataset.wbxFp = qfp;   // 与早退判断同口径，切勿改成 postFingerprint(post)
  card.dataset.wbxCommentMode = commentFlag;
  card.dataset.wbxInjected = '1';
}

/* 插件自己打开的 X 发布页不注入按钮：否则发推框里会再叠一个「一键转发」。
 * 只放在扫描入口判定（不放 init），X 是 SPA，从发布页返回时间线后还能恢复扫描。 */
function isXIntentPage() {
  if (!SITE || SITE.id !== 'x') return false;
  const p = String(PAGE_PATH || '/').toLowerCase();
  return p.indexOf('/intent/') === 0 || p.indexOf('/i/flow/') === 0 ||
    p.indexOf('/compose/') === 0;
}

function scanAndInject() {
  if (isXIntentPage()) return;
  try { getCards().forEach(injectIntoCard); } catch (e) { /* ignore */ }
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
 * 与「一键转发」保持同一套原则：插件只生成 / 预填，绝不自动发布。
 * 回复目标用 X Web Intent 的 in_reply_to 参数（官方预填渠道），比往 X 的
 * React 受控输入框里塞 textContent 可靠得多；文字同时进剪贴板做兜底。
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

async function onAiComment(card, btn) {
  if (!SITE || SITE.id !== 'x') return;
  if (isStaleContext()) {
    showToast('插件刚重新加载过，旧按钮已失效：请刷新 X 页面（Cmd+R）后再点「AI 评论」。', 9000);
    return;
  }
  const post = resolvePost(card);
  const text = post.text || '';
  if (!text) {
    showToast('没有读到这条推文的正文（可能是纯图/纯视频推文），已取消生成评论。', 7000);
    return;
  }
  const statusId = extractXStatusId(card);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中'; }
  showToast('Grok 正在按设定提示词生成 3 条回复候选…（只生成候选，不会自动发布）', 6000);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GROK_COMMENTS',
      payload: { text, statusId, url: extractPermalink(card) }
    });
    if (btn) { btn.disabled = false; btn.textContent = 'AI 评论'; }
    if (!resp || !resp.ok) {
      showToast('Grok 生成失败：' + String((resp && resp.error) || '后台没有响应') +
        '\n请点插件图标，在「Grok 设置」里检查 API Key / 模型 / 网络。', 11000);
      return;
    }
    showCommentPicker(resp.comments || [], statusId, card, btn);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'AI 评论'; }
    showToast('AI 评论调用失败：' + String(e && e.message || e), 9000);
  }
}

function makeCommentEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showCommentPicker(comments, statusId, card, btn) {
  const old = document.getElementById('wbx-comments');
  if (old && old.remove) old.remove();
  const panel = document.createElement('div');
  panel.id = 'wbx-comments';

  const head = makeCommentEl('div', 'wbx-c-head');
  head.appendChild(makeCommentEl('span', '', `Grok 生成的 ${comments.length} 条回复候选`));
  const close = makeCommentEl('button', 'wbx-c-close', '×');
  close.type = 'button';
  close.title = '关闭';
  close.addEventListener('click', () => { if (panel.remove) panel.remove(); });
  head.appendChild(close);
  panel.appendChild(head);
  panel.appendChild(makeCommentEl('div', 'wbx-c-tip',
    '选一条 → 打开 X 回复框并预填文字，最后一步「发送」始终由你手动点；文字也已复制，可随时粘贴。'));

  comments.forEach((c, i) => {
    const item = makeCommentEl('div', 'wbx-c-item');
    item.appendChild(makeCommentEl('div', 'wbx-c-label', '候选 ' + (i + 1)));
    item.appendChild(makeCommentEl('div', 'wbx-c-text', c));
    const actions = makeCommentEl('div', 'wbx-c-actions');

    const use = makeCommentEl('button', 'wbx-c-use', '用它回复 ↗');
    use.type = 'button';
    use.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const domain = settings.xDomain === 'twitter.com' ? 'twitter.com' : 'x.com';
      const params = new URLSearchParams();
      params.set('text', c);
      if (statusId) params.set('in_reply_to', statusId);
      const url = 'https://' + domain + '/intent/tweet?' + params.toString();
      // window.open 必须放在任何 await 之前：否则用户手势丢失，弹窗会被 Chrome 拦掉
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        showToast('X 发布页弹窗被拦截了：请允许本站弹出窗口后重试；评论文字已生成在下方卡片里，可手动复制。', 9000);
      }
      copyTextFallback(c).then((ok) => {
        showToast(statusId
          ? (ok ? '已打开 X 回复框并预填，文字也已复制；确认无误后手动点「回复」。'
                : '已打开 X 回复框并预填；剪贴板复制被浏览器拒绝，文字已在候选卡片里可手动复制。')
          : (ok ? '没取到本条推文的 ID：已打开新发推框并预填，文字也已复制；如需回复请粘到该推文的回复框。'
                : '没取到本条推文的 ID：已打开新发推框并预填，请手动复制文字。'), 9000);
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
    const liveCard = (btn && btn.closest && btn.closest(CARD_SELECTORS.join(','))) || card;
    return onAiComment(liveCard, btn);
  });
  const dismiss = makeCommentEl('button', '', '关闭');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => { if (panel.remove) panel.remove(); });
  foot.appendChild(again);
  foot.appendChild(dismiss);
  panel.appendChild(foot);
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

  // 图片下载兜底：多图时其余下载；剪贴板没带上首图时首图也下载
  const firstImageInClipboard = clipboardOk && clipboardMedia === 'image';
  if (b64List.length > 1) {
    const toDownload = firstImageInClipboard ? b64List.slice(1) : b64List;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', images: toDownload }).catch(() => {});
  } else if (b64List.length === 1 && !firstImageInClipboard) {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD', images: b64List }).catch(() => {});
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
  else if (images.length) tip += ` 图片自动复制失败（${copyErr || '剪贴板不可用'}），请点「📋 复制图片到剪贴板」按钮，或用下载的文件拖入 X。`;

  if (images.length === 1 && !firstImageInClipboard) {
    tip += ' 首图已下载到本地下载目录，请拖入 X 发布框。';
  }
  // 数量诊断：识别到几张、成功几张，多图漏采/下载失败一眼可见
  if (results.length) tip += ` 内容图 ${results.length} 张 → 干净图 ${images.length} 张。`;
  if (results.length > 1 && images.length <= 1) {
    tip += '（只采到 1 张：微博多图可能还在懒加载，往下滚一下再点，或用托盘的「全部下载」取本地文件）';
  }
  if (video) {
    if (video.ok) tip += ` 视频已下载（${video.filename || 'mp4'}，${video.source || '原片'}），请拖入 X 发布框。`;
    else tip += ` 视频处理失败：${video.error || '未知原因'}。`;
  }
  if (!opened && !multi) tip += '（X 弹窗被拦截/打不开，已尝试把文字复制到剪贴板）';
  if (!images.length && !video) tip += ' 无媒体，仅文字。';
  if (wmDone || wmSkip) {
    tip += ` 去水印：${wmDone} 张已处理${wmSkip ? `、${wmSkip} 张未检测到水印（原图保留）` : ''}。`;
  }
  if (failed) tip += `（${failed} 张图获取失败${failReason ? '：' + failReason : ''}）`;
  if (multi) tip += ' 其余图也已下载备份。';
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
  tip.textContent = '① 点「复制第 N 张」或「拼成长图」→ ② 点上方蓝色按钮打开 X → ③ 在发布框 Ctrl+V。一条推文最多 4 张，超过请用长图。';
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
        showToast('复制失败：' + (e && e.message || e) + '，请改用「全部下载」后拖入 X');
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
      showToast('拼图失败：' + (e && e.message || e) + '，请改用逐张复制或下载的文件');
    }
  });
  const dl = document.createElement('button');
  dl.textContent = '全部下载';
  dl.addEventListener('click', () => {
    try { chrome.runtime.sendMessage({ type: 'DOWNLOAD', images: b64List }).catch(() => {}); } catch (e) {}
    showToast(`已把 ${b64List.length} 张干净图下载到下载目录。`);
  });
  actions.appendChild(collage);
  actions.appendChild(dl);
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
      b.textContent = '❌ 仍失败：' + fb.error + '，请用下载的文件';
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

// ---------- 初始化 ----------
function init() {
  // 未适配的站点不注入任何按钮；已适配但在设置里被关掉也不注入
  if (!SITE) return;
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
