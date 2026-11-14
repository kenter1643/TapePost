/*
 * test-bg-reconnect.js — 1.5.11 后台连接自愈专项自检（不进商店包）
 *
 * 直接抽取 content.js 里 BG_LINK_BEGIN / BG_LINK_END 之间的真实代码，
 * 在 Node vm 里注入 chrome / DOM / setTimeout stub 后运行，验证：
 *   冷启动丢消息自动重连、业务错误不误重试、有副作用的错误不重发、
 *   上下文真失效时触发自动恢复、长任务限次、静态接线完整。
 *
 * 运行：node test-bg-reconnect.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log('  PASS ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const A = SRC.indexOf('/* === BG_LINK_BEGIN === */');
const B = SRC.indexOf('/* === BG_LINK_END === */');
if (A < 0 || B < 0) {
  console.error('BG_LINK 区块标记缺失，无法自检');
  process.exit(1);
}
const BLOCK = SRC.slice(A, B);

function fakeEl(tag) {
  const el = {
    tag, style: {}, children: [], textContent: '', id: '',
    attrs: {}, handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'style') this.cssText = v; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(k, fn) { this.handlers[k] = fn; },
    remove() { this.removed = true; }
  };
  return el;
}

function makeEnv(handler) {
  const calls = [];       // 业务消息类型
  const wakes = [];       // TAPE_WAKE 次数
  const toasts = [];      // 提示文案
  const created = [];     // 创建的 DOM 元素
  const reloads = [];
  const stored = {};
  const sessionStorage = {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem: (k, v) => { stored[k] = String(v); }
  };
  const chrome = {
    runtime: {
      sendMessage: (msg) => {
        if (msg && msg.type === 'TAPE_WAKE') {
          wakes.push(1);
          return Promise.resolve({ ok: true, wake: true });
        }
        calls.push(msg && msg.type);
        return handler(msg, calls.length);
      }
    }
  };
  const document = {
    getElementById: () => null,
    createElement: (tag) => { const e = fakeEl(tag); created.push(e); return e; },
    body: { appendChild: () => {} },
    documentElement: { appendChild: () => {} }
  };
  const ctx = vm.createContext({
    chrome, document, sessionStorage,
    location: { reload: () => reloads.push(1) },
    showToast: (m) => toasts.push(String(m)),
    console,
    // 退避延时压缩到 1ms，保持「有重试」语义但不拖慢测试
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 2)),
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    Date, Promise, String, Number, Math, Error, JSON
  });
  vm.runInContext(BLOCK + '\n;globalThis.__bg = { bgSend, BG_LINK, bgAutoRecover };', ctx);
  return { api: ctx.__bg, calls, wakes, toasts, created, reloads, stored };
}

const TRANSIENT = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));

