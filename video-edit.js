/*
 * video-edit.js — 1.5.2：离屏文档内的「视频剪接 + 逐帧去水印」引擎。
 *
 * 为什么放在 offscreen：
 *  - 视频 CDN 有 Referer / CORS 限制，扩展上下文 fetch 到 Blob 后再用同源
 *    blob: URL 喂给 <video>，canvas 才不会被污染、getImageData 才可用；
 *  - MediaRecorder / canvas.captureStream / requestVideoFrameCallback 在
 *    离屏文档里可用，且不受微博页面焦点与用户手势过期影响；
 *  - 全程本机像素计算，不上传视频、不调用云端 AI、不新增权限或域名。
 *
 * 输出：优先 MP4（Chrome 126+ 的 MediaRecorder 支持），否则 WebM(VP9/VP8)。
 * 剪接：多段 [start,end] 顺序播放录制进同一个 MediaRecorder，段间 pause，
 * 最终得到一段拼好的片段。
 *
 * 1.5.12 去水印：旧版复用图片检测（静态高清图阈值）+ 图片条带重建，视频帧
 * 缩放 / 压缩 / 半透明水印几乎全部漏检，boxes 恒为空 → 每帧原样输出，用户
 * 看到「勾了去水印但水印还在」。现在三件事：
 *   1) 视频链路单独放宽检测参数，且前 12 帧逐帧扫、之后每 30 帧重检；
 *   2) 手动框（角落预设 / 预览拖框）随消息传入，每帧无条件重建，100% 生效；
 *   3) 改用同帧内双向线性插值的 rebuildVideoBox，避免图片版按列插值在运动
 *      画面上拉出竖条纹；自动一个框都没命中时结果里明确报警，不再静默完成。
 */
'use strict';

