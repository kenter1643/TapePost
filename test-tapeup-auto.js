/* TapePost 1.5.14 · TapeUP 资产「定时自动采集」专项自检
 * 运行：node test-tapeup-auto.js   （不进 Chrome Web Store 商店包）
 *
 * 背景：1.5.13 只在用户手动打开 tapeup.io「我的资产」页时才采集，弹窗里
 * 一直显示「未采集」。1.5.14 把采集挂进定时 alarm / 价格轮询 / 打开弹窗 /
 * 点刷新资产 / 状态标签点击，没有已打开页面时静默开一个后台标签，采完自动关闭。
 *
 * 本脚本把 background.js 里 TAPEUP_AUTO_BEGIN / END 之间的真实代码抽出来，
 * 在 Node vm 里注入 chrome.alarms / tabs / storage stub 后运行，验证状态机、
 * 标签生命周期、失败降频与不覆盖缓存；再对全链路接线做源码断言。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const TapePrice = require(path.join(DIR, 'price.js'));
const man = require(path.join(DIR, 'manifest.json'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}
function eq(name, actual, expect) { ok(actual === expect, name + '（实际 ' + JSON.stringify(actual) + '）'); }

const BG = read('background.js');
const A = BG.indexOf('/* === TAPEUP_AUTO_BEGIN ===');
const B = BG.indexOf('/* === TAPEUP_AUTO_END === */');
if (A < 0 || B < 0) { console.error('自动采集区块标记缺失，无法自检'); process.exit(1); }
const BLOCK = BG.slice(A, B);

/* ---------- 1. 真实区块的 vm 运行环境 ---------- */
function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const tabState = Object.assign({}, opts.tabs || {});
  const alarms = [], alarmHandlers = [], installed = [], startup = [];
  const createdTabs = [], removedTabs = [], tabMessages = [], timers = [];
  let nextId = 500;
  const chrome = {
    storage: {
      local: {
        get(key, cb) {
          const k = Array.isArray(key) ? key[0] : key;
          const o = {}; o[k] = store[k];
          cb(o);
        },
        set(obj, cb) { Object.assign(store, obj); if (cb) cb(); },
        remove(key, cb) {
          (Array.isArray(key) ? key : [key]).forEach((k) => { delete store[k]; });
          if (cb) cb();
        }
      }
    },
    alarms: {
      create(name, info) { alarms.push({ name: name, info: info }); },
      onAlarm: { addListener(fn) { alarmHandlers.push(fn); } }
    },
    runtime: {
      onInstalled: { addListener(fn) { installed.push(fn); } },
      onStartup: { addListener(fn) { startup.push(fn); } }
    },
    tabs: {
      query(q) { return Promise.resolve(opts.queryTabs || []); },
      create(o) {
        createdTabs.push(o);
        const id = nextId++;
        tabState[id] = { id: id, active: false, url: o.url };
        return Promise.resolve({ id: id });
      },
      get(id) { return Promise.resolve(tabState[id] || null); },
      remove(id) { removedTabs.push(id); delete tabState[id]; return Promise.resolve(); },
      sendMessage(id, msg) { tabMessages.push({ id: id, msg: msg }); return Promise.resolve({ ok: true }); }
    }
  };
  const sandbox = {
    chrome: chrome,
    console: { log() {}, warn() {} },
    setTimeout(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimeout() {},
    TapePrice: TapePrice,
    localGet(key, fallback) {
      return Promise.resolve(store[key] != null ? store[key] : (fallback === undefined ? null : fallback));
    },
    localSet(obj) { Object.assign(store, obj); return Promise.resolve(true); }
  };
  vm.createContext(sandbox);
  vm.runInContext(BLOCK, sandbox, { filename: 'background.js#TAPEUP_AUTO' });
  return {
    store: store, chrome: chrome, alarms: alarms, alarmHandlers: alarmHandlers,
    installed: installed, startup: startup, createdTabs: createdTabs, removedTabs: removedTabs,
    tabMessages: tabMessages, timers: timers, tabState: tabState,
    collect: sandbox.__tapeupAutoCollect,
    finish: sandbox.__tapeupAutoFinish,
    apply: sandbox.__tapeupAutoApply,
    status: () => store['tapeupAssetsStatusV1'] || null,
    cache: () => store['tapeupAssetsCache'] || null,
    pending: () => store['tapeupAutoTabV1'] || null
  };
}
const GOOD = {
  ok: true, connected: true, at: Date.now(), tokenCount: 1, tokenName: 'UP', note: '命中 5/5 列',
  fields: {
    held: { value: 123.4567, raw: '123.4567', unit: '' },
    pending: { value: 8.78, raw: '8.78 BEM', unit: 'BEM' },
    boostable: { value: 3.21, raw: '3.21 BEM', unit: 'BEM' },
    valueUsd: { value: 31.81, raw: '$31.81', unit: '$' },
    changePct: { value: 19.44, raw: '+19.44%', unit: '%' }
  },
  probe: { connected: true, ok: true, note: '命中 5/5 列', strategy: 'columns', textLen: 900, headerFound: true }
};
const NEED_WALLET = {
  ok: false, connected: false, fields: {}, at: Date.now(),
  probe: { connected: false, ok: false, note: '页面提示先连接钱包', strategy: 'none', textLen: 120, headerFound: true }
};
const NO_FIELDS = {
  ok: false, connected: true, fields: {}, at: Date.now(),
  probe: { connected: true, ok: false, note: '页面已连接但没认出数值列', strategy: 'none', textLen: 60, headerFound: false }
};
const TAPEUP_URL = 'https://tapeup.io/zh/trade/assets';

