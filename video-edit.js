/*
 * video-edit.js — 1.6：离屏文档内的「视频剪接 + 逐帧去水印」引擎。
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
 * 最终得到一段拼好的片段。去水印：首帧做全图检测拿到条带框并缓存，
 * 后续帧只对缓存框做条带纹理重建（每 90 帧重检一次），避免逐帧全图扫描。
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
  const RECHECK_FRAMES = 90;        // 每 90 帧重新检测一次水印位置
  const MIN_SEGMENT = 0.2;

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

  function makeWatermarkProcessor(W, H, enabled) {
    const o = (typeof Inpaint !== 'undefined' && Inpaint.TILE_DEFAULTS)
      ? Object.assign({}, Inpaint.TILE_DEFAULTS) : null;
    let boxes = null;
    let regions = 0;
    let touched = 0;
    let scans = 0;
    return {
      apply(img, frameIdx) {
        if (!enabled || !o || typeof Inpaint.removeWatermarks !== 'function') return;
        const rescan = frameIdx % RECHECK_FRAMES === 0;
        if (rescan) {
          scans++;
          try {
            const r = Inpaint.removeWatermarks(img, { maxPixels: 8000000 });
            if (r && r.changed && r.regions && r.regions.length) {
              boxes = r.regions.map((x) => x.box).filter(Boolean);
              regions = boxes.length;
              touched++;
              return;                       // 检测帧已由 removeWatermarks 重建
            }
            if (r && !r.changed) boxes = null; // 水印可能消失，停止重建
          } catch (e) { /* 单帧检测失败不影响录制 */ }
        }
        if (!boxes || !boxes.length) return;
        const src = img.data.slice();
        for (const box of boxes) {
          try { Inpaint.rebuildBand(img.data, src, W, H, box, o); } catch (e) {}
        }
        touched++;
      },
      stats() { return { regions: regions, frames: touched, scans: scans }; }
    };
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

    const wm = makeWatermarkProcessor(W, H, !!p.wm);
    let frameIdx = 0;
    let elapsedDone = 0;
    const drawFrame = () => {
      try { ctx.drawImage(v, 0, 0, W, H); } catch (e) { return; }
      if (p.wm) {
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
        } catch (e) { /* 关键帧不精确时仍能继续播放 */ }
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
      wmEnabled: !!p.wm,
      wm: wm.stats(),
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

  const api = { exportClip, origin, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.VideoEdit = api;
})();
