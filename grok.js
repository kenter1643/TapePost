/*
 * grok.js — TapePost 的「AI 能力 + 官方链接判定」共享层
 *
 * 被三处加载（同一份代码，不重复维护）：
 *   - background.js：importScripts('grok.js')，Service Worker 里组装 Grok 请求
 *   - popup.html：设置面板读取默认提示词
 *   - panel.html：TapeOut 生态面板做本地白名单判定与结果渲染
 *
 * 设计原则（防伪功能的安全底线）：
 *   「是否 TapeOut 官方认定」只由本地内置白名单的精确匹配决定，Grok 只负责
 *   解释理由、识别相似域名/短链/Punycode 等仿冒特征。模型结论与本地结论冲突时
 *   一律以本地为准 —— 大模型会幻觉，不能让它给钓鱼站发绿标。
 */
'use strict';

var TapeAI = (function () {
  'use strict';

  // ---------- 1. 官方认定清单 ----------
  /*
   * 数据来源：TapeOut 生态导航站 https://tapeout.link/ 上带 OFFICIAL 标记的条目。
   * 核验日期：2026-11-08。链接地址原样取自该页，未做补全或猜测。
   * 只有这个数组里的条目会显示绿标；新增/撤销请改这里并同步提升扩展版本号。
   * 注意：tapeout.link 本身是清单来源站，页面上并没有 OFFICIAL 标记，因此
   *       单独放在下面的「参考链接」里，不给绿标。
   */
  var SOURCE = {
    name: 'TapeOut 生态导航站 OFFICIAL 标记',
    url: 'https://tapeout.link/',
    checkedAt: '2026-11-08',
    note: '绿标 = 该页面标注 OFFICIAL 的条目；HOT / NEW / DeWEB 标记不等于官方认定。'
  };

  var OFFICIAL_SITES = [
    {
      name: 'TapeOut 协议主站',
      url: 'https://tapeout.net/',
      category: '核心协议',
      desc: '官方链上 tapeout 协议：铸造 NAND / LATCH 元件、在画布上连线，再流片成电路 NFT。'
    },
    {
      // x.com 是通用平台：只有这个具体账号路径是官方认定，其它 x.com 路径一律不算。
      name: 'Blonskr · X',
      url: 'https://x.com/blonskr',
      category: '官方公告',
      pathScoped: true,
      desc: 'TapeOut 背后人物的 X 账号，协议公告、发布与重大决策首发地。'
    },
    {
      name: 'TapeHub.ai',
      url: 'https://tapehub.ai/',
      category: '官方 Launchpad',
      desc: '生态启动平台：创建挖矿币项目、mint 晶体管，毕业后在 PancakeSwap 建池并永久锁定流动性。'
    },
    {
      name: 'TapeKit',
      url: 'https://tapekit.org/',
      category: '官方网关',
      desc: 'tape:// 公共网关：在普通浏览器打开链上容器站点，由 Service Worker 直读 BNB Chain 并校验内容哈希。'
    },
    {
      name: 'TapeCode.ai',
      url: 'https://tapecode.ai/',
      category: '官方 AI 构建器',
      desc: '用一句话描述应用即可生成合约与前端并发布；合约归 TapeOut 链上容器所有。'
    }
  ];

  /*
   * 参考链接：生态内常见、但【没有】OFFICIAL 标记的地址。
   * 用途是让真伪查询能明确回答「这是第三方 / 社区整理，不是官方认定」，
   * 而不是笼统说「查不到」。这些一律不给绿标。
   * 来源：tapeout.link 的 HOT / NEW 条目与社区公开整理清单，仅供辨识参考。
   */
  var REFERENCE_SITES = [
    { name: 'TapeOut.link 生态导航', url: 'https://tapeout.link/', kind: '清单来源', note: '本面板官方清单的数据来源站，页面未给自己标 OFFICIAL。' },
    { name: 'TapeOutScan', url: 'https://tapeoutscan.io/', kind: '第三方数据', note: '社区开发的数据浏览器，HOT/NEW 标记，非 OFFICIAL。' },
    { name: 'Firsto 交易终端', url: 'https://tapeout.firsto.ai/', kind: '第三方交易', note: '社区整理的第三方交易前端，非 OFFICIAL。' },
    { name: 'TapeOut Market', url: 'https://tapeout.market/', kind: '第三方交易', note: '社区整理的第三方市场，非 OFFICIAL。' },
    { name: 'tapeout.build 画布', url: 'https://tapeout.build/', kind: '第三方工具', note: '社区整理的第三方画布，非 OFFICIAL。' },
    { name: 'TapeUp', url: 'https://tapeup.io/zh/trade', kind: '第三方交易', note: 'tapeout.link 的 NEW 条目，非 OFFICIAL。' },
    { name: 'TapeOut Daily', url: 'https://tapeoutdaily.ai/', kind: '生态媒体', note: '社区整理的生态媒体，非 OFFICIAL。' },
    { name: 'TapeOut 官方社群（社区整理）', url: 'https://t.me/TapeOutnet', kind: '待核验', note: '来自社区公开整理清单的「官方核心」，tapeout.link 未标注 OFFICIAL，使用前请自行核对。' }
  ];

  // ---------- 2. 可编辑提示词（设置面板可改，{占位符} 必须保留语义） ----------
  var DEFAULT_COMMENT_PROMPT = [
    '你是「昆哥」（TapeOut 社区成员）的 X 回复助手。请根据下面这条推文，写出 3 条可以直接发布的回复候选。',
    '',
    '要求：',
    '1. 三条角度各不相同：一条认同并补充信息，一条提出有价值的问题，一条给出简短独立观点。',
    '2. 中文为主；如果原文是英文，可以用英文回复。语气自然克制、像真人，不要营销腔、不要吹捧、不要喊口号。',
    '3. 每条不超过 180 个字符，不带话题标签、不带链接、不带引号包裹，不编造事实、不给投资建议、不引战。',
    '4. 只输出评论文本，严格返回 JSON 数组：["第一条", "第二条", "第三条"]。不要输出任何解释或 Markdown 代码块。',
    '',
    '推文正文：',
    '"""',
    '{POST}',
    '"""'
  ].join('\n');

  var DEFAULT_VERIFY_PROMPT = [
    '你是 TapeOut 生态的「链接真伪核验」助手。以下是当前【唯一权威】的官方认定平台清单：',
    '{OFFICIAL_LIST}',
    '',
    '请判断下面这条待核验链接是否属于上述官方认定平台，并识别仿冒风险。',
    '',
    '判定规则（必须严格遵守）：',
    '- 只有与清单中某条 URL 的域名与路径完全一致（允许末尾斜杠、大小写、www. 差异）才判 official。',
    '- 域名相似但不相同、多一级子域、路径不同、含跳转参数、Punycode、短链、非 HTTPS，一律不得判 official。',
    '- 不要凭记忆补充任何「官方」网址；清单之外的链接一律不得判为 official。',
    '- 命中参考清单（非 OFFICIAL）的链接判 community，并说明它不是官方认定。',
    '- 含官方品牌词但不在清单里的域名判 fake，并指出疑似仿冒。',
    '',
    '只输出 JSON 对象，不要 Markdown 代码块：',
    '{"verdict":"official|community|fake|unknown","reason":"中文简短理由","risk":"风险提示，没有则留空","matched":"命中的清单 URL，没有则留空"}',
    '',
    '待核验链接：{URL}'
  ].join('\n');

  var SYSTEM_HINT = '你是严格按格式输出的助手。只返回用户要求的 JSON，不要解释、不要前后缀、不要 Markdown 代码块。';

  // ---------- 3. URL 规范化与本地白名单判定 ----------
  var SHORTENER_HOSTS = /(?:^|\.)(?:bit\.ly|t\.cn|tinyurl\.com|s\.id|goo\.gl|is\.gd|ow\.ly|buff\.ly|cutt\.ly|shorturl\.at|rebrand\.ly|tiny\.cc)$/i;

  function stripCodeFence(s) {
    return String(s || '')
      .replace(/^\s*```(?:json|JSON)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
  }

  /*
   * 把用户输入的任意链接文本规范成可比较的形式。
   * 比较口径：https 协议 + 去 www. 的小写 host + 小写 pathname（去末尾斜杠）。
   * query / hash 不参与判定：官网带 ?ref= 仍然是官网；但会原样保留在 raw 里展示。
   */
  function normalizeUrl(input) {
    var raw = String(input == null ? '' : input).trim().replace(/^["'「」]+|["'「」]+$/g, '');
    if (!raw) return { ok: false, raw: '', error: '请输入链接' };
    // 伪协议不是网址，别让它被当成「缺 scheme 的域名」补成 https://javascript:...
    if (/^(?:javascript|data|vbscript|file|about):/i.test(raw)) {
      return { ok: false, raw: raw, error: '检测到非网页协议，已拦截（可能是伪装的钓鱼链接）' };
    }
    // 用户常直接粘贴 tapeout.net 或 x.com/blonskr，补 https 再解析
    var candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    var u;
    try {
      u = new URL(candidate);
    } catch (e) {
      return { ok: false, raw: raw, error: '链接格式无法识别，请粘贴完整的 http(s) 地址' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, raw: raw, error: '只接受 http / https 链接（' + u.protocol + ' 已拦截）' };
    }
    var host = String(u.hostname || '').toLowerCase().replace(/^www\./, '');
    var path = String(u.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    return {
      ok: true,
      raw: raw,
      normalized: u.protocol + '//' + host + path,
      scheme: u.protocol.replace(':', ''),
      host: host,
      path: path,
      key: host + path,
      port: u.port || '',
      punycode: /xn--/i.test(String(u.hostname || '')),
      hasQuery: !!u.search,
      hasHash: !!u.hash
    };
  }

  function siteKey(url) {
    var n = normalizeUrl(url);
    return n.ok ? n.key : '';
  }

  /*
   * 本地权威判定。返回 status: official | community | unknown | invalid。
   * 严格相等（host + path），不做「包含」匹配，避免 tapeout.net.evil.com 混进绿标。
   */
  function matchOfficial(input, officialList, referenceList) {
    var official = officialList || OFFICIAL_SITES;
    var reference = referenceList || REFERENCE_SITES;
    var n = normalizeUrl(input);
    if (!n.ok) return { status: 'invalid', normalized: n, error: n.error, site: null, risks: [] };

    for (var i = 0; i < official.length; i++) {
      var s = official[i];
      if (siteKey(s.url) === n.key) {
        return { status: 'official', normalized: n, site: s, risks: spoofSignals(n, official) };
      }
      // 独立官网的站内页面 / 官方子域同样属于官方域名，不该被误判成仿冒。
      // 但 x.com 这类通用平台必须按账号路径精确比对（pathScoped），
      // 否则任何 x.com 链接都会拿到绿标。
      if (!s.pathScoped) {
        var oh = normalizeUrl(s.url).host;
        if (n.host === oh || n.host.slice(-(oh.length + 1)) === '.' + oh) {
          return { status: 'official', normalized: n, site: s, risks: spoofSignals(n, official) };
        }
      }
    }
    for (var j = 0; j < reference.length; j++) {
      if (siteKey(reference[j].url) === n.key) {
        return { status: 'community', normalized: n, site: reference[j], risks: spoofSignals(n, official) };
      }
    }
    return { status: 'unknown', normalized: n, site: null, risks: spoofSignals(n, official) };
  }

  // 官方域名里可用于识别「形近仿冒」的品牌词。x.com 是通用平台，不纳入。
  var BRAND_WORDS = ['tapeout', 'tapehub', 'tapekit', 'tapecode', 'tapenet'];

  function editDistance(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }

  function spoofSignals(n, officialList) {
    var risks = [];
    if (!n || !n.ok) return risks;
    var list = officialList || OFFICIAL_SITES;
    var host = n.host;

    if (n.punycode) risks.push('域名含 Punycode（xn--），常见于用相似字符冒充官方域名');
    if (n.scheme !== 'https') risks.push('不是 HTTPS 连接，可能被中间人篡改');
    if (n.port && n.port !== '443' && n.port !== '80') risks.push('带非标准端口 :' + n.port + '，正规官网通常不会这样');
    if (SHORTENER_HOSTS.test(host)) risks.push('这是短链，真实跳转地址被隐藏，无法核验');
    if (/javascript:|data:/i.test(n.raw)) risks.push('链接含非网页协议');

    var brandHit = BRAND_WORDS.some(function (w) { return host.indexOf(w) !== -1; });
    // 官方域名及其合法子域不该被自己的品牌词误报成仿冒
    var isOfficialHost = list.some(function (s) {
      var oh = siteKey(s.url).split('/')[0];
      return host === oh || host.slice(-(oh.length + 1)) === '.' + oh;
    });
    if (brandHit && !isOfficialHost) {
      risks.push('域名含 TapeOut 相关品牌词，但不在官方白名单里 —— 高度疑似仿冒');
    }
    // 去掉连字符/点后与官方主域比较，抓 tapeout-net.com / tapeoutnet.io 这类
    var flatHost = host.replace(/[-.]/g, '');
    for (var i = 0; i < list.length; i++) {
      var oh = siteKey(list[i].url).split('/')[0];
      if (!oh || oh === 'x.com') continue; // 通用平台不参与形近比较
      if (host === oh) continue;
      var flatOfficial = oh.replace(/[-.]/g, '');
      if (flatHost === flatOfficial || editDistance(host, oh) <= 2) {
        risks.push('与官方域名 ' + oh + ' 仅差一两个字符，可能是仿冒站');
        break;
      }
    }
    return risks;
  }

  function officialListText(list) {
    var rows = (list || OFFICIAL_SITES).map(function (s, i) {
      return (i + 1) + '. ' + s.name + ' — ' + s.url;
    });
    rows.push('');
    rows.push('参考（非官方认定，不得判 official）：');
    REFERENCE_SITES.forEach(function (s) { rows.push('- ' + s.name + ' — ' + s.url + '（' + s.kind + '）'); });
    return rows.join('\n');
  }

  // ---------- 4. 提示词组装 ----------
  function fillTemplate(tpl, vars, tail) {
    var t = String(tpl || '');
    Object.keys(vars || {}).forEach(function (k) {
      t = t.split(k).join(String(vars[k] == null ? '' : vars[k]));
    });
    // 用户自定义提示词可能删掉占位符，兜底把关键内容追加到末尾
    var missing = [];
    Object.keys(vars || {}).forEach(function (k) { if (String(tpl || '').indexOf(k) === -1) missing.push(k); });
    if (missing.length && tail) t = t + '\n\n' + tail;
    return t;
  }

  function buildCommentMessages(postText, promptTpl) {
    var text = String(postText || '').slice(0, 1200);
    var tpl = promptTpl || DEFAULT_COMMENT_PROMPT;
    var prompt = fillTemplate(tpl, { '{POST}': text }, '推文正文：\n"""\n' + text + '\n"""');
    return [
      { role: 'system', content: SYSTEM_HINT },
      { role: 'user', content: prompt }
    ];
  }

  function buildVerifyMessages(input, promptTpl, officialList) {
    var n = normalizeUrl(input);
    var urlText = n.ok ? n.normalized + (n.hasQuery ? '（原输入含查询参数）' : '') : String(input || '');
    var tpl = promptTpl || DEFAULT_VERIFY_PROMPT;
    var prompt = fillTemplate(
      tpl,
      { '{OFFICIAL_LIST}': officialListText(officialList), '{URL}': urlText },
      '官方清单：\n' + officialListText(officialList) + '\n\n待核验链接：' + urlText
    );
    return [
      { role: 'system', content: SYSTEM_HINT },
      { role: 'user', content: prompt }
    ];
  }

  // ---------- 5. 结果解析（模型输出经常不守格式，做多重兜底） ----------
  function cleanCommentLine(s) {
    return String(s || '')
      .replace(/^\s*(?:\d+[\.、)）]|[-*•])\s*/, '')
      .replace(/^["'「」『』]+|["'「」『』]+$/g, '')
      .replace(/^\*\*|\*\*$/g, '')
      .replace(/^["']\s*|\s*["'],?$/g, '')
      .trim();
  }

  function parseThreeComments(raw) {
    var s = stripCodeFence(raw);
    var out = [];
    try {
      var parsed = JSON.parse(s);
      var arr = Array.isArray(parsed) ? parsed :
        (parsed && (parsed.comments || parsed.replies || parsed.items || parsed.results || parsed.data));
      if (Array.isArray(arr)) {
        arr.forEach(function (x) {
          if (typeof x === 'string') out.push(cleanCommentLine(x));
          else if (x && typeof x === 'object') out.push(cleanCommentLine(x.text || x.content || x.comment || ''));
        });
      }
    } catch (e) {
      // 模型可能返回 {"1":"...","2":"..."} 或纯编号列表
      try {
        var obj = JSON.parse(s);
        if (obj && typeof obj === 'object') {
          Object.keys(obj).sort().forEach(function (k) { if (typeof obj[k] === 'string') out.push(cleanCommentLine(obj[k])); });
        }
      } catch (e2) { /* 下面按行拆 */ }
    }
    if (!out.length) {
      s.split(/\n+/).forEach(function (line) {
        var c = cleanCommentLine(line);
        if (!c) return;
        if (/^[{}\[\]]|^\s*["']?\s*[,}]?\s*$/.test(c)) return;
        if (/^(?:verdict|reason|risk|matched)\s*[:：]/i.test(c)) return;
        out.push(c);
      });
    }
    out = out.map(function (c) { return String(c).slice(0, 240); })
      .filter(function (c, i, a) { return c && a.indexOf(c) === i; });
    return out.slice(0, 3);
  }

  function parseVerdict(raw) {
    var s = stripCodeFence(raw);
    try {
      var o = JSON.parse(s);
      var v = String((o && o.verdict) || '').toLowerCase();
      if (['official', 'community', 'fake', 'unknown'].indexOf(v) === -1) v = 'unknown';
      return {
        verdict: v,
        reason: String((o && o.reason) || '').slice(0, 300),
        risk: String((o && o.risk) || '').slice(0, 300),
        matched: String((o && o.matched) || '').slice(0, 300),
        parsed: true
      };
    } catch (e) {
      return {
        verdict: 'unknown',
        reason: '模型没有按 JSON 格式返回，下方只展示本地白名单结论与模型原文。',
        risk: '',
        matched: '',
        parsed: false,
        rawText: s.slice(0, 600)
      };
    }
  }

  return {
    SOURCE: SOURCE,
    OFFICIAL_SITES: OFFICIAL_SITES,
    REFERENCE_SITES: REFERENCE_SITES,
    DEFAULT_COMMENT_PROMPT: DEFAULT_COMMENT_PROMPT,
    DEFAULT_VERIFY_PROMPT: DEFAULT_VERIFY_PROMPT,
    SYSTEM_HINT: SYSTEM_HINT,
    normalizeUrl: normalizeUrl,
    siteKey: siteKey,
    matchOfficial: matchOfficial,
    spoofSignals: spoofSignals,
    officialListText: officialListText,
    buildCommentMessages: buildCommentMessages,
    buildVerifyMessages: buildVerifyMessages,
    parseThreeComments: parseThreeComments,
    parseVerdict: parseVerdict,
    stripCodeFence: stripCodeFence
  };
})();

// Node 回归测试直接 require；浏览器里 module 不存在，忽略即可
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TapeAI;
}
