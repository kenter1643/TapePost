/*
 * offscreen.js — 在离屏文档中完成：
 *   1. 拉取原图字节 → 解码 → 去水印 → 编码 PNG（base64 回传，JSON 安全）
 *   2. 视频：提取真实 mp4 → 拉成 Blob → 下载 + 尝试写入剪贴板
 *   3. 把「清洗后的文字 + 首图/视频」写进同一个 ClipboardItem
 *
 * 为什么在 offscreen 而不是 content script：
 *  - 图床 sinaimg.cn / 视频 CDN 强制要求 Referer，DNR 注入后扩展上下文
 *    的 fetch 配合 host_permissions 可读字节（绕过 CORS）；
 *  - OffscreenCanvas / createImageBitmap 在离屏文档中可用；
 *  - 剪贴板写入不受微博页面焦点/用户手势过期影响。
 */
'use strict';

const OFFSCREEN_READY = 'OFFSCREEN_READY';

const SIZE_TOKENS = [
  'thumb150', 'thumb300', 'square', 'thumbnail', 'bmiddle',
  'mw690', 'mw1024', 'mw2048', 'orj360', 'orj480', 'small', 'middle'
];

function upgradeImageUrl(url) {
  if (!url) return url;
  let u = url.trim();
  if (u.startsWith('//')) u = 'https:' + u;
  for (const t of SIZE_TOKENS) {
    const re = new RegExp('(sinaimg\\.cn/)' + t + '/');
    if (re.test(u)) { u = u.replace(re, '$1large/'); break; }
  }
  // 保留 query：小红书/知乎等站点的图片签名在 query 里，去掉会 403。
  // content.js 已按站点完成尺寸升级，这里只做微博缩略图的兼容兜底。
  return u;
}

async function fetchImageBytes(url) {
  const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
  return await resp.arrayBuffer();
}

async function decodeToImageData(buf) {
  const blob = new Blob([buf]);
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close && bmp.close();
  return { imgData, canvas, ctx };
}