(function () {
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  const MAX_TOTAL_SECONDS = 90;     // 单次导出上限，防止录制无限拖长
  const MAX_RETURN_BYTES = 24e6;    // 回传 content 的 base64 体积上限
  const RECHECK_FRAMES = 30;        // 1.5.12：约每 1 秒重检一次，兼容移动水印
  const WARMUP_FRAMES = 12;         // 片头常是黑帧 / 淡入，前 12 帧逐帧扫描
  const MAX_WM_BOXES = 6;           // 手动框 + 自动框的总上限
  const MIN_SEGMENT = 0.2;

  /* 1.5.12：视频帧专用检测参数。
   * 之前直接复用图片的 TILE_DEFAULTS（为 1200x1466 / 648x1920 的静态高清图
   * 调过：lumStrong 175 / deltaStrong 18 / widthMin 90 / jumpsConfirm 12 /
   * strongMin 0.08）。视频帧被缩到 540~720p、经过 H.264 压缩、水印多为半透明
   * 且高度只有十几像素，这些阈值几乎全部卡死 —— 检测结果恒为 0，boxes 为空，
   * 于是每一帧都原样 putImageData 回去，用户看到「勾了逐帧去水印但水印还在」。
   * 这里只放宽视频链路，图片的 TILE_DEFAULTS 一个字节都不动。 */
  const VIDEO_WM_DEFAULTS = {
    lumStrong: 145, deltaStrong: 7, satStrong: 70,
    lumBand: 105, deltaBand: 2.5, satBand: 100,
    rowThrAbs: 4, rowAdapt: 1.12, rowMin: 3, rowMax: 60,
    colMin: 18, colGap: 10,
    densScanMin: 0.015, densScanMax: 0.75, jumpsScanMin: 3, ratioScanMin: 1.6,
    jumpsConfirm: 5, widthMin: 40,
    gradMin: 0.03, strongMin: 0.012, maxRowDens: 0.92, vRunMax: 12,
    brightMax: 0.92,
    minStrokeCov: 0.012,
    maxBoxes: 6, rebuildPad: 8,
    maxPixels: 8000000
  };

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') throw new Error('当前 Chrome 不支持 MediaRecorder');
    for (const m of MIME_CANDIDATES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
    }
    throw new Error('没有可用的视频编码格式（MP4 / WebM 均不支持）');
  }

  function toBase64(ab) {
    const bytes = new Uint8Array(ab);
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function progress(p, phase, percent, note) {
    // 只有带 requestId 的导出才广播进度，避免「下载原片」把状态栏刷掉
    if (!p || !p.requestId) return;
    try {
      chrome.runtime.sendMessage({
        type: 'VIDEO_PROGRESS',
        tabId: p.tabId || null,
        requestId: p.requestId || '',
        phase: phase,
        percent: Math.round(percent || 0),
        note: note || ''
      }, () => { try { void chrome.runtime.lastError; } catch (e) {} });
    } catch (e) {}
  }

  function waitEvent(el, name, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { el.removeEventListener(name, onOk); } catch (e) {}
        clearTimeout(timer);
        ok ? resolve() : reject(new Error('等待 ' + name + ' 超时'));
      };
      const onOk = () => finish(true);
      try { el.addEventListener(name, onOk, { once: true }); } catch (e) {
        try { el.addEventListener(name, onOk); } catch (e2) {}
      }
      const timer = setTimeout(() => finish(false), ms || 8000);
    });
  }

  function nextFrame(v) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        if (typeof v.requestVideoFrameCallback === 'function') {
          v.requestVideoFrameCallback(finish);
        } else if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(finish);
        } else setTimeout(finish, 33);
      } catch (e) { setTimeout(finish, 33); }
      // 播放意外停住时不能让整个导出卡死
      setTimeout(finish, 900);
    });
  }

  function normalizeSegments(list, duration) {
    const raw = (Array.isArray(list) && list.length) ? list : [{ start: 0, end: duration }];
    const out = [];
    let total = 0;
    for (const s of raw) {
      if (out.length >= 4) break;
      let a = Math.max(0, Number(s.start) || 0);
      let b = Number(s.end);
      // 工作台把「结束留空」传成 0：视为到片尾
      if (!isFinite(b) || b <= a) b = duration;
      b = Math.min(duration, Math.max(a + MIN_SEGMENT, b));
      a = Math.max(0, Math.min(a, duration - MIN_SEGMENT));
      if (total + (b - a) > MAX_TOTAL_SECONDS) b = a + Math.max(0, MAX_TOTAL_SECONDS - total);
      if (b - a < MIN_SEGMENT) continue;
      out.push({ start: a, end: b });
      total += b - a;
      if (total >= MAX_TOTAL_SECONDS) break;
    }
    if (!out.length) out.push({ start: 0, end: Math.min(duration, MAX_TOTAL_SECONDS) });
    return { segments: out, total: out.reduce((n, s) => n + s.end - s.start, 0) };
  }

  async function resolveSource(p) {
    const fn = (typeof globalThis !== 'undefined') ? globalThis.resolveVideoUrl : null;
    if (typeof fn !== 'function') throw new Error('视频地址解析模块未就绪，请重载扩展');
    const r = await fn(p.videoUrls || [], p.bid || '', !!p.preferHD);
    if (!r || !r.url) throw new Error('未拿到视频地址（页面未暴露直链，且公开接口不可用）');
    return {
      url: r.url,
      source: r.hd ? 'HD 原片' : (r.fromApi ? '公开接口原片' : '页面直链'),
      hd: !!r.hd
    };
  }

  async function fetchAsBlob(url, p) {
    progress(p, 'fetch', 2, '下载原片…');
    const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!resp.ok) throw new Error('视频下载 HTTP ' + resp.status);
    return await resp.blob();
  }

  async function saveBlob(blob, ext, tag) {
    // 与图片一样落进 TapePost_tmp/，后台按保留时长自动清理
    const filename = 'TapePost_tmp/xpost_' + (tag || 'clip') + '_' + Date.now() + '.' + ext;
    const url = URL.createObjectURL(blob);
    try {
      if (chrome.downloads && chrome.downloads.download) {
        try {
          const id = await chrome.downloads.download({ url, filename, saveAs: false });
          try {
            chrome.runtime.sendMessage({ type: 'TMP_TRACK', id: id, filename: filename })
              .catch(() => {});
          } catch (e) {}
          return { ok: true, filename: filename };
        } catch (e) { /* 退回 <a download> */ }
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true, filename: filename };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10000);
    }
  }

  async function openVideo(blob) {
    const v = document.createElement('video');
    v.muted = true;            // 无用户手势的离屏文档里，静音才能可靠 play()
    v.playsInline = true;
    v.preload = 'auto';
    v.src = URL.createObjectURL(blob);
    try { document.body.appendChild(v); } catch (e) {}
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          v.addEventListener('loadedmetadata', resolve, { once: true });
          v.addEventListener('error', () => reject(new Error('视频解码失败（格式不受支持）')), { once: true });
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('读取视频元数据超时')), 20000))
      ]);
    } catch (e) {
      try { URL.revokeObjectURL(v.src); v.remove(); } catch (e2) {}
      throw e;
    }
    return v;
  }

  /* 混入原片音轨。离屏文档没有用户手势，AudioContext 可能被挂起；
   * 失败就静默降级为无声片段，绝不因为音频拖垮整次导出。 */
  async function attachAudio(v, canvasStream, mute) {
    if (mute) return { ok: false, reason: '用户选择静音' };
    let actx = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return { ok: false, reason: 'AudioContext 不可用' };
      actx = new AC();
      try { await actx.resume(); } catch (e) {}
      if (actx.state !== 'running') {
        try { await actx.close(); } catch (e) {}
        actx = null;
        return { ok: false, reason: '离屏音频上下文未启动' };
      }
      const src = actx.createMediaElementSource(v);
      const dest = actx.createMediaStreamDestination();
      src.connect(dest);
      const tracks = dest.stream.getAudioTracks();
      if (!tracks.length) throw new Error('没有音轨');
      tracks.forEach((t) => canvasStream.addTrack(t));
      return { ok: true, actx: actx };
    } catch (e) {
      try { if (actx) await actx.close(); } catch (e2) {}
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 手动框一律用 0~1 归一化坐标 {x0,y0,x1,y1} 传进来，按实际画布尺寸换算。
   * 归一化才能无视「预览用的原片分辨率」与「导出缩放后的 W/H」差异。 */
  function normalizeWmBoxes(list, W, H) {
    const out = [];
    for (const b of (Array.isArray(list) ? list : [])) {
      if (out.length >= MAX_WM_BOXES) break;
      if (!b) continue;
      const v = [Number(b.x0), Number(b.y0), Number(b.x1), Number(b.y1)];
      if (!v.every((n) => isFinite(n))) continue;
      const bx0 = clampNum(Math.round(Math.min(v[0], v[2]) * W), 0, W - 1);
      const bx1 = clampNum(Math.round(Math.max(v[0], v[2]) * W), 0, W - 1);
      const by0 = clampNum(Math.round(Math.min(v[1], v[3]) * H), 0, H - 1);
      const by1 = clampNum(Math.round(Math.max(v[1], v[3]) * H), 0, H - 1);
      if (bx1 - bx0 < 6 || by1 - by0 < 4) continue;
      out.push({ bx0: bx0, by0: by0, bx1: bx1, by1: by1 });
    }
    return out;
  }

  /* 1.5.12：视频专用重建。图片用的 rebuildBand 是「按列取上下参考行插值 +
   * 上下方高频残差」，在静态图上干净，但视频里上下方是运动物体的不同位置，
   * 会把水印区拉成竖条纹，看起来像水印还在。这里改成同帧内「左右 + 上下」
   * 双向线性插值混合：只用当前帧的真实像素，纹理连贯、不产生跨帧拉丝，
   * 边缘羽化避免矩形硬边。返回改动像素数。 */
  function rebuildVideoBox(data, src, W, H, box) {
    const x0 = clampNum(box.bx0, 0, W - 1), x1 = clampNum(box.bx1, 0, W - 1);
    const y0 = clampNum(box.by0, 0, H - 1), y1 = clampNum(box.by1, 0, H - 1);
    if (x1 - x0 < 2 || y1 - y0 < 2) return 0;
    const R = 4, fade = 5;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const rowL = new Float32Array(h * 3), rowR = new Float32Array(h * 3);
    const colT = new Float32Array(w * 3), colB = new Float32Array(w * 3);
    for (let y = y0; y <= y1; y++) {
      const ri = (y - y0) * 3;
      let ln = 0, rn = 0;
      for (let d = 1; d <= R; d++) {
        const lx = clampNum(x0 - d, 0, W - 1), rx = clampNum(x1 + d, 0, W - 1);
        const li = (y * W + lx) * 4, ii = (y * W + rx) * 4;
        for (let c = 0; c < 3; c++) { rowL[ri + c] += src[li + c]; rowR[ri + c] += src[ii + c]; }
        ln++; rn++;
      }
      if (ln) for (let c = 0; c < 3; c++) { rowL[ri + c] /= ln; rowR[ri + c] /= rn; }
    }
    for (let x = x0; x <= x1; x++) {
      const ci = (x - x0) * 3;
      let tn = 0, bn = 0;
      for (let d = 1; d <= R; d++) {
        const ty = clampNum(y0 - d, 0, H - 1), by = clampNum(y1 + d, 0, H - 1);
        const ti = (ty * W + x) * 4, bi = (by * W + x) * 4;
        for (let c = 0; c < 3; c++) { colT[ci + c] += src[ti + c]; colB[ci + c] += src[bi + c]; }
        tn++; bn++;
      }
      if (tn) for (let c = 0; c < 3; c++) { colT[ci + c] /= tn; colB[ci + c] /= bn; }
    }
    let changed = 0;
    for (let y = y0; y <= y1; y++) {
      const ri = (y - y0) * 3;
      const b = (y - y0) / Math.max(1, y1 - y0);
      for (let x = x0; x <= x1; x++) {
        const ci = (x - x0) * 3;
        const a = (x - x0) / Math.max(1, x1 - x0);
        const edge = Math.min(x - x0, x1 - x, y - y0, y1 - y);
        let alpha = 1;
        if (edge < fade) alpha = (edge + 1) / (fade + 1);
        if (alpha <= 0) continue;
        const gi = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const horiz = rowL[ri + c] * (1 - a) + rowR[ri + c] * a;
          const vert = colT[ci + c] * (1 - b) + colB[ci + c] * b;
          const fill = horiz * 0.62 + vert * 0.38;
          data[gi + c] = src[gi + c] * (1 - alpha) + fill * alpha;
        }
        changed++;
      }
    }
    return changed;
  }

  function makeWatermarkProcessor(W, H, p) {
    const hasInpaint = (typeof Inpaint !== 'undefined' && Inpaint.TILE_DEFAULTS &&
      typeof Inpaint.buildStrokeMask === 'function' &&
      typeof Inpaint.findWatermarkBands === 'function');
    const o = hasInpaint ? Object.assign({}, Inpaint.TILE_DEFAULTS, VIDEO_WM_DEFAULTS) : null;
    const manual = normalizeWmBoxes(p && p.wmBoxes, W, H);
    let mode = (p && p.wmMode) || (p && p.wm ? 'auto' : 'off');
    if (mode === 'manual' && !manual.length) mode = 'auto';
    if (!p || !p.wm) mode = 'off';
    let boxes = mode === 'manual' ? manual.slice() : [];
    let scans = 0, frames = 0, detected = 0;

    function detect(img) {
      const ctx = Inpaint.buildStrokeMask(img.data, W, H, o);
      const bands = Inpaint.findWatermarkBands(ctx.soft, W, H, o, ctx);
      const found = [];
      for (const b of bands) {
        if (found.length >= MAX_WM_BOXES) break;
        const box = {
          bx0: clampNum(b.x0 - o.rebuildPad, 0, W - 1),
          by0: clampNum(b.y0 - o.rebuildPad, 0, H - 1),
          bx1: clampNum(b.x1 + o.rebuildPad, 0, W - 1),
          by1: clampNum(b.y1 + o.rebuildPad, 0, H - 1)
        };
        const bw = box.bx1 - box.bx0 + 1, bh = box.by1 - box.by0 + 1;
        if (bw < 8 || bh < 4) continue;
        // 二次保险：条带里必须真有亮笔画，避免把字幕 / 白墙 / 高光整块抹掉
        let strokes = 0;
        for (let y = box.by0; y <= box.by1; y++) {
          for (let x = box.bx0; x <= box.bx1; x++) {
            const i = y * W + x;
            if (ctx.strong[i] || ctx.soft[i]) strokes++;
          }
        }
        if (strokes / (bw * bh) < o.minStrokeCov) continue;
        found.push(box);
      }
      return found;
    }

    return {
      mode: mode,
      apply(img, frameIdx) {
        if (mode === 'off' || (mode === 'auto' && !hasInpaint)) return;
        if (mode === 'auto') {
          // 片头每 3 帧扫一次（黑帧 / 淡入不至于一直空着），之后每 30 帧重检。
          // 每 3 帧而不是每帧：buildStrokeMask 是全图 O(N) 积分图 + 两档瓦片，
          // 1080p 逐帧扫会把实时录制拖成慢动作。
          const rescan = (frameIdx < WARMUP_FRAMES && frameIdx % 3 === 0) ||
            frameIdx % RECHECK_FRAMES === 0;
          if (rescan) {
            scans++;
            try {
              const found = detect(img);
              // 命中即生效（固定水印每轮都能重新定位，也顺带跟上移动水印）；
              // 没命中立刻收手，绝不让上一轮偶然误检的框继续抹 30 帧画面。
              boxes = found;
              if (found.length) detected = Math.max(detected, found.length);
            } catch (e) { /* 单帧检测失败不影响录制 */ }
          }
        }
        if (!boxes.length) return;
        const src = img.data.slice();
        for (const box of boxes) {
          try { rebuildVideoBox(img.data, src, W, H, box); } catch (e) {}
        }
        frames++;
      },
      stats() {
        return {
          mode: mode,
          regions: mode === 'manual' ? manual.length : detected,
          frames: frames,
          scans: scans,
          detected: mode === 'manual' ? manual.length > 0 : detected > 0,
          boxes: boxes.length
        };
      }
    };
  }

  function wmNoteFor(st) {
    if (st.mode === 'off') return '未启用去水印';
    if (st.mode === 'manual') {
      return st.frames
        ? `已按 ${st.regions} 个手动框逐帧重建 ${st.frames} 帧`
        : '手动框无效，未处理任何帧';
    }
    if (st.detected && st.frames) {
      return `自动检出 ${st.regions} 处、逐帧重建 ${st.frames} 帧`;
    }
    return '未自动检出水印，成品仍是原画面！请在「水印位置」点选水印所在角落（或在预览上拖框）后重新生成。';
  }

  async function exportClip(p) {
    const srcInfo = p.url ? { url: p.url, source: p.source || '已解析', hd: !!p.hd } : await resolveSource(p);
    const blob = await fetchAsBlob(srcInfo.url, p);
    if (blob.size > 220e6) throw new Error('原片超过 220MB，本机处理已跳过（请先剪短片段）');

    const mime = pickMime();
    const ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    const v = await openVideo(blob);
    const duration = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (!duration) throw new Error('无法读取视频时长（可能是直播流或加密流）');
    const { segments, total } = normalizeSegments(p.segments, duration);

    const maxEdge = Math.max(360, Math.min(1920, Number(p.maxEdge) || 720));
    let W = v.videoWidth || 720, H = v.videoHeight || 1280;
    const scale = Math.min(1, maxEdge / Math.max(W, H));
    W = Math.max(2, Math.round(W * scale / 2) * 2);   // H.264 要求偶数
    H = Math.max(2, Math.round(H * scale / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    try {
      canvas.style.display = 'none';
      document.body.appendChild(canvas);   // 挂载后 captureStream 在部分 Chrome 版本更稳
    } catch (e) {}
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D 不可用');

    progress(p, 'prepare', 5, '准备录制…');
    const stream = canvas.captureStream(30);
    const audio = await attachAudio(v, stream, !!p.mute);
    const bitrate = Math.max(1200000, Math.min(6000000, Math.round(W * H * 2.2)));
    let rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    } catch (e) {
      rec = new MediaRecorder(stream, { videoBitsPerSecond: bitrate });
    }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => {
      try { rec.addEventListener('stop', resolve, { once: true }); } catch (e) {}
      rec.onstop = resolve;
    });

    const wm = makeWatermarkProcessor(W, H, p);
    let frameIdx = 0;
    let elapsedDone = 0;
    const drawFrame = () => {
      try { ctx.drawImage(v, 0, 0, W, H); } catch (e) { return; }
      if (wm.mode !== 'off') {
        let img = null;
        try { img = ctx.getImageData(0, 0, W, H); } catch (e) { return; }
        wm.apply(img, frameIdx);
        try { ctx.putImageData(img, 0, 0); } catch (e) {}
      }
      frameIdx++;
    };

    try {
      // 录制开始延后到第一段首帧画好之后，否则文件开头会有一段空白黑帧
      let started = false;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (i > 0) { try { rec.pause(); } catch (e) {} }
        try {
          // currentTime 设成当前值不会触发 seeked，硬等会白等好几秒
          if (Math.abs(v.currentTime - seg.start) > 0.02) {
            v.currentTime = seg.start;
            await waitEvent(v, 'seeked', 2500);
          }
        } catch (e) { /* F键帧不精确时仍能继续播放 */ }
        try { await v.play(); } catch (e) {}
        if (!started) {
          await nextFrame(v);
          drawFrame();
          rec.start(250);
          started = true;
        } else {
          try { rec.resume(); } catch (e) {}
        }
        let guard = 0;
        while (v.currentTime < seg.end - 0.03 && !v.ended && guard < 6000) {
          await nextFrame(v);
          drawFrame();
          guard++;
          const done = elapsedDone + Math.min(seg.end - seg.start, Math.max(0, v.currentTime - seg.start));
          if (guard % 8 === 0) {
            progress(p, 'render', 5 + 85 * (done / Math.max(0.1, total)),
              `第 ${i + 1}/${segments.length} 段 · ${v.currentTime.toFixed(1)}s / ${seg.end.toFixed(1)}s`);
          }
        }
        elapsedDone += seg.end - seg.start;
        try { v.pause(); } catch (e) {}
        progress(p, 'render', 5 + 85 * (elapsedDone / Math.max(0.1, total)), '片段 ' + (i + 1) + ' 完成');
      }
      try { rec.stop(); } catch (e) {}
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 8000))]);
    } finally {
      try { v.pause(); } catch (e) {}
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      try { canvas.remove(); } catch (e) {}
      try { document.body.removeChild(canvas); } catch (e) {}
      try { URL.revokeObjectURL(v.src); v.remove(); } catch (e) {}
      try { if (audio.actx) audio.actx.close(); } catch (e) {}
    }

    if (!chunks.length) throw new Error('录制没有产出数据（浏览器可能阻止了离屏播放）');
    const outBlob = new Blob(chunks, { type: mime });
    if (outBlob.size < 1024) throw new Error('录制数据异常过小，已取消输出');

    progress(p, 'save', 94, '生成文件…');
    const file = await saveBlob(outBlob, ext, 'clean');
    const ab = await outBlob.arrayBuffer();
    const wmStats = wm.stats();
    const result = {
      ok: true,
      mime: mime,
      ext: ext,
      bytes: outBlob.size,
      duration: Number(total.toFixed(1)),
      source: srcInfo.source,
      sourceUrl: srcInfo.url,
      segments: segments,
      size: [W, H],
      audio: !!audio.ok,
      audioReason: audio.ok ? '' : (audio.reason || ''),
      wmEnabled: wm.mode !== 'off',
      wmMode: wm.mode,
      wm: wmStats,
      wmNote: wmNoteFor(wmStats),
      file: file
    };
    if (ab.byteLength <= MAX_RETURN_BYTES) result.data = toBase64(ab);
    else result.oversize = true;
    progress(p, 'done', 100, '完成');
    return result;
  }

  async function origin(p) {
    const s = p.url ? { url: p.url, source: p.source || '已解析' } : await resolveSource(p);
    const blob = await fetchAsBlob(s.url, p);
    const ext = /\.m3u8/i.test(s.url) ? 'ts' : 'mp4';
    const r = await saveBlob(blob, ext, 'origin');
    return Object.assign({}, r, { ok: !!r.ok, bytes: blob.size, url: s.url, source: s.source });
  }

  async function resolve(p) {
    const s = await resolveSource(p);
    return { ok: true, url: s.url, source: s.source, hd: s.hd };
  }

  // 后四项只供 Node 自检脚本调用（不进商店包），运行时仍只走 VideoEdit.exportClip
  const api = { exportClip, origin, resolve, makeWatermarkProcessor,
    rebuildVideoBox, normalizeWmBoxes, wmNoteFor, VIDEO_WM_DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.VideoEdit = api;
})();
