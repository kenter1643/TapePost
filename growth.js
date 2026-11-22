/*
 * TapePost · X 增长计划面板（1.5.26）
 * ---------------------------------------------------------------
 * 只读本机统计并渲染：统计卡（可点进明细）、评论对象推荐清单（大 V）、
 * 历史与目标提醒设置。所有读写都走 background 的 GROWTH_* 消息，
 * 不直接碰 X 页面、不发请求、不读凭证、不自动发帖或评论。
 */
(function () {
  'use strict';
  var Core = window.GrowthCore;
  if (!Core) return;

  var state = { summary: null, view: '' };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (n) { return Number(n || 0).toLocaleString('zh-CN'); };
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

  function renderCards() {
    var s = state.summary;
    if (!s) return;
    var cards = [
      { id: 'post', k: '今日发推 Post', v: s.post, goal: s.postGoal, pct: s.postPct,
        done: s.postDone, tone: s.postDone ? 'ok' : 'warn',
        d: s.postDone ? '已达标，继续保持' : '还差 ' + fmt(s.postGoal - s.post) + ' 条' },
      { id: 'comment', k: '今日评论', v: s.comment, goal: s.commentGoal, pct: s.commentPct,
        done: s.commentDone, tone: s.commentDone ? 'ok' : 'info',
        d: s.commentDone ? '已达标，继续保持' : '还差 ' + fmt(s.commentGoal - s.comment) + ' 条' },
      { id: 'targets', k: '大 V 评论对象', v: s.targetCount, goal: '', pct: 100,
        done: false, tone: 'plain',
        d: s.targetCount ? '点开清单逐条去评论' : '先从互F管理导入' }
    ];
    $('cards').innerHTML = cards.map(function (c) {
      return '<button type="button" class="card ' + c.tone + (state.view === c.id ? ' active' : '') +
        '" data-view="' + c.id + '">' +
        '<div class="k"><span>' + esc(c.k) + '</span><span>' + (c.done ? '✓ 达标' : esc(c.pct) + '%') + '</span></div>' +
        '<div class="v">' + fmt(c.v) + (c.goal !== '' ? ' <small>/ ' + fmt(c.goal) + '</small>' : '') + '</div>' +
        '<div class="d">' + esc(c.d) + '</div>' +
        '<div class="bar"><i class="' + (c.done ? 'ok' : '') + '" style="width:' + c.pct + '%"></i></div>' +
        '</button>';
    }).join('');
    Array.prototype.forEach.call($('cards').querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () {
        state.view = state.view === b.getAttribute('data-view') ? '' : b.getAttribute('data-view');
        renderCards(); renderDetail();
        if (state.view) $('secDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    var parts = [];
    parts.push('北京时间 ' + esc(s.clock) + ' · ' + esc(s.day));
    parts.push('发推 ' + fmt(s.post) + '/' + fmt(s.postGoal) + (s.postDone ? ' ✓' : ''));
    parts.push('评论 ' + fmt(s.comment) + '/' + fmt(s.commentGoal) + (s.commentDone ? ' ✓' : ''));
    parts.push(s.reminderEnabled ? '监督提醒已开' : '监督提醒已F');
    $('statusLine').textContent = parts.join(' · ');
  }

  function renderDetail() {
    var s = state.summary;
    var sec = $('secDetail');
    if (!s || !state.view) { sec.hidden = true; return; }
    sec.hidden = false;
    if (state.view === 'targets') {
      $('detailTitle').textContent = '大 V 评论对象';
      $('detailBadge').textContent = s.targetCount + ' 个';
      $('detailHint').textContent = '清单从本机「互F管理」已采到的认证大 V 导入；点「去看帖子」打开主页，挑互动量最高的帖子写评论。';
      $('detailList').innerHTML = renderTargets(s.targets, true);
    } else {
      var isPost = state.view === 'post';
      $('detailTitle').textContent = isPost ? '今日发推明细' : '今日评论明细';
      $('detailBadge').textContent = (isPost ? s.post : s.comment) + ' 条';
      $('detailHint').textContent = '只显示本机最近 30 条辅助动作记录；每条代表 TapePost 已准备好内容（发推预填 / 写入回复框），最终发送由你在 X 完成。';
      var rows = s.events.filter(function (e) { return e.kind === state.view; });
      $('detailList').innerHTML = rows.length ? rows.map(function (e) {
        return '<div class="item"><div class="main">' +
          '<div class="line1"><span class="nm">' + (isPost ? '📝 打开发推预填' : '💬 写入评论 / 回复') + '</span>' +
          '<span class="tag">' + esc(String(e.at ? new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) : '')) + '</span></div>' +
          '<div class="meta">' + (e.target ? '对象 @' + esc(e.target) + ' · ' : '') +
          '记录标识 ' + esc(String(e.ref || '').slice(0, 28)) + '</div></div></div>';
      }).join('') : '<div class="empty-list">今天还没有记录。用 TapePost 转发或写评论后会自动 +1。</div>';
    }
    bindTargetButtons();
  }

  function renderTargets(targets, compact) {
    if (!targets || !targets.length) {
      return '<div class="empty-list">还没有导入大 V。点上方「从互F管理导入大 V」，先在F注分析面板采一次F注名单。</div>';
    }
    return targets.map(function (t, i) {
      return '<div class="item"><div class="main">' +
        '<div class="line1"><span class="nm">' + (i + 1) + '. ' + esc(t.name) + '</span>' +
        '<span class="tag big">' + esc(t.reason) + '</span>' +
        (t.done > 0 ? '<span class="tag done">已评论 ' + fmt(t.done) + ' 条</span>' : '') + '</div>' +
        '<div class="line1"><a class="hd" href="https://x.com/' + encodeURIComponent(t.handle) +
        '" target="_blank" rel="noopener noreferrer">@' + esc(t.handle) + '</a>' +
        '<span class="meta">粉丝 ' + fmt(t.followers) + '</span></div></div>' +
        '<div class="ops">' +
        '<button type="button" class="btn-go" data-go="' + esc(t.handle) + '">去看帖子</button>' +
        '<button type="button" class="mini" data-done="' + esc(t.handle) + '">记一条</button>' +
        '</div></div>';
    }).join('');
  }
  function bindTargetButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (b) {
      b.addEventListener('click', function () { openX(b.getAttribute('data-go')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-done]'), function (b) {
      b.addEventListener('click', safe(async function () {
        var r = await send({ type: 'GROWTH_TARGET_DONE', handle: b.getAttribute('data-done') });
        if (r && r.summary) { state.summary = r.summary; renderAll(); }
      }));
    });
  }

  function renderTargetsSection() {
    $('targetList').innerHTML = renderTargets(state.summary ? state.summary.targets : [], false);
    bindTargetButtons();
  }
  function renderHistory() {
    var s = state.summary;
    var days = s ? Object.keys(s.history).sort().reverse().slice(0, 14) : [];
    $('histList').innerHTML = days.length ? days.map(function (d) {
      var h = s.history[d];
      return '<div class="hday"><b>' + esc(d) + '</b><br />发推 ' + fmt(h.post) +
        ' · 评论 ' + fmt(h.comment) + '</div>';
    }).join('') : '<div class="empty-list">还没有历史记录，明天开始会按北京时间累计。</div>';
  }
  function renderConfig() {
    var s = state.summary;
    if (!s) return;
    $('cfgPostGoal').value = s.config.postGoal;
    $('cfgCommentGoal').value = s.config.commentGoal;
    $('cfgReminder').checked = !!s.config.reminderEnabled;
    if (!$('cfgHour').options.length) {
      for (var h = 0; h < 24; h++) {
        var o = document.createElement('option');
        o.value = String(h);
        o.textContent = ('0' + h).slice(-2) + ':00';
        $('cfgHour').appendChild(o);
      }
    }
    $('cfgHour').value = String(s.config.reminderHour);
  }
  function renderAll() {
    renderCards(); renderDetail(); renderTargetsSection(); renderHistory(); renderConfig();
  }
  async function refresh() {
    var r = await send({ type: 'GROWTH_STATE' });
    if (r && r.summary) { state.summary = r.summary; renderAll(); }
  }

  $('growthVer').textContent = 'v' + (function () {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '1.5.26'; }
  })();
  $('importBigV').addEventListener('click', safe(async function () {
    var r = await send({ type: 'GROWTH_IMPORT' });
    if (r && r.summary) {
      state.summary = r.summary;
      renderAll();
      $('statusLine').textContent = '已导入 ' + (r.added || 0) + ' 个大 V（更新 ' + (r.updated || 0) +
        ' 个），共 ' + (r.total || 0) + ' 个。北京时间 ' + state.summary.clock + '。';
    }
  }));
  $('openFollow').addEventListener('click', function () { openPage('follow.html'); });
  $('clearTargets').addEventListener('click', safe(async function () {
    var r = await send({ type: 'GROWTH_CLEAR_TARGETS' });
    if (r && r.summary) { state.summary = r.summary; renderAll(); }
  }));
  $('saveConfig').addEventListener('click', safe(async function () {
    var r = await send({ type: 'GROWTH_CONFIG', config: {
      postGoal: Number($('cfgPostGoal').value),
      commentGoal: Number($('cfgCommentGoal').value),
      reminderHour: Number($('cfgHour').value),
      reminderEnabled: !!$('cfgReminder').checked
    } });
    if (r && r.summary) {
      state.summary = r.summary;
      renderAll();
      $('statusLine').textContent = '设置已保存：每天 ' + state.summary.postGoal + ' 条发推 / ' +
        state.summary.commentGoal + ' 条评论，' +
        (state.summary.reminderEnabled ? ('北京时间 ' + $('cfgHour').value + ':00 提醒') : '提醒已F闭') + '。';
    }
  }));
  refresh();
})();