/* ---------- 2. 定时注册与触发入口 ---------- */
(async function () {
  const e0 = makeEnv({ store: { wbxWalletBindV1: 'encrypted-envelope' } });
  ok(e0.alarms.some((a) => a.name === 'tapeupAssetsPoll' && a.info.periodInMinutes === 30),
    '后台：注册 30 分钟自动采集 alarm');
  ok(e0.installed.length === 1 && e0.startup.length === 1, '后台：安装 / 启动都会重注册 alarm');
  ok(e0.alarmHandlers.length === 1, '后台：alarm 监听器已注册');
  ok(/tuCollect\('price-poll'\)/.test(BG), '后台：价格定时轮询联动采集');
  ok(/WALLET_STATUS[\s\S]{0,260}__tapeupAutoCollect\('popup'\)/.test(BG), '后台：打开弹窗触发采集');
  ok(/ASSETS_GET[\s\S]{0,320}__tapeupAutoCollect\('refresh', true\)/.test(BG), '后台：点刷新资产强制触发采集');
  ok(/ASSETS_TAPEUP_COLLECT[\s\S]{0,320}__tapeupAutoCollect\('manual', true\)/.test(BG),
    '后台：状态标签点击走 manual 强制采集');
  ok(/WALLET_CLEAR[\s\S]{0,220}__tapeupAutoFinish/.test(BG), '后台：断开钱包收掉自动标签');
  ok(/sremove\(\[K_BIND, K_ASSETS, K_TAPEUP_ASSETS, 'tapeupAssetsStatusV1', 'tapeupAutoTabV1'\]\)/.test(BG),
    '后台：断开钱包清掉缓存与状态');

  /* ---------- 3. 标签生命周期 ---------- */
  const e1 = makeEnv({});
  eq('无钱包绑定：不采集', await e1.collect('popup'), false);
  eq('无钱包绑定：状态', e1.status().state, 'no-wallet');
  eq('无钱包绑定：不开标签', e1.createdTabs.length, 0);

  const e2 = makeEnv({ store: { wbxWalletBindV1: 'encrypted-envelope' } });
  eq('有钱包且无缓存：发起采集', await e2.collect('popup'), true);
  eq('静默标签数量', e2.createdTabs.length, 1);
  eq('标签不激活', e2.createdTabs[0].active, false);
  ok(/\/zh\/trade\/assets/.test(e2.createdTabs[0].url) && /tpauto=1/.test(e2.createdTabs[0].url),
    '自动标签指向资产页并带自动标记');
  eq('采集状态', e2.status().state, 'collecting');
  ok(!!e2.pending() && e2.pending().id != null, '记录自动标签 id');
  ok(e2.alarms.some((a) => a.name === 'tapeupAssetsCleanup' && a.info.delayInMinutes === 1),
    '注册一次性清理 alarm（防 SW 被回收）');
  eq('25 秒超时定时器', e2.timers[0] && e2.timers[0].ms, 25000);
  eq('pending 未超时：不重复开标签', await e2.collect('alarm'), false);
  eq('重复触发后标签仍只有一个', e2.createdTabs.length, 1);

  const e3 = makeEnv({
    store: { wbxWalletBindV1: 'encrypted-envelope' },
    queryTabs: [{ id: 77, url: TAPEUP_URL, active: true }]
  });
  eq('已有资产页：发起扫描', await e3.collect('popup'), true);
  eq('已有资产页：不新开标签', e3.createdTabs.length, 0);
  eq('已有资产页：只发扫描消息', e3.tabMessages.length, 1);
  eq('扫描消息类型', e3.tabMessages[0].msg.type, 'TAPUP_ASSETS_SCAN');
  eq('扫描目标标签', e3.tabMessages[0].id, 77);

  const e4 = makeEnv({
    store: {
      wbxWalletBindV1: 'encrypted-envelope',
      tapeupAssetsCache: Object.assign({}, GOOD, { at: Date.now() - 60000 })
    }
  });
  eq('缓存新鲜：定时跳过', await e4.collect('alarm'), false);
  eq('缓存新鲜：不开标签', e4.createdTabs.length, 0);
  eq('点刷新 force：强制执行', await e4.collect('refresh', true), true);
  eq('点刷新 force：开了标签', e4.createdTabs.length, 1);

  /* ---------- 4. 回传处理 ---------- */
  const e5 = makeEnv({ store: { wbxWalletBindV1: 'encrypted-envelope' } });
  await e5.collect('popup');
  const autoTabId = e5.pending().id;
  eq('成功回传', await e5.apply(GOOD, TAPEUP_URL), 'collected');
  ok(!!e5.cache() && e5.cache().fields.held.value === 123.4567, '白名单清洗后写入本机缓存');
  ok(!e5.cache().address && !e5.cache().probe, '缓存里没有地址 / 页面原文 / probe');
  eq('状态：已采集', e5.status().state, 'collected');
  eq('fails 清零', e5.status().fails, 0);
  eq('自动标签已关闭', e5.removedTabs[0], autoTabId);
  eq('pending 已清空', e5.pending(), null);
  eq('非 tapeup 来源被拒', await e5.apply(GOOD, 'https://evil.example.com/zh/trade/assets'), 'rejected');

  const e6 = makeEnv({
    // 缓存已过期才会触发新一轮自动采集；同时保留旧数值，用来验证诊断不覆盖它
    store: { wbxWalletBindV1: 'encrypted-envelope', tapeupAssetsCache: Object.assign({}, GOOD, { at: Date.now() - 31 * 60000 }) }
  });
  await e6.collect('popup');
  const stillPending = !!e6.pending();
  eq('诊断：未连站内钱包', await e6.apply(NEED_WALLET, TAPEUP_URL), 'need-wallet');
  eq('诊断状态', e6.status().state, 'need-wallet');
  eq('诊断不覆盖已有缓存', e6.cache().fields.held.value, 123.4567);
  ok(stillPending && !!e6.pending(), '诊断不立刻关标签（给异步渲染留时间）');
  eq('同一状态 60 秒内不重复累加 fails', e6.status().fails, 1);
  await e6.apply(NEED_WALLET, TAPEUP_URL);
  eq('重复诊断不刷 fails', e6.status().fails, 1);

  const e7 = makeEnv({ store: { wbxWalletBindV1: 'encrypted-envelope' } });
  await e7.collect('popup');
  eq('诊断：没认出数值列', await e7.apply(NO_FIELDS, TAPEUP_URL), 'no-fields');
  eq('诊断：不写空缓存', e7.cache(), null);
  eq('诊断：状态', e7.status().state, 'no-fields');

  const e8 = makeEnv({ store: { wbxWalletBindV1: 'encrypted-envelope' } });
  await e8.collect('popup');
  const t8 = e8.pending().id;
  eq('超时收尾', await e8.finish('timeout'), true);
  eq('超时状态', e8.status().state, 'timeout');
  eq('超时 fails 记 1', e8.status().fails, 1);
  eq('超时关闭标签', e8.removedTabs[0], t8);
  eq('超时清 pending', e8.pending(), null);

  const e9 = makeEnv({ store: { wbxWalletBindV1: 'encrypted-envelope' } });
  await e9.collect('popup');
  e9.tabState[e9.pending().id].active = true;   // 用户中途切到这个标签
  await e9.finish('done');
  eq('用户正在看的标签不抢着关', e9.removedTabs.length, 0);

  const e10 = makeEnv({
    store: {
      wbxWalletBindV1: 'encrypted-envelope',
      tapeupAssetsStatusV1: { state: 'timeout', note: '上次超时', at: Date.now(), fails: 1 }
    }
  });
  eq('连续失败降频：本次跳过', await e10.collect('alarm'), false);
  eq('降频期间不开标签', e10.createdTabs.length, 0);
  e10.store['tapeupAssetsStatusV1'].at = Date.now() - 61 * 60000;
  eq('超过降频窗口后恢复', await e10.collect('alarm'), true);
  eq('恢复后开标签', e10.createdTabs.length, 1);

  /* ---------- 5. 接线与边界 ---------- */
  const tp = read('tapeup-price.js');
  const pop = read('popup.js');
  ok(/TAPUP_ASSETS_SCAN/.test(tp), '内容脚本：监听后台催扫消息');
  ok(/sendAssets\(true, true\)/.test(tp), '内容脚本：催扫时强制重扫并重发');
  ok(/probe:\s*\{/.test(tp) && /fields: r\.ok \? r\.fields : \{\}/.test(tp),
    '内容脚本：失败回传只带诊断、不带数值');
  ok(/ASSETS_TAPEUP_COLLECT/.test(pop) && /chrome\.storage\.onChanged/.test(pop),
    '弹窗：立即采集按钮 + 缓存变化自动回刷');
  ok(/采集中…/.test(pop) && /需连站内钱包/.test(pop) && /本次未读到/.test(pop),
    '弹窗：状态不再是笼统的「未采集」');
  ok(/每 30 分钟自动采集/.test(pop), '弹窗：说明自动采集周期');
  ok(/tuApplyPayload\(msg && msg\.payload/.test(BG), '后台：回传统一走清洗与状态机');
  eq('permissions 仍 9 项', man.permissions.length, 9);
  eq('host_permissions 仍 36 条', man.host_permissions.length, 36);
  ok(!/tapeupAssetsPoll|tapeupAssetsCleanup/.test(JSON.stringify(man.permissions)),
    '未新增 permissions（alarms 早已在列）');

  console.log('\n结果：' + pass + '/' + (pass + fail) + ' 通过，' + fail + ' 条失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('自检异常：', e);
  process.exit(1);
});
