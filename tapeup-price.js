'use strict';
/*
 * tapeup-price.js — 内容脚本：在用户浏览器（已通过 Cloudflare）里读取 tapeup.io 交易页的
 * TapeUP $UP 内盘价，回传给后台缓存。
 *
 * 为什么这么做：tapeup.io 整站 Cloudflare 防护，后台直接 fetch 会被拦；而用户在浏览器里
 * 打开交易页时已经拿到有效会话，内容脚本就能直接读到页面显示的内盘价——这是真正的内盘价格，
 * 不依赖任何外部 DEX / 第三方接口，也不猜接口路径。
 *
 * 1.4.21 真机校准：页面头部价格是「0.0264 BEM/UP  $0.3181  +19.44%」——
 * BEM 计价的内盘价 + 美元折算价 + 24h 涨跌。extractUp 只认 BEM/UP 标签或列表行
 * 「价 $美元 百分比」三连；钱包余额（$BEM0.00049456）、待释放（8.78358728 BEM）、
 * 统计区大数字、图表坐标一律不参与选价，认不出就返回 null 不乱猜。
 *
 * 运行于 ISOLATED world，与 tapeup.io 自身脚本互不干扰；TapePrice 由同 world 的 price.js 提供。
 *
 * 调试浮层：本脚本会在页面右下角渲染一个半透明角标，实时显示抽到的内盘价与候选数字，
 * 便于在真机确认抽取是否正确（点击角标可展开候选列表）。
 *
 * 1.4.22：浮层不再用 maxHeight:22px + overflow:hidden 硬截断——收起时三个数字
 * （BEM/UP 计价 / 美元折算价 / 涨跌）也要完整可见；展开时改为可滚动，列出来源、
 * 锚点、采集时间与全部候选，不再只显示前 8 条。
 *
 * 1.4.23：用户要的「UP 价格」其实是 K 线图右侧绿色当前价标签（随成交跳动的动态价，
 * 与左上角图例「收=0.31542257」一致）。浮层首行改为直接显示这个动态价，第二行
 * 完整保留页头「0.0254 BEM/UP · $0.3154 · +19.25%」三个数；回传也带上 livePrice
 * 等字段，供弹窗主值与提醒使用。
 */
