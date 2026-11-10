/*
 * promo.js — AI 评论末尾的「TapeOut / $BEM 生态推广尾巴」共享层
 *
 * 内容脚本（content.js）用它给 3 条候选各随机附一句；设置页（popup.js）用同一份
 * 话术做预览，避免两处维护。纯本地字符串处理，不联网、不读写任何数据。
 *
 * 口径约束：内置话术只做生态与技术介绍，不提价格、涨幅、收益或买入建议，
 * 也不塞外链（X 会把链接按 23 字符计权，还容易被判垃圾回复）。
 */
'use strict';

var TapePromo = (function () {
  'use strict';

  var LINES = {
    tapeout: [
      '顺带一提：TapeOut 把 NAND、LATCH 这些逻辑门搬上链，画完连线就能流片成电路 NFT。',
      '补一句：TapeOut 的链上流片挺有意思，门电路真的在链上求值，不是把图片存上链。',
      '感兴趣可以看看 TapeOut：设计电路 → 流片 → 链上验证，整条流程都留着可查的记录。',
      'TapeOut.link 生态导航收了两百多个站点，数据面板、链游、工具都按分类整理好了。',
      '顺手安利 TapeOut.link：生态里哪些是官方入口、哪些是社区作品，导航标得很清楚。',
      '说到链上电路，TapeOut 的 PoD 是拿真实算力跑电路，思路跟常见挖矿不太一样。',
      '题外话：TapeOut 社区最近在折腾链上 CPU 和门级仿真，挺硬核的一拨人。',
      '我常翻 TapeOut 生态导航：官方入口、链上数据、交易所、链游分门别类，找东西省事。'
    ],
    bem: [
      '顺带提一下 $BEM：TapeOut 生态里的代币，主要用于 PoD 产出与链上应用结算。',
      '补一句：$BEM 是 TapeOut 电路的 PoD 产出，社区拿它做支付、打赏和链游道具。',
      '对链上算力经济感兴趣的话，$BEM 的产出与销毁数据都能在链上面板里查到。',
      '$BEM 有意思的地方是它跟电路算力绑定，机制本身比叙事更值得研究。',
      '顺手安利 BEM Community：把 $BEM、Proof of Design 和电路挖矿讲得比较系统。',
      '题外话：$BEM 在生态里更多是工具属性——打赏、支付、抽奖都拿它结算。',
      '想看数据的话，TapeOut 链上面板能查 $BEM 每日产出和成交，不用靠二手截图。',
      '$BEM 的用法挺多：拼矿、链游、域名、链上支付，生态里都有对应站点。'
    ]
  };

  // X 正文上限 280，留 20 字符给链接计权 / emoji / 全角符号的误差
  var MAX_CHARS = 260;
  var MAX_LINE_CHARS = 110;
  var MAX_CUSTOM_LINES = 40;
  var SEP = '\n\n';

  // 按 Unicode 码点计数，避免把 emoji 从中间截断成乱码
  function cpLen(s) { return Array.from(String(s == null ? '' : s)).length; }
  function clip(s, n) {
    return Array.from(String(s == null ? '' : s)).slice(0, Math.max(0, n)).join('');
  }

  function parseCustom(text) {
    return String(text == null ? '' : text)
      .split(/\r?\n/)
      .map(function (x) { return clip(String(x || '').trim(), MAX_LINE_CHARS); })
      .filter(function (x) { return x.length > 0; })
      .slice(0, MAX_CUSTOM_LINES);
  }

  // 自定义话术按主题覆盖内置；某一主题留空时，该主题仍用内置
  function pools(custom) {
    custom = custom || {};
    var t = parseCustom(custom.tapeout);
    var b = parseCustom(custom.bem);
    return {
      tapeout: t.length ? t : LINES.tapeout.slice(),
      bem: b.length ? b : LINES.bem.slice()
    };
  }

  function takeRandom(list, used, rng) {
    if (!list.length) return '';
    var available = list.filter(function (x) { return used.indexOf(x) < 0; });
    var src = available.length ? available : list;
    var i = Math.floor(rng() * src.length) % src.length;
    return src[i < 0 ? 0 : i];
  }

  /* both 模式交替覆盖两个主题，避免 3 条候选全落在同一边；
   * 单主题模式在该主题池里随机取，尽量不重复。rng 可注入，便于回归测试。 */
  function pickLines(target, custom, count, rng, exclude) {
    var r = (typeof rng === 'function') ? rng : Math.random;
    var p = pools(custom);
    var n = Math.max(0, Number(count) || 0);
    var order = [];
    var i;
    if (target === 'tapeout' || target === 'bem') {
      for (i = 0; i < n; i++) order.push(target);
    } else {
      var first = r() < 0.5 ? 'tapeout' : 'bem';
      var other = first === 'tapeout' ? 'bem' : 'tapeout';
      for (i = 0; i < n; i++) order.push(i % 2 === 0 ? first : other);
    }
    var out = [], used = (exclude || []).slice(); // 「换一批」时先排除上一批，避免点了没变化
    order.forEach(function (key) {
      var line = takeRandom(key === 'tapeout' ? p.tapeout : p.bem, used, r);
      used.push(line);
      out.push(line);
    });
    return out;
  }

  function appendLine(comment, line) {
    var text = String(comment == null ? '' : comment).trim();
    if (!line) return text;
    var tag = clip(String(line), MAX_LINE_CHARS);
    if (!tag) return text;
    if (text.indexOf(tag) >= 0) return text; // 已经带同一句时不重复追加
    var tail = SEP + tag;
    if (cpLen(text) + cpLen(tail) <= MAX_CHARS) return text + tail;
    var room = MAX_CHARS - cpLen(tail) - 1;
    if (room < 12) return tag;               // 极端：自定义话术本身过长
    return clip(text, room) + '…' + tail;   // 保住推广句，压缩正文
  }

  /* 1.4.7：识别文本末尾的推广句。
   *
   * 旧版只做「完整字符串精确匹配」，用户手工改了一个标点、删了几个字，
   * 或 X 把换行转成 <br> 之后就认不出来，于是换句时旧句留在正文里、新句再叠一遍。
   * 这里做三层识别：精确 → 归一化（忽略空白与标点差异）→ 模糊（容忍少量改写）。
   * 只在最后一段里找，且模糊匹配要求含生态特征词，避免误删用户正文。
   *
   * 返回 { start, end, line, raw, mode }；start/end 是相对传入 text 的索引。
   * 找不到返回 null。 */
  // X 的编辑器常在末尾留零宽字符 / BOM，普通 \s 清不掉，会干扰末尾匹配
  function rtrim(s) {
    return String(s == null ? '' : s).replace(/[\s\u200b-\u200d\ufeff]+$/, '');
  }

  function normalize(s) {
    return String(s == null ? '' : s)
      .replace(/[\s\u200b-\u200d\ufeff]/g, '')
      .replace(/[，,。.！!？?；;：:、~～·•"'（）()\[\]【】]/g, '');
  }

  // 字符重合度（Dice 系数），用于容忍用户手工改写过的推广句
  function similarity(a, b) {
    var A = Array.from(normalize(a)), B = Array.from(normalize(b));
    if (!A.length || !B.length) return 0;
    var pool = B.slice(), hit = 0;
    A.forEach(function (ch) {
      var i = pool.indexOf(ch);
      if (i >= 0) { hit++; pool.splice(i, 1); }
    });
    return (2 * hit) / (A.length + B.length);
  }

  var TAG_WORDS = /TapeOut|BEM|PoD|流片|生态导航|链上电路|门电路/i;

  function matchTail(text, custom, lastLine) {
    var t = rtrim(text);
    if (!t) return null;
    var p = pools(custom);
    var known = [];
    if (lastLine) known.push(String(lastLine));
    p.tapeout.concat(p.bem).forEach(function (x) {
      if (known.indexOf(x) < 0) known.push(x);
    });

    var parts = t.split(/[\r\n]+/);
    var tail = parts[parts.length - 1];
    if (!tail) return null;
    var base = t.length - tail.length;
    var i, line, score, tailEnd;

    for (i = 0; i < known.length; i++) {
      line = clip(known[i], MAX_LINE_CHARS);
      if (line && tail === line) {
        return { start: base, end: t.length, line: line, raw: tail, mode: 'exact' };
      }
    }
    var nt = normalize(tail);
    for (i = 0; i < known.length; i++) {
      line = clip(known[i], MAX_LINE_CHARS);
      if (line && nt && nt === normalize(line)) {
        return { start: base, end: t.length, line: line, raw: tail, mode: 'norm' };
      }
    }
    if (TAG_WORDS.test(tail) && tail.length >= 12) {
      var best = null;
      for (i = 0; i < known.length; i++) {
        line = clip(known[i], MAX_LINE_CHARS);
        if (!line) continue;
        score = similarity(tail, line);
        if (score >= 0.82 && (!best || score > best.score)) {
          best = { score: score, line: line, raw: tail };
        }
        // 分隔符被手工删掉时，推广句会跟正文粘在同一段
        if (tail.length > line.length) {
          tailEnd = tail.slice(-line.length);
          score = similarity(tailEnd, line);
          if (score >= 0.86 && (!best || score > best.score)) {
            best = { score: score, line: line, raw: tailEnd };
          }
        }
      }
      if (best) {
        return { start: t.length - best.raw.length, end: t.length,
          line: best.line, raw: best.raw, mode: 'fuzzy' };
      }
    }
    return null;
  }

  /* 手动 T 按钮换句时用：把末尾已带上的推广句剥掉，只留用户自己写的正文。
   * 同时覆盖「AI 候选已经自动附加过一句」的情况，避免点 T 按钮后叠两句。 */
  function stripPromo(text, custom) {
    var t = rtrim(text);
    var m = matchTail(t, custom, '');
    return m ? rtrim(t.slice(0, m.start)) : t;
  }

  function decorate(comments, opts) {
    opts = opts || {};
    var list = (comments || []).map(function (c) { return String(c == null ? '' : c); });
    var lines = pickLines(opts.target || 'both', opts.custom, list.length, opts.rng, opts.exclude);
    return {
      lines: lines,
      texts: list.map(function (c, i) { return appendLine(c, lines[i]); })
    };
  }

  return {
    LINES: LINES,
    MAX_CHARS: MAX_CHARS,
    parseCustom: parseCustom,
    pools: pools,
    pickLines: pickLines,
    appendLine: appendLine,
    stripPromo: stripPromo,
    matchTail: matchTail,
    rtrim: rtrim,
    normalize: normalize,
    similarity: similarity,
    decorate: decorate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TapePromo;
