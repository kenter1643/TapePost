/*
 * TapePost · F注F系分析内核（1.5.23 · 1.5.28 数据层）
 * ---------------------------------------------------------------
 * 纯函数模块，不依赖 DOM / chrome.* / 网络，可同时被三个环境加载：
 *   1) MAIN world     follow-capture.js：从 X 自己加载的 JSON 里提取用户；
 *   2) ISOLATED world follow-bridge.js：合并快照、二次校验白名单；
 *   3) 扩展页         follow.html / follow.js：统计、分类、明细渲染；
 *   4) Node vm        test-follow.js：离线断言。
 *
 * 隐私边界：本模块只处理「公开的主页资料」（用户名、昵称、简介、粉丝数、
 * 推文数、认证标记、头像 URL、最后推文时间），不接触 cookie / ct0 /
 * bearer / 登录态，也不产生任何网络请求。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FollowCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var HANDLE_RE = /^[A-Za-z0-9_]{1,20}$/;
  var MAX_NODES = 20000;       // 单个响应最多遍历的对象节点数，防超大 JSON 卡死页面
  var MAX_DEPTH = 24;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var DEFAULTS = {
    minDelay: 5000,            // 两次取F之间的最小间隔（毫秒）
    jitter: 3000,              // 额外随机抖动上限
    batchLimit: 50,            // 单批最多处理多少人，达到后自动暂停
    inactiveDays: 180,         // 超过多少天没发推算「长期不活跃」
    bigFollowers: 10000,       // 粉丝数达到多少算「大 V」
    skipProtected: true,       // 认证 / 大 V / 白名单默认不取F
    maxScroll: 600,            // 自动滚动最多多少次（1.5.22：200 → 600，大名单不再提前撞上限）
    idleRounds: 8,             // 连续多少轮「完全静默」才允许判定完成（1.5.22：4 → 8）
    maxCaptureMs: 20 * 60 * 1000, // 单轮最长时间（1.5.22：6 min → 20 min）
    // 1.5.22 扫描结束判定的时间门槛：旧版只看 4 轮（4×1.5s=6s）人数没涨就结束，
    // X 分页慢、或全量重扫返回的全是已存账号时都会「没扫完就停」。
    scanMinMs: 12000,          // 至少扫描这么久才允许判定结束
    scanIdleMs: 20000,         // 距最后一次 X 响应 / 名单新增 / 页面变高需静默这么久
    scanBottomRounds: 3,       // 列表到底且页面高度稳定需连续确认的轮数
    scanLoadingGraceMs: 45000  // 加载指示器最多阻挡多久，避免 X 常驻 progressbar 卡死
  };

  function num(v) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function str(v) {
    return typeof v === 'string' ? v : (v == null ? '' : String(v));
  }

  function lowerHandle(v) {
    return str(v).replace(/^@/, '').trim().toLowerCase();
  }

  function validHandle(h) {
    return HANDLE_RE.test(h);
  }

  /* 用户对象在 X GraphQL 响应里有多种嵌套形态：
   *   { rest_id, legacy:{screen_name,...} }                        （最常见）
   *   { user_results:{ result:{ ... } } }                          （timeline itemContent）
   *   { core:{ user_results:{ result:{ ... } } } }
   *   { result:{ __typename:'User', legacy:{...} } }
   * 与其逐层写死，不如遍历整棵 JSON，对每个节点尝试提取再按 id 去重。
   * 抗端点改名、抗字段增减，改版时不容易整条链路失效。 */
  function legacyOf(node) {
    return (node && typeof node.legacy === 'object' && node.legacy) || null;
  }

  function looksLikeUser(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    if (node.__typename && node.__typename !== 'User' && node.__typename !== 'UserUnion') return false;
    // 推文节点同样可能带 user 字段，但它自己带 full_text / conversation_id_str，必须排除
    if (node.full_text || node.conversation_id_str || node.quoted_status ||
        node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults') return false;
    var lg = legacyOf(node);
    var sn = (lg && lg.screen_name) || node.screen_name;
    return typeof sn === 'string' && HANDLE_RE.test(sn);
  }

  function lastTweetAt(node, lg) {
    var s = (lg && lg.status) || node.status || null;
    if (s && typeof s === 'object') return str(s.created_at || s.createdAt);
    return str((lg && lg.last_tweet_at) || node.last_tweet_at);
  }

  function normalizeUser(node) {
    var lg = legacyOf(node) || {};
    var handle = lowerHandle(lg.screen_name || node.screen_name);
    if (!validHandle(handle)) return null;
    return {
      id: str(node.rest_id || node.id_str || node.id || handle),
      handle: handle,
      name: str(lg.name || node.name || handle),
      bio: str(lg.description || node.description || '').slice(0, 400),
      followers: num(lg.followers_count != null ? lg.followers_count : node.followers_count),
      friends: num(lg.friends_count != null ? lg.friends_count : node.friends_count),
      tweets: num(lg.statuses_count != null ? lg.statuses_count : node.statuses_count),
      verified: !!(lg.verified || node.verified || node.is_blue_verified),
      blue: !!node.is_blue_verified,
      defaultAvatar: !!(lg.default_profile_image || node.default_profile_image),
      locked: !!(lg.protected || node.protected),
      avatar: str(lg.profile_image_url_https || node.profile_image_url_https || ''),
      createdAt: str(lg.created_at || node.created_at || ''),
      lastTweetAt: lastTweetAt(node, lg),
      // 只作交叉校验，集合归属一律按「来自哪个页面」判定，不信这两个字段
      following: lg.following === true,
      followedBy: lg.followed_by === true
    };
  }

  /* 只保留公开主页资料；任何凭证 / token / 邮件 / 电话字段一律丢弃。 */
  var BANNED_KEYS = /token|secret|cookie|auth|bearer|password|email|phone|ct0|session|key/i;

  function sanitizeUser(u) {
    var out = {};
    Object.keys(u || {}).forEach(function (k) {
      if (BANNED_KEYS.test(k)) return;
      var v = u[k];
      if (v === null || ['string', 'number', 'boolean'].indexOf(typeof v) !== -1) out[k] = v;
    });
    return out;
  }

  /* 从一个响应对象里抽取所有用户。payload 可以是对象、数组或 JSON 字符串。 */
  function pickUsers(payload) {
    var data = payload;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    var found = Object.create(null);
    var count = 0;
    var stack = [{ v: data, d: 0 }];
    while (stack.length) {
      var cur = stack.pop();
      if (!cur || cur.d > MAX_DEPTH) continue;
      var v = cur.v;
      if (!v || typeof v !== 'object') continue;
      if (++count > MAX_NODES) break;
      if (!Array.isArray(v) && looksLikeUser(v)) {
        var u = sanitizeUser(normalizeUser(v));
        if (u && u.handle && !found[u.handle]) found[u.handle] = u;
      }
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) {
        if (BANNED_KEYS.test(keys[i])) continue;
        var child = v[keys[i]];
        if (child && typeof child === 'object') stack.push({ v: child, d: cur.d + 1 });
      }
    }
    return Object.keys(found).map(function (k) { return found[k]; });
  }

  /* 把新采集到的一批用户合并进某个来源的快照（不修改入参）。
   * 1.5.28：传 now 时给本批用户打 seenAt（最近一次在列表里出现的时间）并保留
   * firstSeenAt（第一次出现的时间）。全量扫描完成后据此清理「已不在列表」的人、
   * 生成「新增 / 取F」变化记录；不传 now 时行为与旧版完全一致。 */
  function mergeSnapshot(prev, users, now) {
    var out = {};
    var stamp = num(now);
    Object.keys(prev || {}).forEach(function (k) { out[k] = prev[k]; });
    (users || []).forEach(function (u) {
      if (!u || !validHandle(u.handle)) return;
      var old = out[u.handle] || {};
      if (stamp) {
        u = Object.assign({}, u, {
          seenAt: stamp,
          firstSeenAt: num(old.firstSeenAt) || (out[u.handle] ? num(old.seenAt) || stamp : stamp)
        });
      }
      // 后到的分页数据更完整时覆盖空值，但不丢已有资料
      var merged = sanitizeUser(Object.assign({}, u, old));
      Object.keys(u).forEach(function (k) {
        if (u[k] !== '' && u[k] !== 0 && u[k] !== false && u[k] != null) merged[k] = u[k];
      });
      merged.handle = u.handle;
      out[u.handle] = merged;
    });
    return out;
  }

  function mapToList(map) {
    return Object.keys(map || {}).map(function (k) { return map[k] || { handle: k }; });
  }

  /* 集合运算：归属只按来源页面判定，不看 following/followed_by 字段。 */
  function relationSets(followingMap, followersMap) {
    var f = followingMap || {}, r = followersMap || {};
    var notBack = [], toFollowBack = [], mutual = [];
    Object.keys(f).forEach(function (k) {
      (r[k] ? mutual : notBack).push(f[k]);
    });
    Object.keys(r).forEach(function (k) {
      if (!f[k]) toFollowBack.push(r[k]);
    });
    var fc = Object.keys(f).length, rc = Object.keys(r).length;
    return {
      followingCount: fc,
      followerCount: rc,
      notBack: notBack,
      toFollowBack: toFollowBack,
      mutual: mutual,
      mutualRate: fc ? Math.round(mutual.length / fc * 1000) / 10 : 0,
      backRate: rc ? Math.round(mutual.length / rc * 1000) / 10 : 0
    };
  }

  function parseDate(s) {
    if (!s) return 0;
    var t = Date.parse(s);
    if (isFinite(t)) return t;
    // X 旧版格式：Wed Oct 10 20:19:24 +0000 2018
    var t2 = Date.parse(String(s).replace(/^\w+\s/, ''));
    return isFinite(t2) ? t2 : 0;
  }

  function ageDays(s, now) {
    var t = parseDate(s);
    if (!t) return -1;
    return Math.floor(((now || Date.now()) - t) / DAY_MS);
  }

  /* 分类标签，可多标签并存。用于「点分类看明细」和批量取F的默认保护。 */
  function classify(u, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var tags = [];
    if (u.verified || u.blue) tags.push('verified');
    if (u.followers >= o.bigFollowers) tags.push('big');
    if (u.tweets === 0 || u.defaultAvatar ||
        (u.followers === 0 && u.tweets < 5)) tags.push('empty');
    /* 只有真正拿到「最后一条推文时间」才判不活跃。X 的F注列表响应常常
     * 不带 status，此时账号注册时间再早也不能推断「长期不发推」——否则会把
     * 大量仍然活跃的老账号误标，进而误导用户勾选取F。宁可这一类为空。 */
    var idle = u.lastTweetAt ? ageDays(u.lastTweetAt, o.now) : -1;
    if (idle >= o.inactiveDays) tags.push('inactive');
    if (u.friends > u.followers * 5 && u.followers < 100) tags.push('lowratio');
    if (!tags.length) tags.push('normal');
    return tags;
  }

  function followerBand(n) {
    if (n < 100) return '0-100';
    if (n < 1000) return '100-1k';
    if (n < 10000) return '1k-1w';
    if (n < 100000) return '1w-10w';
    return '10w+';
  }

  /* 保护名单：白名单 + 认证/大 V（开关）+ 锁推账号。
   * 批量取F在面板层和桥接层各校验一次，防止单层漏判。 */
  function protectedReasons(u, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var wl = {};
    (o.whitelist || []).forEach(function (h) { wl[lowerHandle(h)] = true; });
    var reasons = [];
    if (wl[lowerHandle(u.handle)]) reasons.push('白名单');
    if (o.skipProtected && (u.verified || u.blue)) reasons.push('认证账号');
    if (o.skipProtected && u.followers >= o.bigFollowers) reasons.push('大 V');
    if (u.locked) reasons.push('锁推账号');
    return reasons;
  }

  function isProtected(u, opts) {
    return protectedReasons(u, opts).length > 0;
  }

  /* 分组定义：面板顶部的可点击统计卡 + 未回F的细分分类。 */
  var GROUPS = [
    { id: 'notBack', label: '未回F我', hint: '我F注了、对方没F注我', tone: 'warn' },
    { id: 'toFollowBack', label: '我未回F', hint: '对方F注了我、我没回F', tone: 'info' },
    { id: 'mutual', label: '互F', hint: '双向F注', tone: 'ok' },
    { id: 'following', label: '全部F注', hint: '我F注的所有人', tone: 'plain' },
    { id: 'followers', label: '全部粉丝', hint: 'F注我的所有人', tone: 'plain' }
  ];

  var FILTERS = [
    { id: 'all', label: '全部' },
    { id: 'empty', label: '疑似空号' },
    { id: 'inactive', label: '长期不活跃' },
    { id: 'verified', label: '认证账号' },
    { id: 'big', label: '大 V' },
    { id: 'lowratio', label: '低回F比' },
    { id: 'normal', label: '普通' },
    { id: 'protected', label: '受保护' }
  ];

  /* 取F任务的最终名单：过滤保护项、去重、限额。纯函数，便于 dry-run 断言。 */
  function buildTask(handles, users, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var byHandle = {};
    (users || []).forEach(function (u) { byHandle[lowerHandle(u.handle)] = u; });
    var seen = {}, picked = [], skipped = [];
    var arr = handles || [];
    for (var i = 0; i < arr.length; i++) {
      var k = lowerHandle(arr[i]);
      if (!validHandle(k) || seen[k]) continue;
      seen[k] = true;
      var u = byHandle[k] || { handle: k };
      var reasons = protectedReasons(u, o);
      if (reasons.length) skipped.push({ handle: k, reason: reasons.join(' / ') });
      else picked.push(k);
      // 单批上限必须真正截断；forEach 里的 return 只跳过当前迭代，会多算人
      if (picked.length >= o.batchLimit) break;
    }
    return { handles: picked, skipped: skipped, settings: {
      minDelay: Math.max(3000, num(o.minDelay) || DEFAULTS.minDelay),
      jitter: Math.max(0, num(o.jitter)),
      batchLimit: Math.max(1, num(o.batchLimit) || DEFAULTS.batchLimit)
    } };
  }

  function delayFor(i, settings) {
    var s = Object.assign({}, DEFAULTS, settings || {});
    // 确定性伪随机：同一批任务重放得到相同节奏，便于测试与复盘
    var x = Math.sin((i + 1) * 12.9898) * 43758.5453;
    var r = x - Math.floor(x);
    return Math.max(3000, s.minDelay + Math.floor(r * s.jitter));
  }

  /* 1.5.22：扫描结束判定（纯函数，不碰 DOM / chrome.*，便于离线模拟）。
   * 旧版只看「名单人数连续 idleRounds 轮没涨」就判 done。X 分页请求经常
   * 要十几秒；全量重扫时返回的全是已存账号，人数也不涨，但 X 明明还在
   * 一页页往下加载 —— 结果就是没扫完就停、采集器被关掉。
   * 现在必须同时满足：① 已过最短扫描时长；② 距最后一次「X 响应到达 /
   * 名单新增 / 页面变高」足够久；③ 连续若干轮完全静默；④ 页面确实滚到底；
   * ⑤ 页面没有加载指示器（且指示器有宽限时间，防常驻 progressbar 卡死）。
   * 滚动 / 时间上限单独返回 limit：由桥接层标「已中断、名单保留、可继续」，
   * 绝不冒充「采集完成」。 */
  function scanVerdict(p) {
    p = p || {};
    var now = num(p.now), startedAt = num(p.startedAt), scrolls = num(p.scrolls);
    var maxScroll = num(p.maxScroll) || DEFAULTS.maxScroll;
    var maxCaptureMs = num(p.maxCaptureMs) || DEFAULTS.maxCaptureMs;
    var minMs = num(p.minMs) || DEFAULTS.scanMinMs;
    var idleMs = num(p.idleMs) || DEFAULTS.scanIdleMs;
    var bottomRounds = num(p.bottomRounds) || DEFAULTS.scanBottomRounds;
    var idleRounds = num(p.idleRounds) || DEFAULTS.idleRounds;
    var graceMs = num(p.loadingGraceMs) || DEFAULTS.scanLoadingGraceMs;

    // 上限优先：宁可说「中断、可继续」，也不把半截名单说成完成
    if (startedAt && maxCaptureMs && now - startedAt >= maxCaptureMs) {
      return { action: 'limit', reason: 'time' };
    }
    if (scrolls >= maxScroll) return { action: 'limit', reason: 'scrolls' };

    if (!startedAt || now - startedAt < minMs) {
      return { action: 'continue', reason: 'warming' };
    }
    var loadingSince = num(p.loadingSince);
    if (p.loading && (!loadingSince || now - loadingSince < graceMs)) {
      return { action: 'continue', reason: 'loading' };
    }
    var lastSignalAt = Math.max(num(p.lastResponseAt), num(p.lastGainAt),
      num(p.lastHeightAt), startedAt);
    if (now - lastSignalAt < idleMs) return { action: 'continue', reason: 'active' };
    if (num(p.idle) < idleRounds) return { action: 'continue', reason: 'idleRounds' };
    if (!p.atBottom) return { action: 'continue', reason: 'notBottom' };
    if (num(p.bottomStable) < bottomRounds) {
      return { action: 'continue', reason: 'bottomUnstable' };
    }
    return { action: 'done', reason: 'bottom' };
  }

  /* ------------------------------------------------------------------
   * 1.5.28：本机名单的数据层（面板 / 桥接层共用同一套口径）
   *   followData = { me, following, followers, updatedAt, savedAt,
   *                  gone:{following:{h:ts}, followers:{h:ts}},   // 墓碑
   *                  baseline:{following:ts, followers:ts},       // 上次完整全量扫描
   *                  history:[{id, at, source, kind, added, removed}] }
   * 墓碑的作用：取F成功 / 全量清理删掉的人，不会被另一个 X 标签页的内存副本
   * 「复活」；除非之后又在列表里真的看到他（seenAt 晚于墓碑时间）。
   * ------------------------------------------------------------------ */
  var MAX_HISTORY = 60;
  var MAX_HISTORY_NAMES = 500;
  var PRUNE_MIN_COVERAGE = 0.85;   // 本轮看到的人数 ≥ 旧名单 85% 才允许清理

  function isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function tsMap(v) {
    var out = {};
    if (!isMap(v)) return out;
    Object.keys(v).forEach(function (k) {
      var h = lowerHandle(k), t = num(v[k]);
      if (validHandle(h) && t) out[h] = t;
    });
    return out;
  }
  function briefUser(u) {
    u = u || {};
    return { handle: lowerHandle(u.handle), name: str(u.name || u.handle).slice(0, 60),
      followers: num(u.followers), verified: !!(u.verified || u.blue) };
  }
  function normalizeHistory(list) {
    var arr = Array.isArray(list) ? list : [];
    var seen = {}, out = [];
    arr.forEach(function (e) {
      if (!isMap(e) || !e.id || seen[e.id]) return;
      seen[e.id] = true;
      out.push({
        id: str(e.id), at: num(e.at),
        source: e.source === 'followers' ? 'followers' : 'following',
        kind: ['scan', 'unfollow'].indexOf(e.kind) >= 0 ? e.kind : 'scan',
        added: (Array.isArray(e.added) ? e.added : []).slice(0, MAX_HISTORY_NAMES).map(briefUser),
        removed: (Array.isArray(e.removed) ? e.removed : []).slice(0, MAX_HISTORY_NAMES).map(briefUser),
        total: num(e.total)
      });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out.slice(-MAX_HISTORY);
  }

  function normalizeData(raw) {
    var d = isMap(raw) ? raw : {};
    var u = isMap(d.updatedAt) ? d.updatedAt : {};
    var g = isMap(d.gone) ? d.gone : {};
    var b = isMap(d.baseline) ? d.baseline : {};
    return {
      me: lowerHandle(d.me || ''),
      // 浅拷贝名单：ingestUsers / removeHandles / finishFullScan 会增删条目，
      // 不能改到调用方手里的原对象（否则「只算一下」也会悄悄改掉已存名单）
      following: isMap(d.following) ? Object.assign({}, d.following) : {},
      followers: isMap(d.followers) ? Object.assign({}, d.followers) : {},
      updatedAt: { following: num(u.following), followers: num(u.followers) },
      savedAt: num(d.savedAt),
      gone: { following: tsMap(g.following), followers: tsMap(g.followers) },
      baseline: { following: num(b.following), followers: num(b.followers) },
      history: normalizeHistory(d.history),
      version: 1, source: 'passive'
    };
  }

  /* storage 最新值 + 某个标签页的内存副本合并：
   * 内存里有、storage 里没有的人照旧补回（防写入失败丢人），
   * 但被墓碑标记、且之后没再出现过的人不补回（防取F后被复活）。 */
  function mergeData(fromStore, fromMemory) {
    var out = normalizeData(fromStore);
    var mem = normalizeData(fromMemory);
    ['following', 'followers'].forEach(function (src) {
      Object.keys(mem.gone[src]).forEach(function (k) {
        out.gone[src][k] = Math.max(out.gone[src][k] || 0, mem.gone[src][k]);
      });
      Object.keys(mem[src]).forEach(function (k) {
        if (out[src][k]) return;
        var u = mem[src][k] || {};
        var tomb = out.gone[src][k] || 0;
        if (tomb && num(u.seenAt) <= tomb) return;
        out[src][k] = u;
      });
      // storage 里残留的旧副本也要按墓碑过滤（另一个标签页刚取F / 刚清理）
      Object.keys(out[src]).forEach(function (k) {
        var tomb2 = out.gone[src][k] || 0;
        if (tomb2 && num((out[src][k] || {}).seenAt) <= tomb2) delete out[src][k];
      });
      out.updatedAt[src] = Math.max(out.updatedAt[src], mem.updatedAt[src]);
      out.baseline[src] = Math.max(out.baseline[src], mem.baseline[src]);
    });
    out.history = normalizeHistory(out.history.concat(mem.history));
    if (!out.me) out.me = mem.me;
    out.savedAt = Math.max(out.savedAt, mem.savedAt);
    return out;
  }

  /* 一批新用户入库：打 seenAt、真的再次出现就撤销墓碑（说明又F注 / 又被F注了）。 */
  function ingestUsers(data, src, users, now) {
    var d = normalizeData(data);
    var key = src === 'followers' ? 'followers' : 'following';
    var t = num(now) || Date.now();
    var before = Object.keys(d[key]).length;
    d[key] = mergeSnapshot(d[key], users, t);
    (users || []).forEach(function (u) {
      var h = u && lowerHandle(u.handle);
      if (h && d.gone[key][h] && d.gone[key][h] < t) delete d.gone[key][h];
    });
    d.updatedAt[key] = t;
    return { data: d, gained: Object.keys(d[key]).length - before };
  }

  function pushHistory(d, entry) {
    if (!entry.added.length && !entry.removed.length) return;
    d.history = normalizeHistory(d.history.concat([entry]));
  }

  /* 取F成功：从「F注中」移除并立墓碑，同时记一条变化记录。 */
  function removeHandles(data, src, handles, now, kind) {
    var d = normalizeData(data);
    var key = src === 'followers' ? 'followers' : 'following';
    var t = num(now) || Date.now();
    var removed = [];
    (handles || []).forEach(function (h0) {
      var h = lowerHandle(h0);
      if (!validHandle(h)) return;
      if (d[key][h]) { removed.push(briefUser(d[key][h])); delete d[key][h]; }
      else removed.push({ handle: h, name: h, followers: 0, verified: false });
      d.gone[key][h] = t;
    });
    if (kind) {
      pushHistory(d, { id: kind + '-' + key + '-' + t, at: t, source: key, kind: kind,
        added: [], removed: removed, total: Object.keys(d[key]).length });
    }
    return { data: d, removed: removed };
  }

  /* 全量扫描「真正完成」后调用：清理本轮没再出现的人，生成新增 / 减少记录。
   * 安全阀：本轮看到的人数不足旧名单的 85% 时不清理（多半是扫描没覆盖全），
   * 第一次全量扫描只建立基线、不生成「新增」记录（否则全员都是新增）。 */
  function finishFullScan(data, src, scanStartedAt, now) {
    var d = normalizeData(data);
    var key = src === 'followers' ? 'followers' : 'following';
    var start = num(scanStartedAt), t = num(now) || Date.now();
    var all = Object.keys(d[key]);
    var seen = all.filter(function (h) { return num(d[key][h].seenAt) >= start; });
    var stale = all.filter(function (h) { return num(d[key][h].seenAt) < start; });
    var coverage = all.length ? seen.length / all.length : 1;
    var hadBaseline = d.baseline[key] > 0;
    if (!start || !seen.length || coverage < PRUNE_MIN_COVERAGE) {
      return { data: d, pruned: false, coverage: coverage, removed: [], added: [],
        reason: !seen.length ? 'empty' : 'coverage' };
    }
    var removed = stale.map(function (h) { return briefUser(d[key][h]); });
    stale.forEach(function (h) { delete d[key][h]; d.gone[key][h] = t; });
    var added = hadBaseline ? seen.filter(function (h) {
      return num(d[key][h].firstSeenAt) >= start;
    }).map(function (h) { return briefUser(d[key][h]); }) : [];
    d.baseline[key] = t;
    pushHistory(d, { id: 'scan-' + key + '-' + t, at: t, source: key, kind: 'scan',
      added: added, removed: removed, total: Object.keys(d[key]).length });
    return { data: d, pruned: true, coverage: coverage, removed: removed, added: added,
      firstBaseline: !hadBaseline };
  }

  /* 面板用：最近 N 天里「取F了我」的人（粉丝全量扫描时发现减少的）。 */
  function recentLostFollowers(data, days, now) {
    var d = normalizeData(data);
    var since = (num(now) || Date.now()) - (num(days) || 30) * DAY_MS;
    var out = [], seen = {};
    d.history.slice().reverse().forEach(function (e) {
      if (e.source !== 'followers' || e.kind !== 'scan' || e.at < since) return;
      e.removed.forEach(function (u) {
        if (seen[u.handle] || d.followers[u.handle]) return;
        seen[u.handle] = true;
        out.push(Object.assign({ at: e.at, followingThem: !!d.following[u.handle] }, u));
      });
    });
    return out;
  }

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* 分类标签在内核里用稳定的英文 id（集合运算与测试依赖它），
   * 但导出表格给用户看时一律翻译成中文。 */
  var TAG_LABELS = {
    verified: '认证账号', big: '大 V', empty: '疑似空号', inactive: '长期不活跃',
    lowratio: '低回F比', normal: '普通', protected: '受保护'
  };

  function tagLabel(t) {
    return TAG_LABELS[t] || '普通';
  }

  function toCsv(users) {
    var head = ['用户名', '昵称', '粉丝数', 'F注数', '推文数', '是否认证',
      '最后发推时间', '分类', '简介', '主页链接'];
    var lines = [head.join(',')];
    (users || []).forEach(function (u) {
      lines.push([
        '@' + u.handle, u.name || '', u.followers || 0, u.friends || 0, u.tweets || 0,
        u.verified ? '是' : '否', u.lastTweetAt || '',
        (u.tags || []).map(tagLabel).join('、'),
        u.bio || '', 'https://x.com/' + u.handle
      ].map(csvEscape).join(','));
    });
    return lines.join('\r\n');
  }

  return {
    DEFAULTS: DEFAULTS,
    GROUPS: GROUPS,
    FILTERS: FILTERS,
    num: num,
    lowerHandle: lowerHandle,
    validHandle: validHandle,
    looksLikeUser: looksLikeUser,
    normalizeUser: normalizeUser,
    sanitizeUser: sanitizeUser,
    pickUsers: pickUsers,
    mergeSnapshot: mergeSnapshot,
    normalizeData: normalizeData,
    mergeData: mergeData,
    ingestUsers: ingestUsers,
    removeHandles: removeHandles,
    finishFullScan: finishFullScan,
    recentLostFollowers: recentLostFollowers,
    PRUNE_MIN_COVERAGE: PRUNE_MIN_COVERAGE,
    mapToList: mapToList,
    relationSets: relationSets,
    parseDate: parseDate,
    ageDays: ageDays,
    classify: classify,
    followerBand: followerBand,
    protectedReasons: protectedReasons,
    isProtected: isProtected,
    buildTask: buildTask,
    delayFor: delayFor,
    scanVerdict: scanVerdict,
    tagLabel: tagLabel,
    toCsv: toCsv
  };
});
