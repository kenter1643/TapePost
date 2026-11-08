#!/usr/bin/env node
/*
 * refresh-sites.mjs — 重新生成 grok.js 里的 TapeOut 收录清单
 *
 * 用法：
 *   node tools/refresh-sites.mjs              # 从线上拉取最新数据
 *   node tools/refresh-sites.mjs --offline    # 用 tools/.cache 里的缓存（断网时用）
 *
 * 数据源（均为 TapeOut.link 官方导航站自己公开的数据文件）：
 *   1) https://tapeout.link/data/sites.js      → window.NAV_DATA，编辑审核收录的站点
 *      （robots.txt 明确允许爬虫与生成式引擎读取；另提供 llms.txt / llms-full.txt）
 *   2) https://web.tapeout.link/api/sites      → DeWeb 链上容器扫描索引
 *   3) https://web.tapeout.link/lib/chain.js   → 链区号，用于把 .tape 名换算成网关子域
 *
 * 输出：替换 grok.js 中 BEGIN/END GENERATED TAPEOUT SITES 之间的区块。
 * 注意：本脚本只是「刷新数据」，判定逻辑永远写在 grok.js 里，不会被覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const GROK = path.join(ROOT, 'grok.js');
const OFFLINE = process.argv.includes('--offline');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BEGIN = '  // BEGIN GENERATED TAPEOUT SITES';
const END = '  // END GENERATED TAPEOUT SITES';

const NAV_URL = 'https://tapeout.link/data/sites.js';
const DEWEB_URL = 'https://web.tapeout.link/api/sites';
const CHAIN_URL = 'https://web.tapeout.link/lib/chain.js';

async function loadText(name, url) {
  const file = path.join(CACHE, name);
  if (OFFLINE) {
    if (!fs.existsSync(file)) throw new Error(`离线模式缺少缓存：${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': url.includes('tapeout.link/data') ? 'https://tapeout.link/' : 'https://web.tapeout.link/' }
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

function zh(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v.zh || v.en || '';
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 只有这几个独立品牌域名允许「同域任意路径 + 子域」也算命中，其余一律精确比对。 */
const DOMAIN_SCOPE_HOSTS = new Set(['tapeout.net', 'tapehub.ai', 'tapecode.ai', 'tapeout.link']);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function scopeFor(url) {
  return DOMAIN_SCOPE_HOSTS.has(hostOf(url)) ? 'domain' : 'exact';
}

function badgesOf(site) {
  const out = [];
  (site.tags || []).forEach((t) => {
    if (/official/i.test(t)) out.push('OFFICIAL');
    else if (/deweb/i.test(t)) out.push('DeWEB');
    else if (/new/i.test(t)) out.push('NEW');
  });
  if (site.hot) out.push('HOT');
  return out;
}

/** .tape 名 → 官方网关 tapekit.org 的精确子域；XLayer 链在中段插入区号 2。 */
function dewebUrl(site, areaCodes) {
  const raw = String(site.name || '').replace(/\.tape$/i, '');
  const parts = raw.split('.');
  if (parts.length !== 2) return '';
  const code = areaCodes[site.chain];
  const label = code ? `${parts[0]}.${code}.${parts[1]}` : raw;
  return 'https://' + label.replace(/\./g, '-') + '.tapekit.org/';
}