(function () {
  if (!window.TapePrice || typeof window.TapePrice.extractUp !== 'function') {
    // price.js 未注入（理论上不会），不打扰页面
    return;
  }
  var T = window.TapePrice;
  var lastSig = '';

  function ensureProbe() {
    var el = document.getElementById('__tpup_probe');
    if (el) return el;
    el = document.createElement('div');
    el.id = '__tpup_probe';
    el.setAttribute('style', 'position:fixed;right:8px;bottom:8px;z-index:2147483647;' +
      'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#7dffa0;' +
      'background:rgba(0,0,0,.62);padding:5px 8px;border-radius:7px;max-width:360px;' +
      'max-height:70vh;cursor:pointer;white-space:pre-wrap;word-break:break-word;' +
      'overflow-y:auto;box-shadow:0 0 0 1px rgba(125,255,160,.25);');
    el.title = 'TapePost 内盘价探测（点击展开/收起候选）';
    el.addEventListener('click', function () { el.__open = !el.__open; paintProbe(); });
    var root = document.body || document.documentElement;
    if (root) root.appendChild(el);
    return el;
  }

  function paintProbe(r) {
    var el = document.getElementById('__tpup_probe');
    if (!el) return;
    // 复用旧浮层时也要清掉旧版留下的 inline maxHeight:22px
    el.style.maxHeight = '70vh';
    el.style.overflowY = 'auto';
    if (!r) { el.textContent = 'TapePost内盘: 未采集'; return; }
    // 1.4.23：首行＝K 线动态当前价（用户箭头所指的那个数），次行＝页头三个数，全部完整显示
    var head = 'TapePost内盘: ' + (r.livePrice != null ? '$' + r.livePrice : '—') +
      (r.liveSource === 'chart' ? ' ← K线动态价' : ' ← 页头折算价');
    var trio = '页头 ' + (r.value != null ? r.value + ' BEM/UP' : '—') +
      (r.usdValue != null ? ' · $' + r.usdValue : '') +
      (r.changePct != null ? ' · ' + (r.changePct >= 0 ? '+' : '') + r.changePct + '%' : '');
    // 1.4.22：收起态只隐藏候选列表，价格数字始终完整显示，不再设 22px 截断
    if (!el.__open) {
      el.textContent = head + '\n' + trio +
        '\n来源 tapeup.io 交易页（与 Firsto 无关） · 点开看全部候选 ▾';
      return;
    }
    var lines = [head + ' ▴', trio,
      '来源 tapeup.io 交易页 · 与 Firsto 无关',
      '动态价 ' + (r.liveNote || '—') +
        (r.liveChangePct != null ? ' · 涨跌 ' + (r.liveChangePct >= 0 ? '+' : '') + r.liveChangePct + '%' : '') +
        ' · 来源口径 ' + (r.liveSource || '—'),
      '计价 BEM/UP · 美元折算 USD · 涨跌 24h',
      '锚点 ' + (r.debug && r.debug.note || '—') +
        ' · 页面文本 ' + (r.debug && r.debug.textLen != null ? r.debug.textLen : '—') + ' 字' +
        ' · 采集 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      '— 候选（★＝参与选价，score 0 仅诊断）—'];
    var cands = (r.debug && r.debug.candidates) || [];
    if (cands.length) {
      cands.slice(0, 24).forEach(function (c) {
        lines.push((c.score >= 90 ? '★ ' : '  ') + 'score=' + c.score + '  ' + c.value +
          (c.usdValue != null ? ' ($' + c.usdValue + ')' : '') +
          (c.changePct != null ? ' (' + (c.changePct >= 0 ? '+' : '') + c.changePct + '%)' : '') +
          '   ' + (c.ctx || ''));
      });
      if (cands.length > 24) lines.push('…还有 ' + (cands.length - 24) + ' 条候选');
    } else {
      lines.push('（无候选，页面可能还没渲染价格 / 不是交易页）');
    }
    el.textContent = lines.join('\n');
  }

  function send() {
    var r = T.extractUp(document);
    paintProbe(r);
    // 1.4.23：页头三项都在、但动态价抓到时也要回传（哪怕 BEM/UP 暂缺）
    if (!r || (r.value == null && r.livePrice == null)) return;
    var sig = JSON.stringify([r.value, r.usdValue, r.changePct,
      r.livePrice, r.liveChangePct, r.liveNote, r.liveSource]);
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      chrome.runtime.sendMessage({
        type: 'TAPUP_PRICE',
        payload: {
          value: r.value,
          usdValue: r.usdValue,
          changePct: r.changePct,
          // 1.4.23：K 线动态当前价（箭头所指的绿框数）及其涨跌 / 锚点 / 口径
          livePrice: r.livePrice,
          liveChangePct: r.liveChangePct,
          liveNote: r.liveNote,
          liveSource: r.liveSource,
          asOf: r.asOf,
          at: Date.now(),
          // 1.4.22：多带一些候选，弹窗「采集明细」才有得核对（旧版只留 6 条）
          debug: (r.debug && r.debug.candidates) ? r.debug.candidates.slice(0, 20) : null
        }
      });
    } catch (e) { /* 后台没起来时静默 */ }
  }

  function start() {
    send();
    try {
      if (window.MutationObserver) {
        // 价格常是异步渲染 / SPA 切交易对时才出现，监听子树变化补抓
        var obs = new MutationObserver(function () { send(); });
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      }
    } catch (e) { /* 某些环境不支持，下面轮询兜底 */ }
    // 限频补确认：每 3 秒再核对一次（SPA 路由切换 / 数据延迟都能覆盖）
    setInterval(send, 3000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
