/* TapePost 1.5.18 · 视频剪辑「发推正文去乱码」专项自检
 * 运行：node test-video-caption.js   （不进 Chrome Web Store 商店包）
 *
 * 背景：1.5.2 / 1.5.3 把按钮挂进微博视频卡片内部，真机（2026-11-14）确认
 * 首页视频帖仍然看不到 —— 播放器图层裁剪、播放器无障碍文本让内容指纹抖动、
 * 微博框架重渲染抹掉外来节点。1.5.4 改为挂在 document.body 的 fixed 固定条，
 * 按卡片 rect 跟随定位，这里用极简 DOM 沙箱验证「一定看得见、不自激、可自愈」。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

let ROOT = null;
class El {
  constructor(tag, opts = {}) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.className = opts.className || '';
    this.attrs = Object.assign({}, opts.attrs || {});
    this._text = opts.text || '';
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.offsetWidth = 156;
    this.classList = {
      add: (c) => { if (!this.className.split(' ').includes(c)) this.className += ' ' + c; },
      remove: (c) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
      contains: (c) => this.className.split(' ').includes(c)
    };
    this.rect = opts.rect || { width: 420, height: 260, top: 0, left: 0, right: 420, bottom: 260 };
  }
  get isConnected() {
    let el = this;
    while (el.parentElement) el = el.parentElement;
    return !!ROOT && el === ROOT;
  }
  get innerText() { return this._text + this.children.map((c) => c.innerText).join(''); }
  set innerText(v) { this._text = String(v); }
  get textContent() { return this.innerText; }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  addEventListener() {}
  getBoundingClientRect() { return this.rect; }
  contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
  closest(sel) {
    let el = this;
    while (el) {
      if (matches(el, sel)) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function getAttr(el, key) {
  if (key === 'class') return el.className || '';
  if (key === 'id') return el.attrs.id || '';
  if (key.startsWith('data-')) {
    const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return (el.dataset[dk] != null ? el.dataset[dk] : el.attrs[key]) || '';
  }
  return el.attrs[key] || '';
}

function matches(el, sel) {
  if (!el || !sel) return false;
  return String(sel).split(',').some((raw) => {
    const s = raw.trim();
    if (!s) return false;
    if (s === '*') return true;
    if (/^\.[\w-]+$/.test(s)) return el.className.split(' ').includes(s.slice(1));
    if (/^#[\w-]+$/.test(s)) return el.attrs.id === s.slice(1);
    const m = /^([a-zA-Z][\w-]*)?(.*)$/.exec(s);
    if (!m) return false;
    const tag = m[1] ? m[1].toUpperCase() : null;
    const rest = m[2] || '';
    if (tag && el.tagName !== tag) return false;
    if (!tag && !rest) return false;
    const restNoAttrs = rest.replace(/\[[^\]]*\]/g, '');
    for (const cm of restNoAttrs.matchAll(/\.([\w-]+)/g)) {
      if (!el.className.split(' ').includes(cm[1])) return false;
    }
    for (const am of rest.matchAll(/\[([^=\]*~|^$]+)(?:([*~|^$]?=)\s*["']?([^\]"']+)["']?)?\]/g)) {
      const val = getAttr(el, am[1].trim());
      if (!val) return false;
      if (am[3] && !String(val).includes(am[3])) return false;
    }
    return true;
  });
}

const root = new El('html');
ROOT = root;
const head = new El('head');
const body = new El('body');
root.appendChild(head); root.appendChild(body);

const document = {
  readyState: 'loading',
  documentElement: root, head, body,
  getElementById: (id) => root.querySelectorAll('#' + id)[0] || null,
  createElement: (tag) => new El(tag),
  querySelectorAll: (sel) => root.querySelectorAll(sel),
  querySelector: (sel) => root.querySelector(sel),
  addEventListener: () => {},
  createTextNode: (t) => new El('span', { text: t })
};
const noop = () => {};
const chrome = {
  runtime: {
    id: 'test', getManifest: () => ({ version: '1.5.4' }),
    sendMessage: () => Promise.resolve({ ok: true }),
    onMessage: { addListener: noop }, lastError: null
  },
  storage: {
    sync: { get: (d, cb) => { if (cb) cb(d); return Promise.resolve(d); }, set: noop },
    local: { get: (d, cb) => { if (cb) cb(d); return Promise.resolve(d); }, set: noop },
    onChanged: { addListener: noop }
  },
  downloads: { download: noop }
};
const ctx = vm.createContext({
  console, document, chrome,
  location: { hostname: 'weibo.com', pathname: '/', href: 'https://weibo.com/' },
  window: { addEventListener: noop, location: { hostname: 'weibo.com' }, innerHeight: 900, innerWidth: 1440 },
  getComputedStyle: () => ({ position: 'static', overflow: 'visible', overflowY: 'visible', backgroundImage: '' }),
  MutationObserver: class { observe() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  Image: class {}, URL, Blob: class {}, fetch: () => Promise.resolve(),
  TextDecoder, TextEncoder,
  navigator: { clipboard: { write: () => Promise.resolve() } },
  ClipboardItem: class {},
  requestAnimationFrame: (cb) => setTimeout(cb, 0)
});
vm.runInContext(read('sites.js'), ctx, { filename: 'sites.js' });
vm.runInContext(read('content.js'), ctx, { filename: 'content.js' });

// ============================================================ 1.5.18 正文去乱码自检
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL ❌ ' + name + (extra ? ' | ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, a === b, String(a) + ' !== ' + String(b));
const R = (expr) => vm.runInContext(expr, ctx, { timeout: 5000 });
const desc = (el) => (el && el.children ? el.children.concat(el.children.reduce((a, c) => a.concat(desc(c)), [])) : []);
// 入口专项的 El.addEventListener 是空实现，这里补上事件记录以便模拟点击
El.prototype.addEventListener = function (t, fn) {
  if (!this.listeners) this.listeners = {};
  (this.listeners[t] = this.listeners[t] || []).push(fn);
};
const contentJs = read('content.js');

const MOJI = Buffer.from('测试', 'utf8').toString('latin1');   // æµ‹è¯•
const CAP = '这走位也太丝滑了吧，全程没碰到一下护栏。';
const JUNK = '\ue60a\ue60b 00:00 / 02:35 1.2万次播放 全屏 倍速 \ue61c';

// ---------------------------------------------------------------- A. 解码与清洗
ok('HTML 数字实体 / 命名实体解码',
  /你好/.test(R('decodeCaptionEscapes("&#x4F60;&#x597D; &amp; &nbsp;")')) &&
  /&/.test(R('decodeCaptionEscapes("&#x4F60;&#x597D; &amp; &nbsp;")')));
ok('百分号编码整串还原中文',
  /中文/.test(R('decodeCaptionEscapes("%E4%B8%AD%E6%96%87")')));
ok('JSON 的 \\uXXXX 转义还原中文',
  /你好/.test(R('decodeCaptionEscapes("\\\\u4F60\\\\u597D")')));
eq('UTF-8 被按 Latin-1 解码时还原中文', R('repairCaptionMojibake(' + JSON.stringify(MOJI) + ')'), '测试');
eq('normalizeCaption 还原误解码串', R('normalizeCaption(' + JSON.stringify(MOJI) + ')'), '测试');
ok('图标字体私有区字符（PUA）被剔除',
  !/[\ue000-\uf8ff]/.test(R('normalizeCaption(' + JSON.stringify('今天' + '\ue60a\ue60b' + '发新视频，真的好看。') + ')')) &&
  /今天.*发新视频/.test(R('normalizeCaption(' + JSON.stringify('今天' + '\ue60a\ue60b' + '发新视频，真的好看。') + ')')));
ok('内联 JSON / React props 片段被剔除',
  !/stream_url|page_info/.test(R('normalizeCaption("好看的视频 {\\"page_info\\":{\\"stream_url\\":\\"https://a.mp4\\"}} 真的好看")')));
ok('播放器无障碍文本清洗后判为乱码', R('captionLooksGarbled(normalizeCaption(' + JSON.stringify(JUNK) + '))'));
ok('整段 JSON 判为乱码', R('captionLooksGarbled("{\\"title\\":\\"abc\\",\\"id\\":123}")'));
ok('[object Object] / undefined 判为乱码', R('captionLooksGarbled("[object Object] undefined window.foo")'));
ok('残留 \\u 转义 / 百分号编码判为乱码',
  R('captionLooksGarbled("\\\\u4F60\\\\u597D")') && R('captionLooksGarbled("%E4%BD%A0%E5%A5%BD")'));
ok('正常中文正文判为可用', !R('captionLooksGarbled(' + JSON.stringify(CAP) + ')'));
ok('正常英文正文判为可用', !R('captionLooksGarbled("What a clean line, honestly impressive.")'));
eq('含时间的正常正文不会被误删', R('normalizeCaption("明天 10:30 开播，记得来看")'), '明天 10:30 开播，记得来看');
ok('插件注入的按钮文字被剥离', !/一键转发|视频剪辑/.test(R('normalizeCaption("正文内容 一键转发 视频剪辑")')));
eq('清洗后限长 1200', R('normalizeCaption("啊".repeat(1500)).length'), 1200);

// ---------------------------------------------------------------- B. DOM 正文定位
// 场景 A：首页视频帖 —— 视频单元只有播放器文字，真正正文在外层 article
const articleA = new El('article');
const capA = new El('div', { className: 'woo-text', text: CAP });
const unitA = new El('div', { className: 'woo-video-main cover' });
unitA.appendChild(new El('span', { className: 'player-tip', text: JUNK }));
articleA.appendChild(capA);
articleA.appendChild(unitA);
body.appendChild(articleA);
vm.runInContext('globalThis.__articleA = null; globalThis.__unitA = null;', ctx);
ctx.__articleA = articleA; ctx.__unitA = unitA;
eq('视频单元向上找到外层 article 的真实正文', R('resolveVideoCaption(__unitA).text'), CAP);
eq('该正文来源标为页面正文 / data-text / 页面标注', R('resolveVideoCaption(__unitA).ok'), true);
eq('直接传 article 也能拿到同一段正文', R('resolveVideoCaption(__articleA).text'), CAP);
const oldText = R('resolvePost(__unitA).text');
ok('旧 resolvePost() 在播放器单元上拿不到真实正文（空或乱码）',
  oldText !== CAP && (oldText === '' || /[\ue000-\uf8ff]|00:00|万次播放/.test(oldText)),
  String(oldText).slice(0, 80));

// 场景 B：正文只存在 data-text 属性，且是百分号编码
const articleB = new El('article');
const capB = new El('span', { attrs: { 'data-text': encodeURIComponent('新视频上线了，欢迎大家来点赞。') } });
articleB.appendChild(capB);
body.appendChild(articleB);
ctx.__articleB = articleB;
eq('data-text 属性里的百分号编码正文被还原',
  R('resolveVideoCaption(__articleB).text'), '新视频上线了，欢迎大家来点赞。');
eq('data-text 来源标注', R('resolveVideoCaption(__articleB).source'), 'data-text');

// 场景 C：/tv 播放页只有 og:title
const og = new El('meta', { attrs: { property: 'og:title', content: '这条视频的路灯倒影绝了，值得收藏。' } });
head.appendChild(og);
const unitC = new El('div', { className: 'tv-player', text: JUNK });
body.appendChild(unitC);
ctx.__unitC = unitC;
eq('无正文卡片时回退页面 og:title', R('resolveVideoCaption(__unitC).text'), '这条视频的路灯倒影绝了，值得收藏。');
eq('来源标注为页面标题', R('resolveVideoCaption(__unitC).source'), '页面标题');

// 场景 D：全是乱码，明确返回「未识别」而不是硬塞一段乱码
head.children = head.children.filter((n) => n !== og);
const unitD = new El('div', { className: 'tv-player', text: JUNK + ' [object Object] undefined' });
body.appendChild(unitD);
ctx.__unitD = unitD;
eq('全乱码时 ok=false', R('resolveVideoCaption(__unitD).ok'), false);
eq('全乱码时 text 为空', R('resolveVideoCaption(__unitD).text'), '');
eq('全乱码时来源标为未识别', R('resolveVideoCaption(__unitD).source'), '未识别');

// ---------------------------------------------------------------- C. onVideoStudio 传参
R('globalThis.__studio = null; globalThis.__bgCalls = [];');
R('globalThis.__realStudio = showVideoStudio;');
R('showVideoStudio = (o) => { globalThis.__studio = o; };');
R('bgSend = async (m) => { globalThis.__bgCalls.push(m); return { ok: true, url: "https://cdn.test/a.mp4", source: "页面直链" }; };');
(async () => {
  await R('onVideoStudio(__unitA)');
  const o = ctx.__studio;
  ok('onVideoStudio 成功弹出工作台', !!o);
  eq('工作台拿到的是真实中文正文，不是乱码', o && o.text, CAP);
  eq('captionOk=true', o && o.captionOk, true);
  ok('xUrl 预填的是真实正文',
    !!o && decodeURIComponent(new URL(o.xUrl).searchParams.get('text') || '') === CAP,
    o && o.xUrl);
  eq('VIDEO_RESOLVE 仍然只发一次', ctx.__bgCalls.length, 1);
  eq('VIDEO_RESOLVE 带的 bid 未被改动', ctx.__bgCalls[0].type, 'VIDEO_RESOLVE');

  // 全乱码时：不预填乱码，工作台标记为未识别
  ctx.__studio = null;
  await R('onVideoStudio(__unitD)');
  const d = ctx.__studio;
  ok('乱码卡片也能打开工作台（改为手动填写）', !!d);
  eq('乱码卡片 captionOk=false', d && d.captionOk, false);
  eq('乱码卡片 text 为空', d && d.text, '');
  ok('乱码卡片 xUrl 不带乱码', !!d && !/[\ue000-\uf8ff]|%E6%AC%A1|undefined/.test(d.xUrl));

  // -------------------------------------------------------------- D. 工作台文本框
  R('showVideoStudio = globalThis.__realStudio;');
  R('window.open = (u) => { globalThis.__opened = u; return {}; };');
  R('globalThis.__opened = null;');
  R('showVideoStudio({ url: "https://cdn.test/a.mp4", source: "页面直链", text: ' +
    JSON.stringify(CAP) + ', xUrl: "https://x.com/intent/tweet?text=old", ' +
    'captionOk: true, captionSource: "页面正文", videoUrls: [], bid: "", preferHD: true })');
  const panel = R('wbxVideoStudio && wbxVideoStudio.root');
  ok('工作台面板已挂载', !!panel);
  const all = panel ? desc(panel) : [];
  const capInput = all.find((n) => String(n.className || '').includes('wbx-vs-cap-input'));
  const capLabel = all.find((n) => String(n.className || '').includes('wbx-vs-cap-label'));
  const capHint = all.find((n) => String(n.className || '').includes('wbx-vs-hint') &&
    /已读取本条微博正文/.test(n.textContent || ''));
  const openX = all.find((n) => String(n.className || '').includes('wbx-vs-open'));
  ok('工作台显示「发推正文（可修改）」文本框', !!capInput && capInput.tagName === 'TEXTAREA');
  eq('文本框预填真实正文', capInput && capInput.value, CAP);
  ok('标签与来源提示都在',
    !!capLabel && /可修改/.test(capLabel.textContent || '') && !!capHint);
  ok('未识别状态不加 miss 样式',
    !!capInput && !String(capInput.className).includes('wbx-vs-cap-miss'));

  capInput.value = '我自己改过的正文，带个 emoji 👍';
  ok('打开 X 按钮已绑定点击', !!openX && !!(openX.listeners.click || []).length);
  (openX.listeners.click || [])[0]({ preventDefault() {}, stopPropagation() {} });
  const opened = ctx.__opened;
  eq('打开 X 用的是用户修改后的正文',
    decodeURIComponent(new URL(String(opened)).searchParams.get('text') || ''),
    '我自己改过的正文，带个 emoji 👍');
  ok('X 预填不再是旧的乱码 / 旧文本',
    !!opened && !/old|undefined|%E6%AC%A1|[\ue000-\uf8ff]/.test(String(opened)));

  // 未识别状态：红色提示 + 空框，用户手填后照样能发
  R('globalThis.__opened = null;');
  R('showVideoStudio({ url: "https://cdn.test/b.mp4", source: "页面直链", text: "", ' +
    'xUrl: "https://x.com/intent/tweet?text=", captionOk: false, captionSource: "未识别", ' +
    'videoUrls: [], bid: "", preferHD: false })');
  const panel2 = R('wbxVideoStudio && wbxVideoStudio.root');
  const all2 = panel2 ? desc(panel2) : [];
  const cap2 = all2.find((n) => String(n.className || '').includes('wbx-vs-cap-input'));
  const hint2 = all2.find((n) => /请手动填写/.test(n.textContent || ''));
  const openX2 = all2.find((n) => String(n.className || '').includes('wbx-vs-open'));
  ok('未识别时文本框有 miss 样式', !!cap2 && String(cap2.className).includes('wbx-vs-cap-miss'));
  eq('未识别时文本框为空（不预填乱码）', cap2 && cap2.value, '');
  ok('未识别时明确提示手动填写', !!hint2);
  cap2.value = '手动补上的正文';
  (openX2.listeners.click || [])[0]({ preventDefault() {}, stopPropagation() {} });
  eq('手动补写后能正常预填到 X',
    decodeURIComponent(new URL(String(ctx.__opened)).searchParams.get('text') || ''), '手动补上的正文');

  // 旧入口（handleResult / 外部调用）不带 captionOk 且传了乱码：工作台自己兜住
  R('globalThis.__opened = null;');
  R('showVideoStudio({ url: "https://cdn.test/c.mp4", source: "页面直链", text: ' +
    JSON.stringify(JUNK) + ', xUrl: "https://x.com/intent/tweet?text=bad", ' +
    'videoUrls: [], bid: "", preferHD: false })');
  const panel3 = R('wbxVideoStudio && wbxVideoStudio.root');
  const all3 = panel3 ? desc(panel3) : [];
  const cap3 = all3.find((n) => String(n.className || '').includes('wbx-vs-cap-input'));
  const openX3 = all3.find((n) => String(n.className || '').includes('wbx-vs-open'));
  ok('旧入口传乱码时文本框被清空', !!cap3 && cap3.value === '');
  ok('旧入口传乱码时标 miss 样式', !!cap3 && String(cap3.className).includes('wbx-vs-cap-miss'));
  (openX3.listeners.click || [])[0]({ preventDefault() {}, stopPropagation() {} });
  eq('旧入口乱码不会被预填到 X',
    decodeURIComponent(new URL(String(ctx.__opened)).searchParams.get('text') || ''), '');
  cap3.value = '用户重新填写的正确正文';
  (openX3.listeners.click || [])[0]({ preventDefault() {}, stopPropagation() {} });
  eq('旧入口手填后能正常发推',
    decodeURIComponent(new URL(String(ctx.__opened)).searchParams.get('text') || ''), '用户重新填写的正确正文');

  // -------------------------------------------------------------- E. 结构口径
  ok('onVideoStudio 不再直接使用 resolvePost().text 当正文',
    !/cleanRepostText\(post\.text, hashMode\)/.test(
      contentJs.slice(contentJs.indexOf('async function onVideoStudio('),
                      contentJs.indexOf('function showVideoStudio('))));
  ok('工作台 CSS 含可编辑文本框样式', /\.wbx-vs-cap-input\{/.test(contentJs));
  ok('一键转发仍以 resolvePost 为主路径，仅视频帖纠正乱码',
    (contentJs.match(/cleanRepostText\(post\.text, hashMode\)/g) || []).length === 1 &&
    /async function onRepost\(card, btn\) \{[\s\S]{0,1100}cleanRepostText\(post\.text, hashMode\)/.test(contentJs) &&
    /if \(post\.hasVideo && \(!SITE \|\| SITE\.id === 'weibo'\)\)[\s\S]{0,300}resolveVideoCaption\(card\)/.test(contentJs));
  ok('一键转发打开的工作台也带正文状态',
    /captionOk: !!text && !captionLooksGarbled\(normalizeCaption\(text\)\)/.test(contentJs));
  ok('工作台对未带 captionOk 的旧调用自行校验',
    /const capOk = o\.captionOk === false \? false/.test(contentJs));

  console.log('\n结果：' + pass + '/' + (pass + fail) +
    (fail ? '，' + fail + ' 条失败 ❌' : '  全部通过 ✓'));
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.log('ERROR ❌ ' + (e && e.stack || e));
  process.exitCode = 1;
});
