/*
 * TapePost · X 增长计划面板（1.5.26 · 1.5.28 完善）
 * ---------------------------------------------------------------
 * 只读本机统计并渲染：统计卡（可点进明细）、节奏与连续达标、评论对象推荐清单
 * （今日轮换 / 搜索 / 手动添加 / 移除）、14 天柱状图、发送日志（1.5.28）、目标与提醒设置。
 * 所有读写都走 background 的 GROWTH_* 消息，不直接碰 X 页面、不发请求、
 * 不读凭证、不自动发帖或评论。
 *
 * 1.5.28：按钮统一用事件委托绑定在容器上。旧版每次重绘都对整页
 * querySelectorAll 重新 addEventListener：打开「大 V 评论对象」明细后只要整页重绘
 * 一次（导入 / 保存设置 / 记一条），明细里点一下「记一条」就会记两次。
 */
(function () {
  'use strict';
  var Core = window.GrowthCore;
  if (!Core) return;

  var state = { summary: null, view: '', search: '', log: [], logDays: [], logDay: '', logFilter: '', logStats: {} };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  // 1.5.28：数字不加千分位逗号（1000 而不是 1,000）
  var fmt = function (n) { var v = Number(n || 0); return String(isFinite(v) ? Math.round(v) : 0); };
  var clock = function (ts) {
    return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  };
  var ago = function (ts) {
    if (!ts) return '还没评论过';
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  };
  function swallow() {}
  function safe(fn) {
    return function () {
      try { var p = fn.apply(this, arguments); if (p && typeof p.catch === 'function') p.catch(swallow); }
      catch (e) {}
    };
  }
  function send(msg) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage(msg, function (r) {
        void (chrome.runtime && chrome.runtime.lastError);
        resolve(r || {});
      }); } catch (e) { resolve({}); }
    });
  }
  function openPage(file) {
    try { chrome.tabs.create({ url: chrome.runtime.getURL(file) }, function () {
      void (chrome.runtime && chrome.runtime.lastError);
    }); } catch (e) {}
  }
  function openX(handle) {
    try { chrome.tabs.create({ url: 'https://x.com/' + encodeURIComponent(handle) }, function () {
      void (chrome.runtime && chrome.runtime.lastError);
    }); } catch (e) {}
  }
  function say(text) { $('statusLine').textContent = text; }
  function apply(r) { if (r && r.summary) { state.summary = r.summary; renderAll(); } return r || {}; }

  // ---------------------------------------------------------------- 统计卡
  function renderCards() {
    var s = state.summary;
    if (!s) return;
    var tTotal = s.targetCount || 0;
    var cards = [
      { id: 'post', k: '今日发推 Post', v: s.post, goal: s.postGoal, pct: s.postPct,
        done: s.postDone, tone: s.postDone ? 'ok' : 'warn',
        d: s.postDone ? '已达标，继续保持' : '还差 ' + fmt(s.postGoal - s.post) + ' 条',
        sent: s.postPending ? '另有 ' + fmt(s.postPending) + ' 条已准备、等你发送' : '' },
      { id: 'comment', k: '今日评论', v: s.comment, goal: s.commentGoal, pct: s.commentPct,
        done: s.commentDone, tone: s.commentDone ? 'ok' : 'info',
        d: s.commentDone ? '已达标，继续保持' : '还差 ' + fmt(s.commentGoal - s.comment) + ' 条',
        sent: s.commentPending ? '另有 ' + fmt(s.commentPending) + ' 条已准备、等你发送' : '' },
      { id: 'targets', k: '大 V 评论对象', v: s.targetsTouchedToday || 0, goal: tTotal,
        pct: tTotal ? Math.min(100, Math.round((s.targetsTouchedToday || 0) * 100 / tTotal)) : 0,
        done: false, tone: 'plain',
        d: tTotal ? '今天已覆盖 ' + fmt(s.targetsTouchedToday || 0) + ' 个，点开看今天该评谁' : '先从互F管理导入',
        sent: '' }
    ];
    $('cards').innerHTML = cards.map(function (c) {
      return '<button type="button" class="card ' + c.tone + (state.view === c.id ? ' active' : '') +
        '" data-view="' + c.id + '">' +
        '<div class="k"><span>' + esc(c.k) + '</span><span>' + (c.done ? '✓ 达标' : esc(c.pct) + '%') + '</span></div>' +
        '<div class="v">' + fmt(c.v) + (c.goal !== '' ? ' <small>/ ' + fmt(c.goal) + '</small>' : '') + '</div>' +
        '<div class="d">' + esc(c.d) + '</div>' +
        (c.sent ? '<div class="sent">' + esc(c.sent) + '</div>' : '') +
        '<div class="bar"><i class="' + (c.done ? 'ok' : '') + '" style="width:' + c.pct + '%"></i></div>' +
        '</button>';
    }).join('');
    var parts = [];
    parts.push('北京时间 ' + esc(s.clock) + ' · ' + esc(s.day));
    parts.push('发推 ' + fmt(s.post) + '/' + fmt(s.postGoal) + (s.postDone ? ' ✓' : ''));
    parts.push('评论 ' + fmt(s.comment) + '/' + fmt(s.commentGoal) + (s.commentDone ? ' ✓' : ''));
    parts.push(s.reminderEnabled ? '监督提醒已开' : '监督提醒已关');
    say(parts.join(' · '));
  }

  function renderPace() {
    var s = state.summary;
    if (!s || !s.pace) { $('paceLine').innerHTML = ''; return; }
    var p = s.pace, pills = [];
    var st = s.streak || { days: 0 };
    pills.push('<span class="pill fire">🔥 连续达标 ' + fmt(st.days) + ' 天</span>');
    if (p.fraction <= 0) {
      pills.push('<span class="pill">节奏从北京时间 8:00 开始计算</span>');
    } else {
      pills.push('<span class="pill ' + (s.postDone ? 'good' : (p.postBehind ? 'bad' : '')) + '">发推：此刻应到 ' +
        fmt(p.expectedPost) + ' 条' + (s.postDone ? '，已达标' : (p.behindPost ? '，落后 ' + fmt(p.behindPost) : '，进度正常')) + '</span>');
      pills.push('<span class="pill ' + (s.commentDone ? 'good' : (p.commentBehind ? 'bad' : '')) + '">评论：此刻应到 ' +
        fmt(p.expectedComment) + ' 条' + (s.commentDone ? '，已达标' : (p.behindComment ? '，落后 ' + fmt(p.behindComment) : '，进度正常')) + '</span>');
      if (!s.postDone || !s.commentDone) {
        pills.push('<span class="pill">剩余时间每小时需 ' +
          (s.postDone ? '' : '发推 ' + fmt(p.perHourPost) + ' 条 ') +
          (s.commentDone ? '' : '评论 ' + fmt(p.perHourComment) + ' 条') + '</span>');
      }
    }
    $('paceLine').innerHTML = pills.join('');
  }

  // ---------------------------------------------------------------- 明细
  var SOURCE_LABEL = {
    assist: ['准备好，待你发送', 'src-assist'],
    sent: ['已发出（TapePost 准备）', 'src-sent'],
    send: ['你手写直接发出', 'src-send'],
    mark: ['清单手动记一条', 'src-mark']
  };
  function sourceOf(e) {
    if (e.source === 'assist') return e.sent ? SOURCE_LABEL.sent : SOURCE_LABEL.assist;
    return SOURCE_LABEL[e.source] || SOURCE_LABEL.assist;
  }

  function renderDetail() {
    var s = state.summary;
    var sec = $('secDetail');
    if (!s || !state.view) { sec.hidden = true; return; }
    sec.hidden = false;
    if (state.view === 'targets') {
      $('detailTitle').textContent = '今天该评论谁';
      var todo = (s.recommended || []).filter(function (t) { return !t.todayDone; });
      $('detailBadge').textContent = '待评 ' + todo.length + ' 个';
      $('detailHint').textContent = '按「今天还没评过 → 最久没评 → 粉丝多」排序的前 30 个。完整清单、搜索、手动添加在下方第 ③ 区。';
      $('detailList').innerHTML = renderTargets(s.recommended || []);
      return;
    }
    var isPost = state.view === 'post';
    $('detailTitle').textContent = isPost ? '今日发推明细' : '今日评论明细';
    $('detailBadge').textContent = (isPost ? s.post : s.comment) + ' 条';
    $('detailHint').textContent = '显示本机最近 200 条记录。只有检测到 X 发送成功才 +1；「准备好，待你发送」= TapePost 已把内容准备好，还没检测到发送成功，不计数。';
    var rows = (s.events || []).filter(function (e) { return e.kind === state.view; });
    $('detailList').innerHTML = rows.length ? rows.map(function (e) {
      var src = sourceOf(e);
      var link = e.post ? 'https://x.com/' + (e.target ? encodeURIComponent(e.target) : 'i') + '/status/' + e.post : '';
      return '<div class="item"><div class="main">' +
        '<div class="line1"><span class="nm">' + (isPost ? '📝 发推' : '💬 评论') + '</span>' +
        '<span class="tag ' + src[1] + '">' + esc(src[0]) + '</span>' +
        '<span class="tag">' + esc(clock(e.at)) + '</span></div>' +
        '<div class="meta">' + (e.target ? '对象 <a class="hd" href="https://x.com/' + encodeURIComponent(e.target) +
          '" target="_blank" rel="noopener noreferrer">@' + esc(e.target) + '</a> · ' : '') +
        (link ? '<a class="hd" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">查看帖子</a>' : '') +
        (e.sent && e.sentAt && e.source === 'assist' ? ' · 发出时间 ' + esc(clock(e.sentAt)) : '') +
        '</div></div></div>';
    }).join('') : '<div class="empty-list">今天还没有记录。用 TapePost 转发 / 写评论，或直接在 x.com 发出，发送成功后自动 +1。</div>';
  }

  // ---------------------------------------------------------------- 发送日志
  var LOG_LABEL = { ok: ['发送成功', 'log-ok'], fail: ['发送失败', 'log-fail'], unknown: ['未确认', 'log-unknown'] };
  var REASON_LABEL = { toast: 'X 提示已发送', cleared: '输入框已清空', closed: '发送窗口已关闭', unload: '发推小窗已关闭',
    confirmed: '对上 TapePost 准备的内容', manual: '', mark: '清单手动记一条', timeout: '15 秒没有结果',
    'duplicate-send': '重复点击，未重复计数' };
  function filteredLog() {
    var f = state.logFilter || '';
    return (state.log || []).filter(function (e) {
      if (!f) return true;
      if (f === 'post' || f === 'comment') return e.kind === f;
      return e.status === f;
    });
  }
  function renderLog() {
    var days = state.logDays || [];
    $('logDay').innerHTML = days.length ? days.map(function (d) {
      return '<option value="' + esc(d) + '"' + (d === state.logDay ? ' selected' : '') + '>' + esc(d) + '</option>';
    }).join('') : '<option value="">今天</option>';
    var st = state.logStats || {};
    $('logBadge').textContent = '成功 ' + fmt(st.ok) + ' · 失败 ' + fmt(st.fail) + ' · 未确认 ' + fmt(st.unknown);
    $('logStore').textContent = (state.logStore === 'indexeddb' ? '已存入本地数据库' : '已存入本机存储') +
      '，共 ' + fmt(state.logTotal || 0) + ' 条（最近 90 天）';
    var rows = filteredLog().slice().reverse().slice(0, 500);
    $('logList').innerHTML = rows.length ? rows.map(function (e) {
      var lb = LOG_LABEL[e.status] || LOG_LABEL.unknown;
      var why = REASON_LABEL[e.reason] != null ? REASON_LABEL[e.reason] : e.reason;
      var link = e.post ? 'https://x.com/' + (e.target ? encodeURIComponent(e.target) : 'i') + '/status/' + e.post : '';
      return '<div class="item"><div class="main">' +
        '<div class="line1"><span class="tag">' + esc(e.clock || clock(e.at)) + '</span>' +
        '<span class="nm">' + (e.kind === 'comment' ? '💬 评论' : '📝 发推') + '</span>' +
        '<span class="tag ' + lb[1] + '">' + esc(lb[0]) + '</span>' +
        (e.status === 'ok' && !e.counted ? '<span class="tag">未重复计数</span>' : '') + '</div>' +
        '<div class="meta">' + (e.target ? '回复 <a class="hd" href="https://x.com/' + encodeURIComponent(e.target) +
          '" target="_blank" rel="noopener noreferrer">@' + esc(e.target) + '</a> · ' : '') +
        (link ? '<a class="hd" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">原帖</a> · ' : '') +
        esc(why || '') + '</div>' +
        (e.text ? '<div class="txt">' + esc(e.text) + '</div>' : '') +
        '</div></div>';
    }).join('') : '<div class="empty-list">这一天还没有发送记录。</div>';
  }
  async function loadLog(day) {
    var r = await send({ type: 'GROWTH_LOG', day: day || state.logDay || '' });
    if (!r || !r.ok) return;
    state.logDay = r.day; state.logDays = r.days || []; state.log = r.entries || []; state.logStats = r.stats || {};
    state.logTotal = r.total || 0; state.logStore = r.store || '';
    renderLog();
  }
  function csvCell(v) {
    var t = String(v == null ? '' : v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function exportLog() {
    var rows = filteredLog();
    if (!rows.length) { say('这一天没有可导出的记录。'); return; }
    var head = ['日期', '北京时间', '类型', '结果', '是否计数', '回复对象', '帖子 id', '说明', '内容'];
    var lines = [head.join(',')].concat(rows.map(function (e) {
      return [e.day, e.clock, e.kind === 'comment' ? '评论' : '发推', (LOG_LABEL[e.status] || LOG_LABEL.unknown)[0],
        e.counted ? '是' : '否', e.target ? '@' + e.target : '', e.post,
        REASON_LABEL[e.reason] != null ? REASON_LABEL[e.reason] : e.reason, e.text].map(csvCell).join(',');
    }));
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'TapePost发送日志_' + (state.logDay || 'today') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ---------------------------------------------------------------- 推荐清单
  function renderTargets(targets) {
    if (!targets || !targets.length) {
      return '<div class="empty-list">还没有评论对象。点上方「从互F管理导入大 V」（先在关注分析面板采一次关注名单），或手动添加 @用户名。</div>';
    }
    return targets.map(function (t, i) {
      return '<div class="item"><div class="main">' +
        '<div class="line1"><span class="nm">' + (i + 1) + '. ' + esc(t.name) + '</span>' +
        '<span class="tag big">' + esc(t.reason) + '</span>' +
        (t.todayDone > 0 ? '<span class="tag today">今日 ' + fmt(t.todayDone) + ' 条</span>' : '') +
        (t.done > 0 ? '<span class="tag done">累计 ' + fmt(t.done) + ' 条</span>' : '') + '</div>' +
        '<div class="line1"><a class="hd" href="https://x.com/' + encodeURIComponent(t.handle) +
        '" target="_blank" rel="noopener noreferrer">@' + esc(t.handle) + '</a>' +
        '<span class="meta">' + (t.followers ? '粉丝 ' + fmt(t.followers) + ' · ' : '') + '上次评论 ' + esc(ago(t.lastAt)) + '</span></div></div>' +
        '<div class="ops">' +
        '<button type="button" class="btn-go" data-go="' + esc(t.handle) + '">去看帖子</button>' +
        '<button type="button" class="mini" data-done="' + esc(t.handle) + '" title="在手机等其他地方评论过时用；x.com 上发出的会自动记">手动记一条</button>' +
        '<button type="button" class="danger-mini" data-remove="' + esc(t.handle) + '" title="从清单移除">移除</button>' +
        '</div></div>';
    }).join('');
  }
  function renderTargetsSection() {
    var s = state.summary;
    if (!s) return;
    var all = Core.recommendTargets(s.targets || [], s.day);
    var q = state.search.trim().replace(/^@/, '').toLowerCase();
    var list = q ? all.filter(function (t) {
      return t.handle.indexOf(q) >= 0 || String(t.name || '').toLowerCase().indexOf(q) >= 0;
    }) : all;
    $('targetBadge').textContent = '共 ' + all.length + ' 个 · 今日已评 ' + (s.targetsTouchedToday || 0) + ' 个';
    $('targetList').innerHTML = (q && !list.length)
      ? '<div class="empty-list">没有匹配「' + esc(q) + '」的对象。</div>' : renderTargets(list);
  }

  // 事件委托：容器只绑一次，重绘不会叠加监听器
  function onTargetClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-go],[data-done],[data-remove]') : null;
    if (!el) return;
    var go = el.getAttribute('data-go'), done = el.getAttribute('data-done'), rm = el.getAttribute('data-remove');
    if (go) { openX(go); return; }
    if (el.__busy) return;
    el.__busy = true;
    var p = done
      ? send({ type: 'GROWTH_TARGET_DONE', handle: done }).then(function (r) {
          apply(r);
          say(r.counted ? '已给 @' + done + ' 记一条，今日评论 +1。'
            : (r.reason === 'already-counted' ? '@' + done + ' 刚刚已经自动记过了，没有重复计数。' : '没记上：清单里找不到 @' + done + '。'));
        })
      : send({ type: 'GROWTH_TARGET_REMOVE', handle: rm }).then(function (r) {
          apply(r);
          say(r.ok ? '已把 @' + rm + ' 移出清单（重新导入时如果仍符合大 V 条件会再加回来）。' : '清单里没有 @' + rm + '。');
        });
    p.then(function () { el.__busy = false; }, function () { el.__busy = false; });
  }

  // ---------------------------------------------------------------- 历史 / 图表
  function renderHistory() {
    var s = state.summary;
    if (!s) return;
    var st = s.streak || { days: 0 };
    $('streakBadge').textContent = '连续达标 ' + st.days + ' 天';
    var today = s.day;
    var cols = [];
    var base = Date.parse(today + 'T12:00:00+08:00');
    for (var i = 13; i >= 0; i--) {
      var d = Core.dayKey(base - i * 86400000);
      var h = d === today
        ? { post: s.post, comment: s.comment, postGoal: s.postGoal, commentGoal: s.commentGoal }
        : (s.history[d] || null);
      cols.push({ day: d, h: h, today: d === today });
    }
    $('histChart').innerHTML = cols.map(function (c) {
      var h = c.h || { post: 0, comment: 0 };
      var pg = h.postGoal || s.postGoal, cg = h.commentGoal || s.commentGoal;
      var pp = Math.min(100, pg ? h.post * 100 / pg : 0), cp = Math.min(100, cg ? h.comment * 100 / cg : 0);
      var met = !!c.h && h.post >= pg && h.comment >= cg;
      return '<div class="col" title="' + esc(c.day + '：发推 ' + h.post + '/' + pg + '，评论 ' + h.comment + '/' + cg) + '">' +
        '<div class="bars"><i class="p" style="height:' + pp + '%"></i><i class="c" style="height:' + cp + '%"></i></div>' +
        '<div class="lb' + (met ? ' met' : '') + '">' + (c.today ? '今天' : esc(c.day.slice(5))) + '</div></div>';
    }).join('');
    var days = Object.keys(s.history).sort().reverse().slice(0, 14);
    $('histList').innerHTML = days.length ? days.map(function (d) {
      var h = s.history[d];
      var pg = h.postGoal || s.postGoal, cg = h.commentGoal || s.commentGoal;
      var met = h.post >= pg && h.comment >= cg;
      return '<div class="hday"><b>' + esc(d) + '</b>' + (met ? ' ✅' : '') + '<br />发推 ' + fmt(h.post) + '/' + fmt(pg) +
        ' · 评论 ' + fmt(h.comment) + '/' + fmt(cg) +
        (h.postSent != null || h.commentSent != null
          ? '<br /><span class="hint">确认发出：' + fmt(h.postSent || 0) + ' / ' + fmt(h.commentSent || 0) + '</span>' : '') +
        '</div>';
    }).join('') : '<div class="empty-list">还没有历史记录，明天开始会按北京时间累计。</div>';
  }

  function renderConfig() {
    var s = state.summary;
    if (!s || state.cfgDirty) return;   // 正在改设置时，定时刷新不覆盖输入
    $('cfgPostGoal').value = s.config.postGoal;
    $('cfgCommentGoal').value = s.config.commentGoal;
    $('cfgReminder').checked = !!s.config.reminderEnabled;
    $('cfgPace').checked = s.config.paceReminder !== false;
    $('cfgXHints').checked = s.config.xHints !== false;
    state.reminders = (s.config.reminders || []).map(function (r) { return { time: r.time, pct: r.pct }; });
    renderReminders();
  }

  // ---------------------------------------------------------------- 定时提醒
  function renderReminders() {
    var s = state.summary || {};
    var fired = ((s.config || {}).reminderFired || {}).times || [];
    var list = state.reminders || [];
    $('remList').innerHTML = list.length ? list.map(function (r, i) {
      return '<div class="rem-row" data-i="' + i + '">' +
        '<input type="time" step="300" value="' + esc(r.time) + '" data-k="time" aria-label="提醒时间" />' +
        '<span>时应完成今日目标的</span>' +
        '<input type="number" min="1" max="100" value="' + esc(r.pct) + '" data-k="pct" aria-label="应完成百分比" /><span>%</span>' +
        '<span class="hint">（发推 ' + fmt(Math.ceil((s.postGoal || 0) * r.pct / 100)) + ' / 评论 ' +
          fmt(Math.ceil((s.commentGoal || 0) * r.pct / 100)) + '）</span>' +
        (fired.indexOf(r.time) >= 0 && !state.cfgDirty ? '<span class="fired">今天已检查</span>' : '') +
        '<button type="button" class="ghost mini" data-rm="' + i + '">删除</button></div>';
    }).join('') : '<div class="hint">还没有定时提醒。点「添加提醒时间」或「用推荐」。</div>';
    var at = s.nextReminderAt;
    $('nextReminder').textContent = !s.reminderEnabled ? '已关闭' : (at ? '下一次：' + new Date(at).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  }
  function remDirty() { state.cfgDirty = true; }
  $('remList').addEventListener('input', function (e) {
    var row = e.target.closest && e.target.closest('.rem-row');
    if (!row) return;
    var r = state.reminders[Number(row.getAttribute('data-i'))];
    if (!r) return;
    var k = e.target.getAttribute('data-k');
    if (k === 'time') r.time = e.target.value;
    if (k === 'pct') r.pct = Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 100)));
    remDirty();
  });
  $('remList').addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-rm]');
    if (!b) return;
    state.reminders.splice(Number(b.getAttribute('data-rm')), 1);
    remDirty(); renderReminders();
  });
  $('remAdd').addEventListener('click', function () {
    if ((state.reminders || []).length >= 8) { say('最多 8 个定时提醒。'); return; }
    var last = state.reminders[state.reminders.length - 1];
    var h = last ? Math.min(23, Number(last.time.slice(0, 2)) + 2) : 21;
    state.reminders.push({ time: ('0' + h).slice(-2) + ':00', pct: 100 });
    remDirty(); renderReminders();
  });
  $('remPreset').addEventListener('click', function () {
    state.reminders = [{ time: '12:00', pct: 30 }, { time: '18:00', pct: 70 }, { time: '21:00', pct: 100 }];
    remDirty(); renderReminders();
    say('已填入推荐的三个提醒时间，点「保存设置」生效。');
  });

  function renderAll() {
    renderCards(); renderPace(); renderDetail(); renderTargetsSection(); renderHistory(); renderConfig();
  }
  async function refresh() { apply(await send({ type: 'GROWTH_STATE' })); }

  // ---------------------------------------------------------------- 绑定（只绑一次）
  $('growthVer').textContent = 'v' + (function () {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '1.5.28'; }
  })();
  $('cards').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
    if (!b) return;
    var v = b.getAttribute('data-view');
    state.view = state.view === v ? '' : v;
    renderCards(); renderDetail();
    if (state.view) $('secDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('detailList').addEventListener('click', onTargetClick);
  $('targetList').addEventListener('click', onTargetClick);
  $('targetSearch').addEventListener('input', function (e) { state.search = e.target.value || ''; renderTargetsSection(); });
  $('addTarget').addEventListener('click', safe(async function () {
    var h = String($('addHandle').value || '').trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_]{1,20}$/.test(h)) { say('请填写正确的 X 用户名（字母、数字、下划线，最多 20 位），可以带 @ 或粘贴主页链接。'); return; }
    var r = apply(await send({ type: 'GROWTH_TARGET_ADD', handle: h }));
    if (r.ok) { $('addHandle').value = ''; say('已添加 @' + h.toLowerCase() + ' 到评论对象清单。'); }
    else say(r.reason === 'exists' ? '@' + h + ' 已经在清单里了。' : (r.reason === 'full' ? '清单已满（最多 200 个），先移除一些再添加。' : '没能添加 @' + h + '。'));
  }));
  $('addHandle').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('addTarget').click(); });
  $('importBigV').addEventListener('click', safe(async function () {
    var r = apply(await send({ type: 'GROWTH_IMPORT' }));
    if (r.summary) {
      say('已导入 ' + (r.added || 0) + ' 个大 V（更新 ' + (r.updated || 0) + ' 个' +
        (r.removed ? '，移除已取F的 ' + r.removed + ' 个' : '') + '），共 ' + (r.total || 0) +
        ' 个。北京时间 ' + state.summary.clock + '。');
    }
  }));
  $('openFollow').addEventListener('click', function () { openPage('follow.html'); });
  $('logDay').addEventListener('change', function (e) { loadLog(e.target.value).catch(swallow); });
  $('logFilter').addEventListener('change', function (e) { state.logFilter = e.target.value || ''; renderLog(); });
  $('logExport').addEventListener('click', exportLog);
  $('logClear').addEventListener('click', safe(async function () {
    if (!state.logTotal) { say('发送日志本来就是空的。'); return; }
    if (!window.confirm('确定清空全部 ' + state.logTotal + ' 条发送日志吗？只删日志，今日计数和历史不受影响，删除后无法恢复。')) return;
    await send({ type: 'GROWTH_LOG_CLEAR' });
    await loadLog('');
    say('已清空发送日志。');
  }));
  $('clearTargets').addEventListener('click', safe(async function () {
    var n = (state.summary && state.summary.targetCount) || 0;
    if (!n) { say('清单本来就是空的。'); return; }
    // 清空会连同手动添加的对象和累计进度一起删掉，必须二次确认
    if (!window.confirm('确定清空全部 ' + n + ' 个评论对象吗？手动添加的对象和累计评论进度会一起删除，无法恢复。')) return;
    apply(await send({ type: 'GROWTH_CLEAR_TARGETS' }));
    say('已清空评论对象清单。');
  }));
  ['cfgPostGoal', 'cfgCommentGoal', 'cfgReminder', 'cfgPace', 'cfgXHints'].forEach(function (id) {
    $(id).addEventListener('input', function () { state.cfgDirty = true; });
    $(id).addEventListener('change', function () { state.cfgDirty = true; });
  });
  $('saveConfig').addEventListener('click', safe(async function () {
    state.cfgDirty = false;
    var r = apply(await send({ type: 'GROWTH_CONFIG', config: {
      postGoal: Number($('cfgPostGoal').value),
      commentGoal: Number($('cfgCommentGoal').value),
      reminders: (state.reminders || []).filter(function (r) { return /^\d{2}:\d{2}$/.test(r.time); }),
      reminderEnabled: !!$('cfgReminder').checked,
      paceReminder: !!$('cfgPace').checked,
      xHints: !!$('cfgXHints').checked
    } }));
    if (r.summary) {
      var cfg = state.summary.config || {};
      var rems = cfg.reminders || [];
      var remText = !state.summary.reminderEnabled ? '提醒已关闭'
        : (rems.length ? '定时提醒 ' + rems.map(function (x) { return x.time + '（' + x.pct + '%）'; }).join('、')
          : '没有设定时提醒') + (cfg.paceReminder ? '，中途落后也会提醒' : '');
      say('设置已保存：每天 ' + state.summary.postGoal + ' 条发推 / ' + state.summary.commentGoal + ' 条评论，' + remText + '。');
    }
  }));
  // 别的页面计了数（x.com 上发出、弹窗里转发）时本页自动刷新
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.tapeGrowthStateV1) refresh().catch(swallow);
      // 正在看的那一天有新日志时刷新（看历史某天时不打扰）
      if (changes.tapeGrowthLogRev) loadLog().catch(swallow);
    });
  }
  setInterval(function () { refresh().catch(swallow); }, 60000);  // 节奏随时间变化
  refresh().catch(swallow);
  loadLog().catch(swallow);
})();
