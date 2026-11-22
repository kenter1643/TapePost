/*
 * wallet.js — 只读钱包绑定（1.5.5）+ 钱包身份哈希（1.5.6）
 *
 * 设计红线：
 *   · 扩展只拿「公开地址」，绝不接触私钥 / 助记词，不 eth_sign、不发交易、不请求授权额度。
 *   · 地址用 Web Crypto AES-GCM 加密后存 chrome.storage.local；AES 密钥是本机安装时
 *     随机生成的 32 字节，同样只存本机、不同步、不出扩展。加密前后的明文永不落 storage.sync。
 *   · 钱包探测只在用户主动点「连接钱包」时，由后台用 chrome.scripting 在页面 MAIN world
 *     执行一次；不常驻、不监听页面、不读取页面内容。
 *   · 支持 EIP-6963 多钱包发现 + EIP-1193 传统注入：OKX 欧意 / 币安 Web3 /
 *     TokenPocket / MetaMask / 任何兼容钱包；没有注入式钱包时可手动填地址。
 *   · 1.5.6 起钱包还是打卡的前置条件：未绑定地址不能投「支持」。上传账本的身份
 *     只是一次 SHA-256（地址 + 日期），每天轮换、不可逆，明文地址永远不出本机。
 *
 * 本模块刻意不引用 chrome.*（除存档函数在调用方传入），可用 Node vm 直接测纯逻辑。
 */
'use strict';