(async function () {
  console.log('=== 1.5.11 后台连接自愈自检 ===');

  // ① 冷启动：前两次丢消息，第三次成功 —— 应当自动重连并继续原操作
  {
    const env = makeEnv((msg, n) => (n <= 2 ? TRANSIENT() : Promise.resolve({ ok: true, n })));
    let resp = null, err = null;
    try { resp = await env.api.bgSend({ type: 'CROSSPOST' }); } catch (e) { err = e; }
    ok('冷启动丢消息后自动重连成功', !err && resp && resp.ok === true, String(err && err.message));
    ok('业务消息恰好发送 3 次（2 次重试）', env.calls.length === 3, '实际 ' + env.calls.length);
    ok('重连过程有可见状态提示', env.toasts.some(t => /自动重连/.test(t)));
    ok('成功后提示已恢复', env.toasts.some(t => /已自动恢复后台连接/.test(t)));
    ok('提示不再要求刷新页面', !env.toasts.some(t => /Cmd\+R|请刷新/.test(t)));
  }

  // ② 业务错误不该被误当成连接问题重发
  {
    const env = makeEnv(() => Promise.reject(new Error('发送失败：水印检测异常')));
    let err = null;
    try { await env.api.bgSend({ type: 'CROSSPOST' }); } catch (e) { err = e; }
    ok('业务错误原样抛出', !!err && /水印检测异常/.test(err.message));
    ok('业务错误不重试', env.calls.length === 1, '实际 ' + env.calls.length);
  }

  // ③ 端口关闭意味着后台可能已收到，重发会有副作用 —— 不重试
  {
    const env = makeEnv(() => Promise.reject(new Error('The message port closed before a response was received.')));
    try { await env.api.bgSend({ type: 'VIDEO_RESOLVE' }); } catch (e) {}
    ok('message port closed 不重试（避免重复剪辑/转发）', env.calls.length === 1, '实际 ' + env.calls.length);
  }

  // ④ 真·上下文失效：不浪费重试，触发自动恢复条
  {
    const env = makeEnv(() => Promise.reject(new Error('Extension context invalidated')));
    let err = null;
    try { await env.api.bgSend({ type: 'CROSSPOST' }); } catch (e) { err = e; }
    ok('上下文失效异常透传', !!err && /invalidated/.test(err.message));
    ok('上下文失效不重试', env.calls.length === 1, '实际 ' + env.calls.length);
    ok('自动弹出可取消恢复条', env.created.some(e => e.id === 'wbx-recover'));
    const bar = env.created.find(e => e.id === 'wbx-recover');
    ok('恢复条含「立即恢复 / 取消」两个按钮', !!bar && bar.children.filter(c => c.tag === 'button').length === 2);
    ok('恢复条文案明确无需手动 Cmd+R', !!bar && /无需手动 Cmd\+R/.test(bar.children[0].textContent));
    ok('点「取消」不会刷新页面', (() => {
      const cancel = bar.children.find(c => c.tag === 'button' && c.textContent === '取消');
      cancel.handlers.click();
      return env.reloads.length === 0;
    })());
    ok('点「立即恢复」才刷新并写入防循环标记', (() => {
      const again = bar.children.find(c => c.tag === 'button' && c.textContent === '立即恢复');
      again.handlers.click();
      return env.reloads.length === 1 && 'wbxAutoReloadV1' in env.stored;
    })());
  }

  // ⑤ 60 秒内已恢复过一次 → 不再反复自动刷新
  {
    const env = makeEnv(() => Promise.reject(new Error('Extension context invalidated')));
    env.stored.wbxAutoReloadV1 = String(Date.now() - 1000);
    try { await env.api.bgSend({ type: 'CROSSPOST' }); } catch (e) {}
    ok('防循环：60 秒内不重复自动刷新', !env.created.some(e => e.id === 'wbx-recover'));
  }

  // ⑥ 长耗时视频剪辑限次重试
  {
    const env = makeEnv(TRANSIENT);
    try { await env.api.bgSend({ type: 'VIDEO_EDIT' }); } catch (e) {}
    ok('VIDEO_EDIT 最多发 2 次（避免重复剪辑）', env.calls.length === 2, '实际 ' + env.calls.length);
  }

  // ⑦ 预热：久未通信时先唤醒后台，且连续通信不会反复预热
  {
    const env = makeEnv(() => Promise.resolve({ ok: true }));
    await env.api.bgSend({ type: 'CROSSPOST' });
    await env.api.bgSend({ type: 'CROSSPOST' });
    ok('冷启动时发过 TAPE_WAKE 预热', env.wakes.length === 1, '实际 ' + env.wakes.length);
    ok('热连接不重复预热', env.calls.length === 2, '业务消息 ' + env.calls.length);
  }

  // ⑧ 静态接线：后台早期监听器 + 全部调用点 + 弹窗重试 + 死提示清零
  {
    const bg = fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8');
    const pop = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');
    const head = bg.slice(0, bg.indexOf('// ---- 1. DNR'));
    ok('background.js 顶部有最小 TAPE_WAKE 监听器', /onMessage\.addListener/.test(head) && /TAPE_WAKE/.test(head));
    ok('主监听器跳过 TAPE_WAKE（避免重复回包）', /if \(msg\.type === 'TAPE_WAKE'\) return false;/.test(bg));
    ok('content.js 7 处回包调用全部走 bgSend', (SRC.match(/await bgSend\(\{/g) || []).length === 7);
    ok('content.js 无残留裸 await sendMessage', !/await chrome\.runtime\.sendMessage\(\{/.test(SRC));
    ok('popup.js sendBg 有退避重试', /function sendBg\(msg, cb, _try\)/.test(pop) && /setTimeout\(\(\) => sendBg/.test(pop));
    ok('旧「请刷新页面 Cmd+R」死提示已清除', !/请刷新.*Cmd\+R/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
    const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
    const listing = JSON.parse(fs.readFileSync(path.join(__dirname, 'store', 'listing.json'), 'utf8'));
    ok('版本号统一 1.5.13', manifest.version === '1.5.13' && listing.version === '1.5.13' &&
      /appVersion">v1\.5\.13</.test(html) && /return 'v1\.5\.13';/.test(SRC));
    ok('描述首条为 1.5.13', String(listing.detailed_description[0]).startsWith('【1.5.13'));
  }

  console.log('\n结果：' + passed + '/' + (passed + failed) + ' 通过，' + failed + ' 条失败');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('自检脚本异常：', e); process.exit(1); });
