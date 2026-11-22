/*
 * gen-bem-quotes.js — 生成 $BEM 信仰者「激励话语」静态库（1.5.6）
 *
 * 运行：node tools/gen-bem-quotes.js
 * 产出（两个文件都由本脚本生成，勿手改）：
 *   ../bem-quotes.js                 扩展运行时加载：BemQuotes（10000 条）+ BemAvatars（32 款内置头像）
 *   ../../vote-ledger/avatars.json   全网账本服务渲染信仰者墙时用同一份头像表
 *
 * 生成策略：4 套句式 × 各自词槽做笛卡尔积得到候选池（约 2.7 万条），
 * 用固定种子的 PRNG 洗牌后取前 10000 条，保证「条数恰好 10000 / 互不重复 /
 * 四类句式均匀混合 / 每次生成结果完全一致」。词槽里不含尖括号与换行，
 * 因此生成的句子可以直接进 HTML / JSON，不需要再转义。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = 10000;
const EXT_DIR = path.resolve(__dirname, '..');
const OUT_JS = path.join(EXT_DIR, 'bem-quotes.js');
const OUT_AVATARS = path.resolve(EXT_DIR, '..', 'vote-ledger', 'avatars.json');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEMPLATES = [
  {
    // 打气型：别急，等下一次升级；时间会替我们说话。
    fmt: (s) => s[0] + '，' + s[1] + s[2] + '；' + s[3] + '。',
    slots: [
      ['别急', '慢慢来', '稳住', '再熬一程', '把灯留着', '别数震荡', '别被一根 K 线带走',
       '把噪声调小', '给自己一点时间', '别慌', '守住节奏', '把目光放长'],
      ['等', '看', '陪', '守', '攒', '数', '点亮', '接住', '记下', '攒够'],
      ['下一次升级', '电路的回声', '矿机的低鸣', '每一格算力', '那串哈希', '手里的 BEM',
       '这场长跑', '链上的刻度', '今天的日产', '心里那点笃定'],
      ['时间会替我们说话', 'BEM 不辜负长期主义', '信仰不需要日报', '慢就是快', '我们还在场',
       '这就是复利的样子', '圈子会记得', '下一格会更亮', '别把答案交给情绪', '风会转向',
       '账本替你记着', '明天继续打卡']
    ]
  },
  {
    // 意象型：清晨的电路里，亮着一点不肯熄的光；我们都在。
    fmt: (s) => s[0] + '的' + s[1] + '里，' + s[2] + '着' + s[3] + '；' + s[4] + '。',
    slots: [
      ['清晨', '深夜', '周一', '雨天', '盘后', '安静时', '喧嚣外', '低谷中', '高点时', '灯下'],
      ['电路', '矿机', '账本', '算力', '区块', '曲线', '哈希', '仓位', '日产', '社区'],
      ['藏', '亮', '跑', '长', '沉', '攒', '转', '稳', '烧', '记'],
      ['一点不肯熄的光', '一格没停的算力', '一串等验证的哈希', '一份不动的笃定',
       '一行新的记录', '一次安静的复利', '半格向上的刻度', '一个还没讲完的故事',
       '一束留给明天的电', '一句没说出口的坚持'],
      ['我们都在', '这就是信仰的样子', 'BEM 会记住今天', '别急着下结论', '慢慢来比较快',
       '账本上又多一笔', '明天见', '长期主义不喧哗', '电路会给出答案', '继续打卡']
    ]
  },
  {
    // 箴言型：给今天的自己：不看一根 K 线定生死，只管把灯留着。
    fmt: (s) => s[0] + '：' + s[1] + '，' + s[2] + '。',
    slots: [
      ['给今天的自己', '给同路的信仰者', '给还在场的人', '写给下一格算力', '给 BEM 的一句',
       '给这条电路', '给每个清晨', '给漫长的等待', '给不被看见的坚持', '给复利'],
      ['不看一根 K 线定生死', '不把情绪当信号', '不急着证明什么', '不用日报衡量信仰',
       '不追噪声', '不为震荡改口', '不把耐心用尽', '不拿别人的节奏催自己',
       '不在低谷里改名', '不把答案交给运气'],
      ['只管把灯留着', '只管一格格攒', '只管明天继续打卡', '只管守住手里的 BEM',
       '时间会补齐其余', '电路自有它的时序', '账本会替我们作证', '慢一点也没F系',
       '我们比波动更长久', '日产会说话', '让复利慢慢发生', '信念比价格更耐放']
    ]
  },
  {
    // 打卡型：又一个清晨 × 一格电路：稳住，别把答案交给情绪 —— 今天也在为 $BEM 打卡。
    fmt: (s) => s[0] + ' × ' + s[1] + '：' + s[2] + '，' + s[3] + ' —— 今天也在为 $BEM 打卡。',
    slots: [
      ['第 1 天', '第 3 天', '第 7 天', '第 30 天', '第 100 天', '又一个清晨', '又一次盘后',
       '又一轮震荡', '又一格算力', '又一笔日产', '又一天', '又一年'],
      ['一格电路', '一台矿机', '一束光', '一串哈希', '一个区块', '一份耐心',
       '一次确认', '一页账本', '一段长跑', '一点笃定'],
      ['稳住', '别慌', '慢慢来', '继续', '守住', '再等一等', '把灯留着', '别看噪声',
       '照旧', '不为所动'],
      ['风会转向', '我们还在场', '账本替你记着', '时间站在耐心这边', '下一格会更亮',
       '复利不喧哗', '信仰不需要日报', '电路自有它的时序', '明天继续', 'BEM 会记住今天']
    ]
  }
];

function buildPool() {
  const pool = [];
  TEMPLATES.forEach(function (tpl) {
    const idx = tpl.slots.map(function () { return 0; });
    let guard = 0;
    while (guard++ < 200000) {
      const s = idx.map(function (v, i) { return tpl.slots[i][v]; });
      pool.push(tpl.fmt(s));
      let k = idx.length - 1;
      while (k >= 0) {
        idx[k]++;
        if (idx[k] < tpl.slots[k].length) break;
        idx[k] = 0; k--;
      }
      if (k < 0) break;
    }
  });
  return pool;
}

const AVATARS = [
  ['🦊', '#ffe3d2'], ['🦁', '#fff0cf'], ['🐯', '#ffe0d8'], ['🐻', '#eadfce'],
  ['🐼', '#e9eef5'], ['🐨', '#dfe9ff'], ['🐸', '#e3f6e1'], ['🦉', '#e6e0ff'],
  ['🦅', '#d9f0ff'], ['🐺', '#e2e8f0'], ['🐲', '#ffe9f3'], ['🦄', '#f0e1ff'],
  ['🐳', '#d9f4ff'], ['🐬', '#dff0ff'], ['🦈', '#dce9f2'], ['🐢', '#e0f3e6'],
  ['🦋', '#ffe6f0'], ['🐝', '#fff2c9'], ['🐞', '#ffdedb'], ['🌵', '#e2f0d9'],
  ['🌻', '#fff0c2'], ['🌙', '#e3e6ff'], ['⭐', '#fff3cf'], ['🔥', '#ffded0'],
  ['⚡', '#fff1bd'], ['💎', '#dff0ff'], ['🛠️', '#e5e9ee'], ['🧱', '#f3e2d4'],
  ['🔮', '#eee0ff'], ['🧭', '#dceee9'], ['🏔️', '#dfeaf2'], ['🚀', '#ffe1dd']
];

function main() {
  const pool = buildPool();
  const rng = mulberry32(0xBE4C0DE);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  const seen = Object.create(null);
  const lines = [];
  for (let i = 0; i < pool.length && lines.length < TARGET; i++) {
    const s = pool[i];
    if (!s || seen[s] || /[<>&\r\n\t]/.test(s) || s.length < 12 || s.length > 68) continue;
    seen[s] = 1;
    lines.push(s);
  }
  if (lines.length !== TARGET) throw new Error('候选不足，只生成了 ' + lines.length + ' 条');

  const ids = AVATARS.map(function (a, i) { return 'a' + ('0' + (i + 1)).slice(-2); });
  const avatarLines = AVATARS.map(function (a, i) {
    return "    ['" + ids[i] + "', '" + a[0] + "', '" + a[1] + "']";
  }).join(',\n');

  const chunks = [];
  for (let i = 0; i < lines.length; i += 5) {
    chunks.push('  ' + lines.slice(i, i + 5).map(function (s) { return JSON.stringify(s); }).join(', '));
  }

  const js = "/*\n" +
    " * bem-quotes.js — $BEM 信仰者激励话语 × 10000 + 内置头像 × 32（1.5.6）\n" +
    " * 由 tools/gen-bem-quotes.js 生成，请勿手工编辑；改词槽后重跑生成器。\n" +
    " * 纯数据 + 纯逻辑，不引用 chrome.*，Service Worker / popup / Node vm 都能加载。\n" +
    " */\n'use strict';\n\n" +
    "var BemQuotes = (function () {\n" +
    "  var LINES = [\n" + chunks.join(',\n') + "\n  ];\n" +
    "  function at(i) { return LINES[((Number(i) || 0) % LINES.length + LINES.length) % LINES.length]; }\n" +
    "  function randomIndex() {\n" +
    "    try {\n" +
    "      var c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;\n" +
    "      if (c && c.getRandomValues) {\n" +
    "        var u = new Uint32Array(1); c.getRandomValues(u); return u[0] % LINES.length;\n" +
    "      }\n" +
    "    } catch (e) {}\n" +
    "    return Math.floor(Math.random() * LINES.length);\n" +
    "  }\n" +
    "  function pick() { return at(randomIndex()); }\n" +
    "  /* 按任意字符串种子稳定取一句，便于测试与断网补投复用同一句话 */\n" +
    "  function pickBySeed(seed) {\n" +
    "    var h = 2166136261, s = String(seed || '');\n" +
    "    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }\n" +
    "    return at(h >>> 0);\n" +
    "  }\n" +
    "  function validate() {\n" +
    "    var seen = Object.create(null), bad = [], min = 999, max = 0;\n" +
    "    LINES.forEach(function (s, i) {\n" +
    "      if (seen[s]) bad.push('重复@' + i);\n" +
    "      seen[s] = 1;\n" +
    "      if (/[<>&\\r\\n]/.test(s) || s.length < 12 || s.length > 68) bad.push('异常@' + i);\n" +
    "      min = Math.min(min, s.length); max = Math.max(max, s.length);\n" +
    "    });\n" +
    "    return { count: LINES.length, unique: Object.keys(seen).length,\n" +
    "      minLen: min, maxLen: max, bad: bad.slice(0, 10), ok: bad.length === 0 && LINES.length === 10000 };\n" +
    "  }\n" +
    "  return { COUNT: LINES.length, LINES: LINES, at: at, pick: pick, pickBySeed: pickBySeed, validate: validate };\n" +
    "})();\n\n" +
    "var BemAvatars = (function () {\n" +
    "  var LIST = [\n" + avatarLines + "\n  ];\n" +
    "  var MAP = {};\n" +
    "  LIST.forEach(function (r) { MAP[r[0]] = r; });\n" +
    "  function normalize(id) { return MAP[String(id || '')] ? String(id) : LIST[0][0]; }\n" +
    "  function get(id) { var r = MAP[normalize(id)]; return { id: r[0], e: r[1], c: r[2] }; }\n" +
    "  function all() { return LIST.map(function (r) { return { id: r[0], e: r[1], c: r[2] }; }); }\n" +
    "  return { COUNT: LIST.length, LIST: LIST, normalize: normalize, get: get, all: all };\n" +
    "})();\n\n" +
    "if (typeof module !== 'undefined' && module.exports) { module.exports = { BemQuotes: BemQuotes, BemAvatars: BemAvatars }; }\n";

  fs.writeFileSync(OUT_JS, js, 'utf8');
  const avatarMap = {};
  AVATARS.forEach(function (a, i) { avatarMap[ids[i]] = { e: a[0], c: a[1] }; });
  fs.writeFileSync(OUT_AVATARS, JSON.stringify(avatarMap, null, 2) + '\n', 'utf8');
  console.log('候选池:', pool.length, '→ 采纳:', lines.length);
  console.log('长度范围:', Math.min.apply(null, lines.map(function (s) { return s.length; })),
    '~', Math.max.apply(null, lines.map(function (s) { return s.length; })));
  console.log('产出:', OUT_JS, fs.statSync(OUT_JS).size, 'bytes');
  console.log('产出:', OUT_AVATARS, fs.statSync(OUT_AVATARS).size, 'bytes');
  console.log('示例:');
  [0, 1, 2, 3, 4999, 9999].forEach(function (i) { console.log('  [' + i + '] ' + lines[i]); });
}
main();