var Wallet = (function () {
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  var PROVIDER_HINTS = [
    { test: function (p) { return !!(p && (p.isOkxWallet || p.isOKExWallet || p.isOkWallet)); }, name: 'OKX 欧意钱包', id: 'okx' },
    { test: function (p) { return !!(p && (p.isBinance || p.isBinanceWallet || p.bbSign)); }, name: '币安 Web3 钱包', id: 'binance' },
    { test: function (p) { return !!(p && (p.isTokenPocket || p.isTpWallet)); }, name: 'TokenPocket', id: 'tokenpocket' },
    { test: function (p) { return !!(p && p.isMetaMask); }, name: 'MetaMask', id: 'metamask' },
    { test: function (p) { return !!(p && p.isTrust); }, name: 'Trust Wallet', id: 'trust' },
    { test: function (p) { return !!(p && p.isCoinbaseWallet); }, name: 'Coinbase Wallet', id: 'coinbase' },
    { test: function (p) { return !!(p && p.isRabby); }, name: 'Rabby', id: 'rabby' }
  ];

  function isAddress(v) { return ADDR_RE.test(String(v || '').trim()); }
  function normalizeAddress(v) {
    var s = String(v || '').trim();
    return isAddress(s) ? s.toLowerCase() : null;
  }
  function checksumHint(v) {
    // 不实现 EIP-55 校验和（不需要），只给一个便于肉眼核对的遮罩
    var s = String(v || '');
    return s.length > 12 ? (s.slice(0, 6) + '…' + s.slice(-4)) : s;
  }
  function providerName(id, fallback) {
    for (var i = 0; i < PROVIDER_HINTS.length; i++) {
      if (PROVIDER_HINTS[i].id === id) return PROVIDER_HINTS[i].name;
    }
    return fallback || (id ? String(id) : '注入式钱包');
  }

  /* ---------- 本机 AES-GCM 加密（密钥不出扩展） ---------- */

  function cryptoOf(impl) {
    var c = impl || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!c || !c.subtle) throw new Error('当前环境不支持 Web Crypto');
    return c;
  }
  function b64encode(bytes) {
    var s = '';
    var arr = new Uint8Array(bytes);
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    // btoa 在 Service Worker / Node 18+ 均可用；没有时退回手工实现
    if (typeof btoa === 'function') return btoa(s);
    var table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    for (var j = 0; j < s.length; j += 3) {
      var a = s.charCodeAt(j), b = j + 1 < s.length ? s.charCodeAt(j + 1) : 0,
        d = j + 2 < s.length ? s.charCodeAt(j + 2) : 0;
      var n = (a << 16) | (b << 8) | d;
      out += table[(n >> 18) & 63] + table[(n >> 12) & 63] +
        (j + 1 < s.length ? table[(n >> 6) & 63] : '=') +
        (j + 2 < s.length ? table[n & 63] : '=');
    }
    return out;
  }
  function b64decode(str) {
    var s;
    if (typeof atob === 'function') s = atob(str);
    else {
      var table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      s = '';
      var clean = String(str).replace(/=+$/, '');
      var acc = 0, bits = 0;
      for (var i = 0; i < clean.length; i++) {
        acc = (acc << 6) | table.indexOf(clean[i]); bits += 6;
        if (bits >= 8) { bits -= 8; s += String.fromCharCode((acc >> bits) & 255); }
      }
    }
    var out = new Uint8Array(s.length);
    for (var k = 0; k < s.length; k++) out[k] = s.charCodeAt(k);
    return out;
  }
  function randomBytes(cryptoImpl, n) {
    var c = cryptoOf(cryptoImpl);
    var u = new Uint8Array(n);
    if (c.getRandomValues) c.getRandomValues(u);
    else for (var i = 0; i < n; i++) u[i] = Math.floor(Math.random() * 256);
    return u;
  }
  function newKey(cryptoImpl) { return b64encode(randomBytes(cryptoImpl, 32)); }
  function newSalt(cryptoImpl) { return b64encode(randomBytes(cryptoImpl, 32)); }

  function importKey(cryptoImpl, keyB64) {
    var c = cryptoOf(cryptoImpl);
    return c.subtle.importKey('raw', b64decode(keyB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  function encryptText(cryptoImpl, keyB64, text) {
    var c = cryptoOf(cryptoImpl);
    var iv = randomBytes(c, 12);
    var enc = new TextEncoder();
    return importKey(c, keyB64).then(function (key) {
      return c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
    }).then(function (buf) {
      return { v: 1, iv: b64encode(iv), data: b64encode(buf) };
    });
  }
  function decryptText(cryptoImpl, keyB64, payload) {
    var c = cryptoOf(cryptoImpl);
    if (!payload || payload.v !== 1 || !payload.iv || !payload.data) return Promise.resolve(null);
    return importKey(c, keyB64).then(function (key) {
      return c.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(payload.iv) }, key, b64decode(payload.data));
    }).then(function (buf) {
      return new TextDecoder().decode(new Uint8Array(buf));
    }).catch(function () { return null; });
  }

  /* ---------- 每日匿名投票 ID（不上传钱包地址） ---------- */

  function hexOf(bytes) {
    var a = new Uint8Array(bytes), s = '';
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  function voterId(cryptoImpl, salt, day) {
    var c = cryptoOf(cryptoImpl);
    var data = new TextEncoder().encode(String(salt) + '|' + String(day) + '|tapepost-bem');
    return c.subtle.digest('SHA-256', data).then(hexOf);
  }
  /*
   * 1.5.6：以钱包地址为种子算当日身份哈希。与旧的「本机随机盐」方案相比，
   * 同一个地址在不同设备 / 重装扩展后当天仍是同一票，账本能跨设备去重；
   * 但账本收到的是不可逆哈希，既看不到明文地址，也跨不了天F联同一个人。
   */
  function walletVoterId(cryptoImpl, address, day) {
    var c = cryptoOf(cryptoImpl);
    var addr = normalizeAddress(address);
    if (!addr) return Promise.resolve(null);
    var data = new TextEncoder().encode('tapepost-bem-v2|' + addr + '|' + String(day));
    return c.subtle.digest('SHA-256', data).then(hexOf);
  }

  /* ---------- 页面 MAIN world 注入桥（函数体必须完全自包含） ---------- */
  /*
   * chrome.scripting.executeScript({ func, args, world:'MAIN' }) 会序列化函数源码，
   * 因此这里不能引用模块里的任何变量、常量或辅助函数。
   * 只做两件事：列出已注入钱包 / 对用户选定的钱包调 eth_requestAccounts。
   */
  async function pageBridge(opts) {
    var action = (opts && opts.action) || 'list';
    var wanted = (opts && opts.providerId) || '';
    var w = window;
    var MAP_KEY = '__wbxWalletProvidersV1';
    if (!w[MAP_KEY]) w[MAP_KEY] = {};
    var map = w[MAP_KEY];

    function labelOf(p, seed) {
      if (p && p.isOkxWallet || p && p.isOKExWallet || p && p.isOkWallet) return { n: 'OKX 欧意钱包', i: 'okx' };
      if (p && (p.isBinance || p.isBinanceWallet || p.bbSign)) return { n: '币安 Web3 钱包', i: 'binance' };
      if (p && (p.isTokenPocket || p.isTpWallet)) return { n: 'TokenPocket', i: 'tokenpocket' };
      if (p && p.isMetaMask) return { n: 'MetaMask', i: 'metamask' };
      if (p && p.isTrust) return { n: 'Trust Wallet', i: 'trust' };
      if (p && p.isCoinbaseWallet) return { n: 'Coinbase Wallet', i: 'coinbase' };
      if (p && p.isRabby) return { n: 'Rabby', i: 'rabby' };
      return { n: seed || '注入式钱包', i: '' };
    }
    function add(list, seen, provider, seed, rdns) {
      if (!provider || typeof provider.request !== 'function') return;
      if (seen.indexOf(provider) >= 0) return;
      seen.push(provider);
      var hint = labelOf(provider, seed);
      var id = rdns || hint.i || ('legacy-' + list.length);
      if (map[id] && map[id] !== provider) id = id + '-' + list.length;
      map[id] = provider;
      list.push({ id: id, name: seed || hint.n, rdns: rdns || '' });
    }

    function discover() {
      var list = [], seen = [];
      try {
        var announced = [];
        var handler = function (ev) {
          var d = ev && ev.detail;
          if (d && d.provider) announced.push(d);
        };
        w.addEventListener('eip6963:announceProvider', handler);
        try { w.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) {}
        // 多数钱包同步回 announce；留 250ms 给异步实现
        return new Promise(function (resolve) {
          setTimeout(function () {
            try { w.removeEventListener('eip6963:announceProvider', handler); } catch (e) {}
            announced.forEach(function (d) {
              var info = d.info || {};
              add(list, seen, d.provider, info.name || 'EIP-6963 钱包', info.rdns || '');
            });
            var e = w.ethereum;
            if (e && Array.isArray(e.providers)) {
              e.providers.forEach(function (p) { add(list, seen, p, ''); });
            }
            if (e) add(list, seen, e, '');
            if (w.okxwallet) add(list, seen, w.okxwallet, 'OKX 欧意钱包', 'com.okex.wallet');
            var bh = w.binancewallethooks;
            if (bh && bh.ethereum) add(list, seen, bh.ethereum, '币安 Web3 钱包', 'com.binance.wallet');
            if (w.binanceWallet) add(list, seen, w.binanceWallet, '币安 Web3 钱包', 'com.binance.wallet');
            if (w.tokenpocket) add(list, seen, w.tokenpocket, 'TokenPocket', 'pro.tokenpocket');
            if (w.trustwallet) add(list, seen, w.trustwallet, 'Trust Wallet', 'com.trustwallet.app');
            resolve(list);
          }, 260);
        });
      } catch (err) { return Promise.resolve(list); }
    }

    var providers = await discover();
    if (action === 'list') return { ok: true, providers: providers };
    if (action === 'connect') {
      var p = wanted ? map[wanted] : (providers.length ? map[providers[0].id] : null);
      if (!p) return { ok: false, error: '没有找到该钱包，请刷新页面后重试，或用手动填地址' };
      try {
        var accounts = await p.request({ method: 'eth_requestAccounts' });
        var addr = Array.isArray(accounts) ? accounts[0] : accounts;
        if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
          return { ok: false, error: '钱包未返回有效地址：' + String(addr || '空') };
        }
        var chainId = null;
        try { chainId = await p.request({ method: 'eth_chainId' }); } catch (e2) {}
        return { ok: true, address: String(addr).toLowerCase(), chainId: chainId || null,
          providerId: wanted || (providers[0] && providers[0].id) || '' };
      } catch (err) {
        return { ok: false, error: '钱包拒绝或连接失败：' + String((err && (err.message || err.code)) || err) };
      }
    }
    return { ok: false, error: '未知的钱包动作' };
  }

  return {
    ADDR_RE: ADDR_RE,
    isAddress: isAddress,
    normalizeAddress: normalizeAddress,
    checksumHint: checksumHint,
    providerName: providerName,
    cryptoOf: cryptoOf,
    b64encode: b64encode,
    b64decode: b64decode,
    newKey: newKey,
    newSalt: newSalt,
    encryptText: encryptText,
    decryptText: decryptText,
    voterId: voterId,
    walletVoterId: walletVoterId,
    pageBridge: pageBridge
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Wallet;