function main() {
  const navSrc = fs.readFileSync(path.join(CACHE, 'nav-sites.js'), 'utf8');
  const dewebSrc = fs.readFileSync(path.join(CACHE, 'deweb-sites.json'), 'utf8');
  const chainSrc = fs.readFileSync(path.join(CACHE, 'chain.js'), 'utf8');

  const sandbox = { window: {} };
  vm.runInNewContext(navSrc, sandbox, { timeout: 5000 });
  const nav = sandbox.window.NAV_DATA;
  const deweb = JSON.parse(dewebSrc);

  // 从 chain.js 里提取各链的 areaCode（形如 key: 'xlayer', ... areaCode: 2）
  const areaCodes = {};
  const chainBlocks = chainSrc.split(/key:\s*'/).slice(1);
  chainBlocks.forEach((b) => {
    const key = (b.match(/^([^']+)'/) || [])[1];
    const code = Number((b.slice(0, 1200).match(/areaCode:\s*(\d+)/) || [])[1] || 0);
    if (key && code) areaCodes[key] = code;
  });

  // ---- 1. 导航站编辑收录：按 URL 去重，保留最完整的一条 ----
  const seen = new Map();
  nav.categories.forEach((c) => {
    (c.sites || []).forEach((s) => {
      const url = String(s.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return;
      const prev = seen.get(url);
      const item = {
        name: clip(zh(s.name), 44),
        url,
        category: clip(zh(c.name), 20),
        desc: clip(zh(s.desc), 88),
        tier: (s.tags || []).includes('official') ? 'official' : 'listed',
        badges: badgesOf(s),
        scope: scopeFor(url),
        added: s.added || '',
        source: 'nav'
      };
      // 同一 URL 在多个分类出现时，优先保留 OFFICIAL 标记与更长的简介
      if (!prev || (item.tier === 'official' && prev.tier !== 'official') || item.desc.length > prev.desc.length) {
        seen.set(url, item);
      }
    });
  });

  // 导航站自身也是被认可的入口（页面没给自己列入分类）
  const SELF = {
    name: 'TapeOut.link 生态导航',
    url: 'https://tapeout.link/',
    category: '清单来源',
    desc: 'TapeOut 生态导航站本体：官方认定的收录清单即取自本站 data/sites.js。',
    tier: 'listed', badges: [], scope: 'domain', added: '', source: 'nav'
  };
  if (!seen.has(SELF.url)) seen.set(SELF.url, SELF);

  const NAV = Array.from(seen.values());

  // ---- 2. DeWeb 链上容器索引：按官方网关精确子域去重 ----
  const navHosts = new Set(NAV.map((s) => hostOf(s.url)));
  const dewebSeen = new Map();
  (deweb.sites || []).forEach((s) => {
    const url = dewebUrl(s, areaCodes);
    if (!url) return;
    const item = {
      name: clip(s.title || s.name, 40),
      url,
      category: '链上容器 · ' + (s.chain === 'xlayer' ? 'XLayer' : 'BNB 主网'),
      desc: clip(s.desc, 60),
      tier: 'deweb',
      badges: [],
      scope: 'exact',
      tape: s.name,
      chain: s.chain,
      source: 'deweb'
    };
    // 导航站已单独收录的容器不重复列入（以导航站那条为准）
    if (navHosts.has(hostOf(url))) return;
    if (!dewebSeen.has(url)) dewebSeen.set(url, item);
  });
  const DEWEB = Array.from(dewebSeen.values());

  const checkedAt = new Date().toISOString().slice(0, 10);
  const SOURCE = {
    name: 'TapeOut.link 生态导航收录 + web.tapeout.link DeWeb 索引',
    url: 'https://tapeout.link/',
    dataUrl: NAV_URL,
    dewebUrl: 'https://web.tapeout.link/',
    dewebApi: DEWEB_URL,
    checkedAt,
    navCount: NAV.length,
    dewebCount: DEWEB.length,
    total: NAV.length + DEWEB.length,
    note: '绿标 = TapeOut.link 编辑收录的链接 + web.tapeout.link 已索引的链上容器。tier 区分「项目方官方 / 导航站收录 / 链上容器已索引」，三者均属生态导航认可，但只有 official 档是项目方官方。'
  };

  const lines = [];
  lines.push(BEGIN);
  lines.push('  // 由 `node tools/refresh-sites.mjs` 生成，请勿手工编辑；数据源与口径见工具脚本头部注释。');
  lines.push('  var SOURCE = ' + JSON.stringify(SOURCE, null, 2).split('\n').join('\n  ') + ';');
  lines.push('');
  lines.push('  // 编辑审核收录的链接（含 5 条 OFFICIAL 标记）；全部给绿标。');
  lines.push('  var OFFICIAL_SITES = [');
  NAV.forEach((s) => lines.push('    ' + JSON.stringify(s) + ','));
  lines.push('  ];');
  lines.push('');
  lines.push('  // web.tapeout.link 扫描索引到的链上容器（官方网关精确子域）；同属导航认可，标记层级不同。');
  lines.push('  var DEWEB_SITES = [');
  DEWEB.forEach((s) => lines.push('    ' + JSON.stringify(s) + ','));
  lines.push('  ];');
  lines.push('');
  lines.push('  // 第三方网关：同一链上容器也能通过这些域名打开，命中索引时会提示改用官方网关。');
  lines.push('  var DEWEB_GATEWAYS = [\'tapeout.site\', \'tapeoutscan.io\', \'bem.city\', \'gw.tapeseek.ai\'];');
  lines.push('');
  lines.push('  // 未被导航站收录、但社区里常被问到的地址：明确不给绿标。');
  lines.push('  var REFERENCE_SITES = [');
  const oldRefs = [
    { name: 'TapeOut Daily', url: 'https://tapeoutdaily.ai/', kind: '社区媒体', note: '社区整理的生态媒体，TapeOut.link 未收录，不给绿标。' }
  ];
  oldRefs.forEach((s) => {
    if (!NAV.some((n) => hostOf(n.url) === hostOf(s.url)) && !DEWEB.some((n) => hostOf(n.url) === hostOf(s.url))) {
      lines.push('    ' + JSON.stringify(s) + ',');
    }
  });
  lines.push('  ];');
  lines.push(END);

  const src = fs.readFileSync(GROK, 'utf8');
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  if (i === -1 || j === -1 || j < i) throw new Error('grok.js 里找不到 GENERATED 区块标记，请先恢复标记。');
  const next = src.slice(0, i) + lines.join('\n') + src.slice(j + END.length);
  fs.writeFileSync(GROK, next);

  console.log('已更新 grok.js 收录清单：');
  console.log('  项目方官方 OFFICIAL :', NAV.filter((s) => s.tier === 'official').length);
  console.log('  导航站编辑收录      :', NAV.filter((s) => s.tier === 'listed').length);
  console.log('  链上容器已索引      :', DEWEB.length);
  console.log('  合计                :', SOURCE.total, '（核验日期 ' + checkedAt + '）');
  console.log('  链区号              :', JSON.stringify(areaCodes));
  console.log('  grok.js 大小        :', (fs.statSync(GROK).size / 1024).toFixed(1) + ' KB');
}

// 先抓数据（异步），再执行纯同步的生成逻辑
(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  const jobs = [
    ['nav-sites.js', NAV_URL],
    ['deweb-sites.json', DEWEB_URL],
    ['chain.js', CHAIN_URL]
  ];
  for (const [name, url] of jobs) {
    await loadText(name, url);
    console.log('fetched', name, (fs.statSync(path.join(CACHE, name)).size / 1024).toFixed(1) + ' KB');
  }
  main();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