// Chrome 扩展消息是 JSON 序列化，ArrayBuffer 会丢失；图片用 base64 传
function abToBase64(ab) {
  const bytes = new Uint8Array(ab);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* 1.4.27：4K 高保真输出。
 * 用 createImageBitmap 的 resizeQuality:'high' 分步（每步 ≤1.6×）重采样到
 * 长边 3840；原图已达到 4K 就保持原尺寸不缩小。PNG 无损编码，剪贴板可直接用。
 * 像素上限防止超长图 / 多图时内存爆掉；任何一步失败都回退原尺寸，
 * 保证「一键转发」不会因为放大而中断。 */
const UPSCALE_MAX_EDGE = 3840;
const UPSCALE_MAX_PIXELS = 8.4e6;   // ≈ 3840×2160，兼顾剪贴板与消息体积

async function upscaleTo4K(canvas) {
  const w = canvas.width, h = canvas.height;
  const longEdge = Math.max(w, h);
  const from = [w, h];
  if (longEdge >= UPSCALE_MAX_EDGE) {
    return { canvas, info: { from: from, to: from, reason: '原图已达 4K，保持原尺寸' } };
  }
  let scale = UPSCALE_MAX_EDGE / longEdge;
  if (w * h * scale * scale > UPSCALE_MAX_PIXELS) {
    scale = Math.sqrt(UPSCALE_MAX_PIXELS / (w * h));
  }
  if (scale <= 1.02) return { canvas, info: { from: from, to: from, reason: '无需放大' } };
  const targetW = Math.round(w * scale), targetH = Math.round(h * scale);
  let cur = canvas, curW = w, curH = h;
  let steps = 0;
  while ((curW < targetW || curH < targetH) && steps < 8) {
    const step = Math.min(1.6, targetW / curW, targetH / curH);
    curW = Math.min(targetW, Math.max(curW + 1, Math.round(curW * step)));
    curH = Math.min(targetH, Math.max(curH + 1, Math.round(curH * step)));
    const bmp = await createImageBitmap(cur, {
      resizeWidth: curW, resizeHeight: curH, resizeQuality: 'high'
    });
    const next = new OffscreenCanvas(curW, curH);
    next.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    cur = next;
    steps++;
  }
  return { canvas: cur, info: { from: from, to: [curW, curH], steps: steps } };
}

async function processOne(url, inpaintOpts, hd4k) {
  const finalUrl = upgradeImageUrl(url);
  const buf = await fetchImageBytes(finalUrl);
  const { imgData, canvas, ctx } = await decodeToImageData(buf);
  let wm = null;
  if (inpaintOpts && inpaintOpts.enabled && Inpaint) {
    // 1.4.28：所有站点逐张走「局部对比 + 全图重叠瓦片扫描」，拼接长图中间、
    // 多帧重复、任意位置的水印都能各自定位；只改水印条带掩膜像素。
    // 旧版单区域入口保留作兼容兜底。
    try {
      wm = (inpaintOpts.fullScan && Inpaint.removeWatermarks)
        ? Inpaint.removeWatermarks(imgData, inpaintOpts)
        : Inpaint.removeWatermark(imgData, inpaintOpts);
    } catch (e) { wm = { changed: false, reason: '去水印失败：' + String(e && e.message || e) }; }
  }
  ctx.putImageData(imgData, 0, 0);
  let outCanvas = canvas;
  let up = null;
  if (hd4k) {
    try { const r = await upscaleTo4K(canvas); outCanvas = r.canvas; up = r.info; }
    catch (e) { up = { from: [canvas.width, canvas.height], error: String(e && e.message || e) }; }
  }
  let blob = await outCanvas.convertToBlob({ type: 'image/png' });
  // 4K PNG 对照片类图可能十几 MB；单张过大就回退原尺寸，保证转发不卡死
  if (hd4k && blob.size > 18e6) {
    blob = await canvas.convertToBlob({ type: 'image/png' });
    up = Object.assign({}, up || {}, { fallback: true, reason: '单张 4K PNG 过大，回退原尺寸' });
  }
  return { buf: await blob.arrayBuffer(), wm, up };
}

// ---------- 视频 ----------
/*
 * 页面 DOM 拿不到 mp4 时（播放器用 blob: MSE），用本条博文的 bid 走公开接口
 * m.weibo.cn/statuses/show?id=<bid>，取 page_info.media_info.stream_url_hd。
 * 注意：只有明确检测到视频特征的卡片才会走到这里，图文帖不会白请求。
 */
async function fetchHDUrl(bid) {
  const r = await fetch('https://m.weibo.cn/statuses/show?id=' + encodeURIComponent(bid), {
    credentials: 'omit',
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const mi = ((((j || {}).data || {}).page_info || {}).media_info) || {};
  return mi.stream_url_hd || mi.stream_url || mi.mp4 || null;
}

/*
 * preferHD（「对所有视频去水印」开关）：微博水印多为播放器叠加，
 * 接口返回的 stream_url_hd 原片通常干净，而页面里暴露的直链常是
 * 带水印的低清流。开启时优先 HD；接口被限流/失败会自动回退页面直链，
 * 保证下载不会因为去水印而失败。
 */
async function resolveVideoUrl(videoUrls, bid, preferHD) {
  const direct = (videoUrls || []).find((u) =>
    /^https?:\/\//i.test(u) && /\.mp4|video\.weibocdn\.com/i.test(u) && !/^blob:/i.test(u));

  if (preferHD) {
    let apiErr = null;
    if (bid) {
      try {
        const hd = await fetchHDUrl(bid);
        if (hd) return { url: hd, fromApi: true, hd: true };
      } catch (e) { apiErr = e; } // 432 等限流：回退页面直链
    }
    if (direct) return { url: direct, fromApi: false, hd: false };
    if (apiErr) throw new Error('HD 原片获取失败且页面无可用直链（接口 ' + bid + '）：' + String(apiErr.message || apiErr));
    return { url: null, fromApi: false, hd: false };
  }

  if (direct) return { url: direct, fromApi: false, hd: false };
  if (!bid) return { url: null, fromApi: false, hd: false };
  try {
    return { url: await fetchHDUrl(bid), fromApi: true, hd: false };
  } catch (e) {
    throw new Error('视频地址获取失败（接口 ' + bid + '）：' + String(e && e.message || e));
  }
}

async function fetchVideoBlob(url) {
  const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) throw new Error('视频下载 HTTP ' + r.status);
  return await r.blob();
}

/* 视频不走消息总线（几十 MB 会撑爆 JSON），直接在离屏文档里下载 */
async function downloadVideo(blob) {
  // 1.4.3：视频只能拖入 X（剪贴板不支持 mp4），统一放进临时子目录，
  // background 通过 downloads.onCreated 登记并按保留时长自动清理。
  const filename = 'TapePost_tmp/xpost_' + Date.now() + '.mp4';
  const url = URL.createObjectURL(blob);
  let apiErr = null;
  try {
    // 首选 downloads API（可指定文件名）；blob URL 在部分 Chrome 版本里
    // 无法被下载服务解析，失败时退回离屏文档内的 <a download> 点击。
    if (chrome.downloads && chrome.downloads.download) {
      try {
        const id = await chrome.downloads.download({ url, filename, saveAs: false });
        // onCreated 触发时 filename 可能还没定，这里主动登记最可靠
        try { chrome.runtime.sendMessage({ type: 'TMP_TRACK', id: id, filename: filename }).catch(() => {}); } catch (e) {}
        return { ok: true, filename, bytes: blob.size || 0, via: 'downloads' };
      } catch (e) { apiErr = e; }
    }
    const a = document.createElement('a');
    a.href = url;
    // <a download> 不支持路径分隔，退回纯文件名；后台按 xpost_ 前缀仍会登记
    a.download = filename.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    return { ok: true, filename, bytes: blob.size || 0, via: 'anchor' };
  } catch (e) {
    const why = String(e && e.message || e);
    return { ok: false, error: why + (apiErr ? '；downloads 也失败: ' + String(apiErr.message || apiErr) : '') };
  } finally {
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10000);
  }
}

// ---------- 剪贴板 ----------
/*
 * 剪贴板只放「媒体」，文字由 X 的 intent 预填（最可靠、不会丢）。
 * 不把 text/plain 和 image/png 塞进同一个 ClipboardItem：MDN 说它们是
 * 「同一条剪贴板条目的不同表示」，X 粘贴时通常只挑图片，文字反而可能
 * 跟不过去；若同时预填又粘贴，还会出现重复文字。
 * 媒体写入失败（或无媒体）时才退化为写纯文字，保证用户至少能手动贴字。
 */
async function writeClipboard(text, results, videoBlob) {
  const first = results.find((r) => r.ok && r.data);
  const png = first ? base64ToU8(first.data) : null;
  const attempts = [];
  if (png) {
    attempts.push({
      reps: { 'image/png': new Blob([png], { type: 'image/png' }) },
      textOk: false, media: 'image'
    });
  } else if (videoBlob) {
    // Chrome 大概率拒绝 video/mp4，写不进去就走下面的纯文字兜底
    attempts.push({ reps: { 'video/mp4': videoBlob }, textOk: false, media: 'video' });
  }
  attempts.push({
    reps: { 'text/plain': new Blob([text || ''], { type: 'text/plain' }) },
    textOk: true, media: 'none'
  });

  let lastErr = null;
  for (const a of attempts) {
    try {
      await navigator.clipboard.write([new ClipboardItem(a.reps)]);
      return {
        clipboardOk: true,
        clipboardError: null,
        clipboardText: a.textOk,
        clipboardMedia: a.media
      };
    } catch (e) {
      lastErr = e && e.name ? e.name + ': ' + e.message : String(e);
    }
  }
  return {
    clipboardOk: false,
    clipboardError: lastErr,
    clipboardText: false,
    clipboardMedia: 'none'
  };
}

// ---------- 主流程 ----------
async function handleProcess(msg) {
  const payload = msg.payload || {};
  const urls = payload.imageUrls || [];
  const inpaintOpts = payload.inpaint || null;
  const text = payload.text || '';

  const results = [];
  // 1.4.27：逐张独立处理。单张失败只影响它自己，不会让整条转发失败；
  // 每张都记录「去水印区域」与「4K 放大前后尺寸」，方便在提示里核对。
  const hd4k = payload.hd4k !== false;
  // 多图总预算：4K PNG 体积大，累计到 60MB 后其余图仍逐张去水印、只是不再放大，
  // 避免 base64 走 runtime 消息时把整条转发拖垮。
  let budget = 60 * 1024 * 1024;
  for (const u of urls) {
    try {
      const r = await processOne(u, inpaintOpts, hd4k && budget > 0);
      const ab = r.buf;
      budget -= ab.byteLength;
      results.push({ ok: true, data: abToBase64(ab), wm: r.wm, up: r.up });
    } catch (e) {
      results.push({ ok: false, error: String(e && e.message || e), url: u });
    }
  }

  let videoBlob = null;
  let videoState = null;
  if (payload.hasVideo) {
    try {
      const r = await resolveVideoUrl(payload.videoUrls, payload.bid, !!payload.inpaintVideo);
      if (r.url) {
        const source = r.hd ? 'HD 原片' : (r.fromApi ? '公开接口原片' : '页面直链');
        /* 1.6：含视频的一键转发改为弹「视频工作台」，先只解析地址，不重复
         * 下载几十 MB 的原片——用户在工作台里选择剪接/去水印后再按需取流。 */
        if (payload.videoStudio) {
          videoState = { ok: true, mode: 'studio', url: r.url, source: source, hd: !!r.hd };
        } else {
          videoBlob = await fetchVideoBlob(r.url);
          videoState = await downloadVideo(videoBlob);
          videoState.source = source;
          videoState.hd = !!r.hd;
          videoState.url = r.url;
        }
      } else {
        videoState = { ok: false, error: '页面未暴露视频地址，且本条没有可用的 bid' };
      }
    } catch (e) {
      videoState = { ok: false, error: String(e && e.message || e) };
    }
  }

  const clip = await writeClipboard(text, results, videoBlob);
  return Object.assign({ results, video: videoState }, clip);
}

// 单次请求-响应：处理完后用 sendResponse 把结果直接回给 background 的 await
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'PROCESS_OFFSCREEN') {
    handleProcess(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({
        results: [],
        video: null,
        clipboardOk: false,
        clipboardError: null,
        clipboardText: false,
        clipboardMedia: 'none',
        error: String(e && e.message || e)
      }));
    return true; // 保持消息通道打开以异步 sendResponse
  }

  // 1.6 视频工作台：解析地址 / 下载原片 / 剪接 + 逐帧去水印导出
  if (msg.type === 'VIDEO_RESOLVE_OFFSCREEN' || msg.type === 'VIDEO_ORIGIN_OFFSCREEN' ||
      msg.type === 'PROCESS_VIDEO_OFFSCREEN') {
    const p = msg.payload || {};
    const fail = (e) => sendResponse({ ok: false, error: String(e && e.message || e) });
    (async () => {
      const V = (typeof globalThis !== 'undefined') ? globalThis.VideoEdit : null;
      if (!V) throw new Error('视频剪辑模块未加载：请到 chrome://extensions 重新加载扩展');
      if (msg.type === 'VIDEO_RESOLVE_OFFSCREEN') return V.resolve(p);
      if (msg.type === 'VIDEO_ORIGIN_OFFSCREEN') return V.origin(p);
      return V.exportClip(p);
    })().then((r) => sendResponse(r)).catch(fail);
    return true;
  }

  return false;
});

// READY 上报只是通知，扩展重新加载时后台可能还没注册监听器；
// 用回调式发送并显式吞掉 lastError，避免在「错误」面板留下无接收者的报错。
try {
  chrome.runtime.sendMessage({ type: OFFSCREEN_READY }, () => {
    try { void chrome.runtime.lastError; } catch (e) {}
  });
} catch (e) { /* 上下文已失效，忽略 */ }
