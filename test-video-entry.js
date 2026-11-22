/* TapePost 1.5.4 · 视频帖「一键转发」入口专项自检
 * 运行：node test-video-entry.js   （不进 Chrome Web Store 商店包）
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
  navigator: { clipboard: { write: () => Promise.resolve() } },
  ClipboardItem: class {},
  requestAnimationFrame: (cb) => setTimeout(cb, 0)
});
vm.runInContext(read('sites.js'), ctx, { filename: 'sites.js' });
vm.runInContext(read('content.js'), ctx, { filename: 'content.js' });

const mkLink = (text) => new El('a', {
  attrs: { href: 'https://video.weibo.com/show?fid=1034:5364528154869813' },
  text, rect: { width: 260, height: 22, top: 0, left: 0, right: 260, bottom: 22 }
});
const mkPlay = () => new El('button', {
  attrs: { title: '播放视频' }, text: '播放视频',
  rect: { width: 60, height: 60, top: 0, left: 0, right: 60, bottom: 60 }
});

// 场景 A：首页视频微博（<article>，含正文 + 播放器 + 视频链接 + 播放按钮）
const article = new El('article', {
  text: '博主昵称 11-12 20:32 ',
  rect: { width: 640, height: 520, top: 100, left: 480, right: 1120, bottom: 620 }
});
const textNode = new El('div', { className: 'woo-text', text: '这走位也太丝滑了吧 ' });
const cover = new El('div', { className: 'woo-video-main cover', rect: { width: 540, height: 300, top: 0, left: 0, right: 540, bottom: 300 } });
cover.appendChild(mkLink('吩系的微博视频'));
cover.appendChild(mkPlay());
article.appendChild(textNode);
article.appendChild(cover);
body.appendChild(article);

// 场景 B：/tv 视频频道网格单元（不在任何卡片选择器里）
const grid = new El('div', {
  className: 'video-card', text: '推荐视频标题 ',
  rect: { width: 380, height: 260, top: 700, left: 100, right: 480, bottom: 960 }
});
grid.appendChild(mkLink('推荐视频标题'));
grid.appendChild(mkPlay());
body.appendChild(grid);

// 场景 C：普通图文帖（仍应走卡片内标准按钮组）
const plain = new El('article', {
  text: '图文博主 11-13 13:00 ',
  rect: { width: 640, height: 300, top: 1000, left: 480, right: 1120, bottom: 1300 }
});
const plainText = new El('div', { className: 'woo-text', text: '今天天气不错，随手拍一张。' });
plain.appendChild(plainText);
body.appendChild(plain);

ctx.__article = article;
ctx.__grid = grid;
ctx.__plain = plain;
const R = (expr) => vm.runInContext(expr, ctx, { timeout: 5000 });
const barsInBody = () => body.querySelectorAll('.wbx-video-entry');
const barsInCard = () => article.querySelectorAll('.wbx-video-entry');

const checks = [];
const A = (name, cond, extra) => checks.push({ name, pass: !!cond, extra });

// ---- 标准注入：视频卡不再往卡片内挂按钮组 ----
A('SITE 识别为 weibo', R('SITE && SITE.id') === 'weibo');
A('首页视频帖被识别为视频内容', R('hasVideoElement(__article)') === true);
R('injectStyle(); injectIntoCard(__article);');
A('视频卡片内不再挂标准按钮组（交给根层入口）',
  article.querySelectorAll('.wbx-btn-group').length === 0);
A('视频卡片指纹已记录，不会每轮反复删建', !!article.dataset.wbxFp);

// ---- 图文帖不受影响 ----
R('injectIntoCard(__plain);');
A('图文帖仍走卡片内标准按钮组', plain.querySelectorAll('.wbx-btn-group').length === 1);
A('图文帖仍有「一键转发」', plain.querySelectorAll('.wbx-repost-btn').length === 1);

// ---- 根层固定条 ----
R('injectVideoEntries();');
const bars = barsInBody();
A('视频入口挂在 document.body（不进卡片 DOM）',
  bars.length === 2 && bars.every((b) => b.parentElement === body), 'n=' + bars.length);
A('每条视频内容各一个入口，卡片内没有残留', barsInCard().length === 0);
A('入口含「一键转发」与「视频剪辑」',
  bars.every((b) => b.querySelectorAll('.wbx-fwd-btn').length === 1 &&
                    b.querySelectorAll('.wbx-clip-btn').length === 1));
A('MAP F联的正是视频内容单元', R('VIDEO_BARS.size') === 2 &&
  R('VIDEO_BARS.has(__article) && VIDEO_BARS.has(__grid)'));
const barA = R('VIDEO_BARS.get(__article)');
A('固定条按卡片 rect 定位到右上角',
  barA.style.display === 'inline-flex' &&
  barA.style.left === (1120 - 156 - 10) + 'px' && barA.style.top === '106px',
  JSON.stringify(barA.style));
A('按钮点击绑定的是真实卡片，不是固定条自身',
  barA.querySelectorAll('.wbx-fwd-btn')[0].textContent === '一键转发');

// ---- 重复扫描 / 旧版残留 ----
R('injectVideoEntries(); injectVideoEntries();');
A('重复扫描不重复创建入口', barsInBody().length === 2);
const stale = new El('div', { className: 'wbx-video-entry', text: '旧版残留' });
article.appendChild(stale);
R('injectVideoEntries();');
A('1.5.2/1.5.3 挂在卡片内的旧悬浮条被清理',
  !stale.isConnected && barsInBody().length === 2);

// ---- 模拟微博框架把卡片内所有外来节点抹掉 ----
const fakeGroup = new El('div', { className: 'wbx-btn-group', text: '一键转发' });
article.appendChild(fakeGroup);
fakeGroup.remove();   // 框架重渲染抹掉
R('injectVideoEntries();');
A('卡片内节点被抹掉后入口依然存在（根层不受影响）',
  barsInBody().length === 2 && article.querySelectorAll('.wbx-video-entry').length === 0);

// ---- 滚动跟随 / 出视口隐藏 ----
article.rect = Object.assign({}, article.rect, { top: 1200, bottom: 1720 });
R('updateVideoBars();');
A('卡片滚出视口时入口自动隐藏', R('VIDEO_BARS.get(__article).style.display') === 'none');
article.rect = Object.assign({}, article.rect, { top: 100, bottom: 620 });
R('updateVideoBars();');
A('卡片滚回视口时入口重新显示并回到右上角',
  R('VIDEO_BARS.get(__article).style.display') === 'inline-flex' &&
  R('VIDEO_BARS.get(__article).style.top') === '106px');

// ---- 卡片被虚拟列表移除时清理 ----
grid.remove();
R('injectVideoEntries();');
A('卡片从 DOM 移除后对应入口被回收', barsInBody().length === 1 && R('VIDEO_BARS.size') === 1);

const bad = checks.filter((c) => !c.pass);
console.log('\n=== TapePost 1.5.4 · 视频帖一键转发入口自检 ===');
checks.forEach((c) => console.log((c.pass ? 'PASS ✅ ' : 'FAIL ❌ ') + c.name +
  (c.extra && !c.pass ? '  → ' + c.extra : '')));
console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
process.exit(bad.length ? 1 : 0);
