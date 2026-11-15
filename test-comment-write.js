/* TapePost 1.5.17 · AI 评论回写专项自检
 * 运行：node test-comment-write.js   （不进 Chrome Web Store 商店包）
 *
 * 复现并验证真机 bug：「候选写进评论区变成重复的 2 条、人工无法修改，
 * 但发出去只有正确的一条」——X 受控编辑器 DOM 双写而内部 state 只有一份。
 * 方式：vm 加载 content.js 里真实的写入函数 + 自建 X 编辑器 DOM 桩。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const contentJs = fs.readFileSync(path.join(DIR, 'content.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('FAIL ❌ ' + name + (extra ? ' | ' + extra : '')); }
};
const eq = (name, a, b) => ok(name, a === b, String(a) + ' !== ' + String(b));

// ---------------------------------------------------------------- 抽取真实函数
function grab(name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}\\n');
  const m = contentJs.match(re);
  if (!m) throw new Error('content.js 里找不到函数 ' + name);
  return m[0];
}
const SRC = [
  'nodeText', 'normReplyText', 'replyHasRichContent', 'rewriteReplyOnce',
  'replyPasteReplace', 'replyWriteVerified', 'collapseReplySelection',
  'writeIntoReply', 'applyCommentToReply'
].map(grab).join('\n');

// ---------------------------------------------------------------- X 编辑器 DOM 桩
function makeEnv(o) {
  o = o || {};
  const selection = {
    _ranges: [], rangeCount: 0,
    removeAllRanges() { this._ranges = []; this.rangeCount = 0; },
    addRange(r) { this._ranges.push(r); this.rangeCount = 1; },
    getRangeAt(i) { return this._ranges[i]; }
  };
  const doc = {
    activeElement: null,
    _inserts: [], _pastes: [], _timers: [],
    createRange: () => ({
      __full: false,
      selectNodeContents(el) { this.__el = el; this.__full = true; },
      collapse() { this.__full = false; },
      setStart() {}, setEnd() {}
    }),
    getSelection: () => selection,
    contains: () => true,
    execCommand(cmd, ui, text) {
      doc._inserts.push(String(text));
      if (cmd !== 'insertText') return true;
      if (o.reject) return false;
      const full = !!(selection._ranges[0] && selection._ranges[0].__full);
      const cur = String(doc.activeElement ? doc.activeElement.innerText : '');
      // mode=double 模拟 X 受控编辑器：浏览器原生写一份 + 编辑器 state 再渲染一份
      const next = o.mode === 'double' ? String(text) + String(text)
        : (full ? String(text) : cur + String(text));
      setText(next);
      return true;
    }
  };
  const input = {
    innerText: o.initial || '', textContent: o.initial || '',
    parentElement: {}, _handlers: {},
    focus() { doc.activeElement = input; },
    querySelectorAll() { return o.rich ? [{}] : []; },
    dispatchEvent(ev) {
      doc._pastes.push(ev);
      if (o.pasteHandled) {
        ev.preventDefault();               // X 接管了粘贴，自己更新 state
        const t = ev.clipboardData.getData('text/plain');
        if (!o.pasteDelay) setText(o.pasteDouble ? t + t : t);
        else doc._pendingText = t;         // React 在微任务里才渲染
      }
      return !ev.defaultPrevented;
    }
  };
  function setText(s) { input.innerText = s; input.textContent = s; }

  class DataTransfer {
    constructor() { this._d = {}; }
    setData(k, v) { this._d[k] = String(v); }
    getData(k) { return this._d[k] || ''; }
  }
  class ClipboardEvent {
    constructor(type, opts) {
      this.type = type; Object.assign(this, opts || {}); this.defaultPrevented = false;
    }
    preventDefault() { this.defaultPrevented = true; }
  }

  const g = {
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window: { getSelection: () => selection, open: () => { g.__opened++; return {}; } },
    setTimeout: (fn) => { doc._timers.push(fn); return 1; },
    clearTimeout: () => {},
    findReplyComposers: () => [],
    showToast: (t) => { doc._toasts.push(String(t)); },
    copyTextFallback: () => Promise.resolve(true),
    String, Number, Object, Array, Math, JSON, RegExp, Date, Promise,
    parseInt, isFinite,
    __opened: 0
  };
  doc._toasts = [];
  if (o.paste) { g.DataTransfer = DataTransfer; g.ClipboardEvent = ClipboardEvent; }
  const ctx = vm.createContext(g);
  vm.runInContext(SRC, ctx, { filename: 'content-write-extract.js' });
  const btn = { __wbxReply: true, __wbxInput: input, __wbxScope: {} };
  ctx.__wbxInput = input;
  ctx.__wbxBtn = btn;
  return { ctx, doc, input, btn, setText, selection };
}
const call = (e, expr) => vm.runInContext(expr, e.ctx);

// ---------------------------------------------------------------- 1. 正常写入
{
  const e = makeEnv();
  eq('空框写入成功', call(e, 'writeIntoReply(__wbxInput, "候选甲")'), true);
  eq('空框文本恰好一份', e.input.innerText, '候选甲');
  eq('正常写入只调用一次 execCommand', e.doc._inserts.length, 1);
  eq('已有草稿时整段重写、原文不动', call(e, 'writeIntoReply(__wbxInput, "候选乙")'), true);
  eq('草稿 + 新候选单独成段', e.input.innerText, '候选甲\n\n候选乙');
  eq('两次写入共两次 execCommand', e.doc._inserts.length, 2);
}

// ---------------------------------------------------------------- 2. 幂等防重复
{
  const e = makeEnv({ initial: '候选甲' });
  eq('同一条候选已在框里：直接视为已写入',
    call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), true);
  eq('幂等分支不再写第二遍', e.doc._inserts.length, 0);
  eq('幂等分支文本保持一份', e.input.innerText, '候选甲');
}
{
  const e = makeEnv();
  e.ctx.__wbxBtn = e.btn;
  call(e, 'applyCommentToReply("候选甲", __wbxBtn)');
  call(e, 'applyCommentToReply("候选甲", __wbxBtn)');
  eq('连点两次也只写一次', e.doc._inserts.length, 1);
  eq('连点后文本没有重复', e.input.innerText, '候选甲');
  eq('连点保护结束后解锁', e.btn.__wbxBusy, false);
}

// ---------------------------------------------------------------- 3. 真机 bug：X 双写
{
  const e = makeEnv({ mode: 'double' });
  e.ctx.__wbxBtn = e.btn;
  eq('DOM 双写时判定为写入失败，不再静默报成功',
    call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), false);
  eq('双写后恢复成空框（不残留重复文本）', e.input.innerText, '');
  eq('恢复标志传给候选面板', e.btn.__wbxRecovered, true);
  eq('恢复成功，不要求刷新', e.btn.__wbxWriteDirty, false);
  eq('绝不第三次重试写入', e.doc._inserts.length, 2);
}
{
  const e = makeEnv({ mode: 'double', initial: '我的草稿' });
  e.ctx.__wbxBtn = e.btn;
  call(e, 'applyCommentToReply("候选甲", __wbxBtn)');
  eq('已有草稿且双写：判定失败', e.input.__wbxWriteRecovered, true);
  eq('恢复也没成功时标 dirty，提示刷新', e.input.__wbxWriteDirty, true);
  eq('绝不无限重试', e.doc._inserts.length, 2);
}
{
  const e = makeEnv({ reject: true });
  e.ctx.__wbxBtn = e.btn;
  eq('execCommand 被拒时返回 false', call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), false);
  eq('被拒时不改 DOM', e.input.innerText, '');
  eq('被拒时设置恢复标志', e.btn.__wbxRecovered, true);
}

// ---------------------------------------------------------------- 4. 粘贴通道（根因修复）
{
  const e = makeEnv({ paste: true, pasteHandled: true });
  e.ctx.__wbxBtn = e.btn;
  eq('X 接管 paste 时写入成功', call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), true);
  eq('粘贴通道下 DOM 只有一份', e.input.innerText, '候选甲');
  eq('粘贴通道绝不叠加 execCommand（双写源头）', e.doc._inserts.length, 0);
  eq('只派发一次 paste 事件', e.doc._pastes.length, 1);
  eq('paste 携带完整候选文本', e.doc._pastes[0].clipboardData.getData('text/plain'), '候选甲');
  ok('paste 事件可取消且已被 X 接管', e.doc._pastes[0].defaultPrevented === true);
}
{
  const e = makeEnv({ paste: true, pasteHandled: true, pasteDelay: true });
  e.ctx.__wbxBtn = e.btn;
  eq('X 异步渲染时先按成功返回，不叠 execCommand',
    call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), true);
  eq('异步渲染场景不调用 execCommand', e.doc._inserts.length, 0);
  eq('安排了一次延后只读校验', e.doc._timers.length, 1);
  e.setText('候选甲');                    // 模拟 React 把 state 渲染进 DOM
  e.doc._timers[0]();
  eq('延后校验通过后文本保持一份', e.input.innerText, '候选甲');
  eq('延后校验通过不做恢复', e.doc._inserts.length, 0);
}
{
  const e = makeEnv({ paste: true, pasteHandled: true, pasteDelay: true, pasteDouble: true });
  e.ctx.__wbxBtn = e.btn;
  call(e, 'applyCommentToReply("候选甲", __wbxBtn)');
  e.setText('候选甲候选甲');              // 模拟 X 渲染成了两份
  e.doc._timers[0]();
  eq('延后校验发现双写时恢复原文', e.input.innerText, '');
  eq('延后恢复也只写一次', e.doc._inserts.length, 1);
}
{
  const e = makeEnv({ paste: true, pasteHandled: false });
  e.ctx.__wbxBtn = e.btn;
  eq('X 不接管 paste 时退回 execCommand',
    call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), true);
  eq('退回通道仍只写一份', e.input.innerText, '候选甲');
  eq('退回通道恰好一次 execCommand', e.doc._inserts.length, 1);
}

// ---------------------------------------------------------------- 5. 其它保护
{
  const e = makeEnv({ rich: true });
  eq('含 @ / 表情 / 配图时拒绝自动写入', call(e, 'writeIntoReply(__wbxInput, "候选甲")'), false);
  eq('富文本保护不动 DOM', e.input.innerText, '');
  eq('富文本保护不调用 execCommand', e.doc._inserts.length, 0);
}
{
  const e = makeEnv();
  e.btn.__wbxInput = null;
  e.ctx.__wbxBtn = e.btn;
  eq('找不到回复框时返回 false', call(e, 'applyCommentToReply("候选甲", __wbxBtn)'), false);
  eq('找不到回复框不会误设恢复标志', e.btn.__wbxRecovered, false);
}
{
  const e = makeEnv({ initial: '我的草稿' });
  eq('草稿 + 候选的写后校验按完整文本判断',
    call(e, 'writeIntoReply(__wbxInput, "候选甲")'), true);
  eq('归一化后仍是草稿 + 候选', e.input.innerText, '我的草稿\n\n候选甲');
}

// ---------------------------------------------------------------- 6. 源码结构断言
ok('写入统一走 replyWriteVerified()',
  contentJs.includes('function replyWriteVerified(') &&
  contentJs.includes('const ok = replyWriteVerified(input, finalText, existing);'));
ok('保留 1.4.11 的一次全量替换写入口',
  contentJs.includes('const ok = rewriteReplyOnce(input, finalText);') &&
  contentJs.includes('r.selectNodeContents(input);'));
ok('已删除「失败就盲写一次原文」的旧逻辑',
  !contentJs.includes('if (!ok) rewriteReplyOnce(input, existing);'));
ok('优先粘贴通道，且粘贴被接管时不再叠加 execCommand',
  contentJs.includes('const paste = replyPasteReplace(input, finalText);') &&
  contentJs.includes('if (paste.handled)') &&
  /绝不再叠一次/.test(contentJs));
ok('写后严格校验完整字符序列',
  contentJs.includes('read() === want') && contentJs.includes('normReplyText(nodeText(input).trim())'));
ok('幂等：候选已在框里就不再追加',
  contentJs.includes('normReplyText(existing).indexOf(normReplyText(text)) >= 0'));
ok('连点保护：按钮与候选按钮都有 busy 锁',
  contentJs.includes('if (btn.__wbxBusy) return false;') &&
  contentJs.includes('if (use.__wbxBusy) return;'));
ok('写入异常时恢复原文并标记 dirty',
  contentJs.includes('input.__wbxWriteDirty = read() !== orig;') &&
  contentJs.includes('input.__wbxWriteRecovered = ok ? false : true;'));
const picker = contentJs.slice(contentJs.indexOf('function showCommentPicker('),
  contentJs.indexOf('// ---------- 结果处理 ----------'));
ok('候选面板：恢复态分支排在 window.open 之前，绝不另开 intent',
  picker.indexOf('if (btn && btn.__wbxRecovered)') > 0 &&
  picker.indexOf('if (btn && btn.__wbxRecovered)') < picker.indexOf('window.open('));
ok('写入成功提示明确说明可以继续手动修改',
  picker.includes('可继续手动修改，再点「回复」'));
ok('恢复态提示区分「原文已恢复」与「需刷新」',
  picker.includes('原文已恢复') && picker.includes('刷新 X 页面'));

// ---------------------------------------------------------------- 7. 候选面板真实点击
function makeEl(tag) {
  const el = {
    tagName: tag, className: '', textContent: '', id: '', title: '', type: '',
    value: '', selected: false, style: {}, children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    remove() { this.removed = true; },
    setAttribute(k, v) { this[k] = v; },
    _all() { return this.children.concat(this.children.reduce((a, c) => a.concat(c._all ? c._all() : []), [])); }
  };
  return el;
}
function pickerEnv(o) {
  o = o || {};
  const doc = {
    _panel: null,
    createElement: makeEl,
    getElementById: (id) => (id === 'wbx-comments' ? doc._panel : null),
    body: Object.assign(makeEl('body'), {
      appendChild(c) { this.children.push(c); if (c.id === 'wbx-comments') doc._panel = c; return c; }
    })
  };
  const g = {
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window: { open: () => { g.__opened++; return {}; } },
    chrome: { storage: { sync: { set: () => {} } } },
    settings: { grokMode: 'deepseek', commentCount: 5, promoEnabled: false, xDomain: 'x.com' },
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    Date, Math, parseInt, isFinite, String, Number, Object, Array, JSON, Promise, URLSearchParams,
    makeCommentEl: (tag, cls, text) => { const n = makeEl(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    hideAiBusy: () => {}, showAiBusy: () => {}, showNotice: () => {},
    showToast: (t) => { doc._toasts.push(String(t)); },
    buildCommentTexts: (cs) => ({ texts: cs, lines: [], enabled: false }),
    applyCommentToReply: () => !!o.wrote,
    copyTextFallback: () => Promise.resolve(true),
    bgSend: () => Promise.resolve({ ok: true }),
    resolveReplyContext: () => null, CARD_SELECTORS: ['article'],
    onAiComment: () => {},
    aiProviderName: () => 'DeepSeek API', aiShortName: () => 'DeepSeek',
    isApiAiMode: () => true, commentCountNow: () => 5,
    __opened: 0
  };
  doc._toasts = [];
  const ctx = vm.createContext(g);
  const body = contentJs.slice(contentJs.indexOf('function showCommentPicker('),
    contentJs.indexOf('// ---------- 结果处理 ----------'));
  vm.runInContext(body, ctx, { filename: 'content-picker-extract.js' });
  const btn = {
    __wbxReply: true, __wbxInput: {}, __wbxScope: {},
    __wbxRecovered: !!o.recovered, __wbxWriteDirty: !!o.dirty
  };
  ctx.__wbxBtn = btn;
  vm.runInContext('showCommentPicker(["候选甲"], "123", null, __wbxBtn, "推文正文", "deepseek", {provider:"DeepSeek API",count:5})',
    ctx, { timeout: 3000 });
  const panel = doc._panel;
  const use = panel && panel._all().find((n) => n.className === 'wbx-c-use');
  if (use && use.listeners.click) {
    use.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  }
  return { g, doc, panel, use, btn, toasts: doc._toasts };
}
{
  const e = pickerEnv({ wrote: false, recovered: true });
  ok('恢复态：生成了写入按钮并触发点击', !!e.use && !!e.panel);
  eq('恢复态：绝不另开 intent 预填页', e.g.__opened, 0);
  ok('恢复态：提示「原文已恢复」并引导手动粘贴',
    e.toasts.some((t) => t.includes('原文已恢复') && t.includes('手动粘贴')), e.toasts.join(' / '));
  eq('恢复态：按钮解锁，可以再选一条', e.use.__wbxBusy, false);
  ok('恢复态：面板保留，方便复制候选', !e.panel.removed);
}
{
  const e = pickerEnv({ wrote: false, recovered: true, dirty: true });
  eq('dirty 态：也不另开 intent', e.g.__opened, 0);
  ok('dirty 态：提示刷新 X 页面',
    e.toasts.some((t) => t.includes('刷新 X 页面')), e.toasts.join(' / '));
}
{
  const e = pickerEnv({ wrote: true });
  eq('成功写入：不另开 intent', e.g.__opened, 0);
  ok('成功写入：提示可继续手动修改',
    e.toasts.some((t) => t.includes('可继续手动修改')), e.toasts.join(' / '));
  ok('成功写入：面板自动关闭', !!e.panel.removed);
}
{
  const e = pickerEnv({ wrote: false, recovered: false });
  eq('找不到回复框：保留原有 intent 兜底', e.g.__opened, 1);
}

console.log('\n结果：' + pass + '/' + (pass + fail) +
  (fail ? '，' + fail + ' 条失败 ❌' : '  全部通过 ✓'));
process.exitCode = fail ? 1 : 0;
