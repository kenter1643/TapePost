/*
 * inpaint.js — 纯 JS 微博水印去除（不依赖 OpenCV / wasm）
 *
 * 为什么不用「把右下角整块矩形填掉」：
 *   实测微博水印只是底部一条白色文字 + logo（约 y>=0.95H、高 40px 左右），
 *   而旧做法填了 x>=0.72W, y>=0.86H 的整块区域（约 300x120），
 *   把卡纸、笔、背景纹理全抹成色块，破坏画面；且对无水印图也照抹不误。
 *
 * 新流程（自动检测 + 精确重建）：
 *   1. 只在底部条带里检测「白字」像素：亮度高，且比上方 16px 的局部背景明显更亮。
 *   2. 覆盖率保护：太少 => 判定无水印，原图完全不动；太多 => 判定复杂纹理/误判，同样跳过。
 *   3. 行列投影收紧出真正的水印包围盒，去掉零散误检（如卡纸高光）。
 *   4. 背景简单（低方差）=> 用盒子上下方背景做插值重建 + 边缘羽化，水印连同描边一起消失；
 *      背景复杂 => 退化为「膨胀后的像素级 mask + BFS 扩散填充」，保留纹理。
 *
 * 所有操作都在 ImageData 上原地修改，浏览器 / Node 均可运行。
 */
(function (global) {
  'use strict';

  // 旧版矩形模式参数（保留兼容，正常路径不再使用）
  const DEFAULT_REGION = { x0r: 0.72, y0r: 0.86 };

  // 新版检测/重建参数（在真实微博带水印图上调过）
  const DEFAULTS = {
    sxr: 0.55,      // 搜索带左边界
    syr: 0.90,      // 搜索带上边界（只找底部一条）
    refDy: 16,      // 局部背景参考：当前像素上方 16px
    lumMin: 205,    // 白字最低亮度
    deltaMin: 16,   // 相对局部背景的最小亮度提升
    pad: 5,         // 包围盒外扩，覆盖描边/阴影/抗锯齿
    minCov: 0.004,  // 疑似水印像素占比下限（低于此 = 无水印）
    maxCov: 0.15,   // 上限（高于此 = 复杂纹理，跳过以免毁图）
    maxBoxWR: 0.62, // 包围盒最大宽度占比
    maxBoxHR: 0.18, // 包围盒最大高度占比
    stdMax: 42,     // 盒内背景亮度标准差：低于此用重建，高于此用逐像素填充
    feather: 2,     // 重建区边缘羽化像素数
    dilate: 2       // 逐像素模式下 mask 膨胀半径
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lum(data, i) { return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }

  // 找「seed 最密集」的连续区间，允许 gap 像素的空隙，用于收紧包围盒
  function dominantRange(counts, gap) {
    const segs = [];
    let start = -1, last = -1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0) {
        if (start < 0) start = i;
        else if (i - last > gap) { segs.push([start, last]); start = i; }
        last = i;
      }
    }
    if (start >= 0) segs.push([start, last]);
    let best = null, bestSum = -1;
    for (const seg of segs) {
      let s = 0;
      for (let i = seg[0]; i <= seg[1]; i++) s += counts[i];
      if (s > bestSum) { bestSum = s; best = seg; }
    }
    return best;
  }

  // ---------- 1. 检测疑似水印像素 ----------
  function detectSeed(data, W, H, sx, sy, sw, sh, o) {
    const seed = new Uint8Array(sw * sh);
    const colCount = new Int32Array(sw);
    const rowCount = new Int32Array(sh);
    let count = 0;
    for (let y = 0; y < sh; y++) {
      const gy = sy + y;
      const ry = Math.max(0, gy - o.refDy);
      for (let x = 0; x < sw; x++) {
        const gx = sx + x;
        const L = lum(data, (gy * W + gx) * 4);
        const R = lum(data, (ry * W + gx) * 4);
        if (L > o.lumMin && (L - R) > o.deltaMin) {
          seed[y * sw + x] = 1;
          colCount[x]++; rowCount[y]++; count++;
        }
      }
    }
    return { seed, colCount, rowCount, count };
  }

  // ---------- 2. 背景简单度（盒内非水印像素亮度标准差） ----------
  function boxStd(data, W, H, box, o) {
    let n = 0, sum = 0, sum2 = 0;
    for (let y = box.by0; y <= box.by1; y += 2) {
      for (let x = box.bx0; x <= box.bx1; x += 2) {
        const gx = x, gy = y;
        const L = lum(data, (gy * W + gx) * 4);
        const R = lum(data, (Math.max(0, gy - o.refDy) * W + gx) * 4);
        if (L > o.lumMin && (L - R) > o.deltaMin) continue; // 跳过水印像素
        sum += L; sum2 += L * L; n++;
      }
    }
    if (n < 16) return 999;
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  }

  // ---------- 3a. 包围盒背景插值重建（简单背景，效果最干净） ----------
  function rebuildBox(data, W, H, box, o) {
    const { bx0, by0, bx1, by1 } = box;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    if (bw <= 0 || bh <= 0) return;

    // 保存盒内原像素，供边缘羽化混合
    const orig = new Uint8ClampedArray(bw * bh * 4);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const si = ((by0 + y) * W + (bx0 + x)) * 4;
        const di = (y * bw + x) * 4;
        orig[di] = data[si]; orig[di + 1] = data[si + 1];
        orig[di + 2] = data[si + 2]; orig[di + 3] = data[si + 3];
      }
    }

    const topY0 = Math.max(0, by0 - 6);
    const topY1 = Math.max(topY0 + 1, by0 - 2);
    const hasBottom = by1 + 3 < H;
    const canGrad = by0 >= 6;

    for (let x = bx0; x <= bx1; x++) {
      let tr = 0, tg = 0, tb = 0, tn = 0;
      for (let y = topY0; y < topY1; y++) {
        const i = (y * W + x) * 4;
        tr += data[i]; tg += data[i + 1]; tb += data[i + 2]; tn++;
      }
      tr /= tn; tg /= tn; tb /= tn;

      let gr = 0, gg = 0, gb = 0;
      if (canGrad) {
        const i1 = ((by0 - 2) * W + x) * 4;
        const i2 = ((by0 - 6) * W + x) * 4;
        gr = clamp((data[i1] - data[i2]) / 4, -3, 3);
        gg = clamp((data[i1 + 1] - data[i2 + 1]) / 4, -3, 3);
        gb = clamp((data[i1 + 2] - data[i2 + 2]) / 4, -3, 3);
      }

      let br = 0, bg = 0, bb = 0, bn = 0;
      if (hasBottom) {
        for (let y = by1 + 2; y <= Math.min(H - 1, by1 + 3); y++) {
          const i = (y * W + x) * 4;
          br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++;
        }
        br /= bn; bg /= bn; bb /= bn;
      }

      for (let y = by0; y <= by1; y++) {
        let r, g, b;
        if (hasBottom) {
          const a = (y - by0) / Math.max(1, by1 - by0);
          r = tr + (br - tr) * a; g = tg + (bg - tg) * a; b = tb + (bb - tb) * a;
        } else {
          const d = y - by0 + 2;
          r = clamp(tr + gr * d, 0, 255);
          g = clamp(tg + gg * d, 0, 255);
          b = clamp(tb + gb * d, 0, 255);
        }
        const idx = (y * W + x) * 4;
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
      }
    }

    // 边缘羽化：让重建区与原图自然衔接，避免矩形硬边
    const f = o.feather;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const d = Math.min(x, y, bw - 1 - x, bh - 1 - y);
        if (d >= f) continue;
        const a = (d + 1) / (f + 1);
        const di = (y * bw + x) * 4;
        const si = ((by0 + y) * W + (bx0 + x)) * 4;
        data[si] = data[si] * (1 - a) + orig[di] * a;
        data[si + 1] = data[si + 1] * (1 - a) + orig[di + 1] * a;
        data[si + 2] = data[si + 2] * (1 - a) + orig[di + 2] * a;
      }
    }
  }

  // ---------- 3b. 像素级 BFS 填充（复杂背景回退，只改 mask 像素） ----------
  function bfsFillMask(data, W, H, mask, box) {
    const orig = data.slice();
    const { bx0, by0, bx1, by1 } = box;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const inMask = (x, y) => {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) return false;
      return mask[(y - by0) * bw + (x - bx0)] === 1;
    };
    const dist = new Int32Array(W * H).fill(-1);
    const finalized = new Uint8Array(W * H);
    const queue = [];
    const nb = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        if (!inMask(x, y)) continue;
        for (const [dx, dy] of nb) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (!inMask(nx, ny)) { dist[y * W + x] = 0; queue.push(y * W + x); break; }
        }
      }
    }
    let head = 0;
    while (head < queue.length) {
      const p = queue[head++];
      const x = p % W, y = (p / W) | 0, idx = p * 4;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of nb) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = (ny * W + nx) * 4;
        if (!inMask(nx, ny)) { r += orig[ni]; g += orig[ni + 1]; b += orig[ni + 2]; n++; }
        else if (finalized[ny * W + nx]) { r += data[ni]; g += data[ni + 1]; b += data[ni + 2]; n++; }
      }
      if (n > 0) { data[idx] = r / n; data[idx + 1] = g / n; data[idx + 2] = b / n; }
      finalized[p] = 1;
      for (const [dx, dy] of nb) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (inMask(nx, ny) && dist[ny * W + nx] < 0) {
          dist[ny * W + nx] = dist[p] + 1;
          queue.push(ny * W + nx);
        }
      }
    }
  }

  function dilateMask(src, bw, bh, r) {
    let cur = src;
    for (let k = 0; k < r; k++) {
      const out = new Uint8Array(cur.length);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          let hit = 0;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
              if (cur[ny * bw + nx]) { hit = 1; break; }
            }
          }
          out[y * bw + x] = hit;
        }
      }
      cur = out;
    }
    return cur;
  }

  // ---------- 主入口 ----------
  /**
   * 自动检测并去除微博水印；检测不到或风险过高时原图完全不动。
   * @param {ImageData} imgData 原地修改
   * @param {object} opts 可覆盖 DEFAULTS
   * @returns {{changed:boolean, reason:string, method?:string, pixels?:number, coverage?:number, box?:object}}
   */
  function removeWatermark(imgData, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const W = imgData.width, H = imgData.height, data = imgData.data;
    const sx = Math.max(0, Math.floor(W * o.sxr));
    const sy = Math.max(0, Math.floor(H * o.syr));
    const sw = W - sx, sh = H - sy;
    if (sw < 12 || sh < 6) return { changed: false, reason: '图片过小，跳过' };

    const det = detectSeed(data, W, H, sx, sy, sw, sh, o);
    const cov = det.count / (sw * sh);
    if (det.count === 0 || cov < o.minCov) {
      return { changed: false, reason: '未检测到水印', coverage: cov };
    }
    if (cov > o.maxCov) {
      return { changed: false, reason: '疑似复杂纹理，跳过以免破坏画面', coverage: cov };
    }

    const colSeg = dominantRange(det.colCount, Math.max(2, Math.round(sw * 0.02)));
    const rowSeg = dominantRange(det.rowCount, 2);
    if (!colSeg || !rowSeg) return { changed: false, reason: '水印分布不连续', coverage: cov };

    const pad = o.pad;
    const box = {
      bx0: clamp(sx + colSeg[0] - pad, 0, W - 1),
      bx1: clamp(sx + colSeg[1] + pad, 0, W - 1),
      by0: clamp(sy + rowSeg[0] - pad, 0, H - 1),
      by1: clamp(sy + rowSeg[1] + pad, 0, H - 1)
    };
    const bw = box.bx1 - box.bx0 + 1, bh = box.by1 - box.by0 + 1;
    if (bw < 8 || bh < 4) return { changed: false, reason: '水印区域过小', coverage: cov };
    if (bw > W * o.maxBoxWR || bh > H * o.maxBoxHR) {
      return { changed: false, reason: '水印区域异常过大，跳过', coverage: cov };
    }

    const std = boxStd(data, W, H, box, o);
    let method;
    if (std <= o.stdMax) {
      rebuildBox(data, W, H, box, o);
      method = 'rebuild';
    } else {
      const mask = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const lx = box.bx0 + x - sx, ly = box.by0 + y - sy;
          if (lx >= 0 && lx < sw && ly >= 0 && ly < sh) mask[y * bw + x] = det.seed[ly * sw + lx];
        }
      }
      const grown = dilateMask(mask, bw, bh, o.dilate);
      let hit = 0;
      for (let i = 0; i < grown.length; i++) hit += grown[i];
      if (hit / grown.length > 0.25) {
        return { changed: false, reason: '纹理过密，跳过以免破坏画面', coverage: cov };
      }
      bfsFillMask(data, W, H, grown, box);
      method = 'bfs';
    }
    return { changed: true, reason: '', method, pixels: det.count, coverage: cov, std, box };
  }

  // ---------- 旧版矩形模式（兼容保留，正常路径不再调用） ----------
  function inpaintCorner(imgData, opts) {
    opts = opts || {};
    const W = imgData.width, H = imgData.height;
    const x0 = Math.max(0, Math.floor(W * (opts.x0r != null ? opts.x0r : DEFAULT_REGION.x0r)));
    const y0 = Math.max(0, Math.floor(H * (opts.y0r != null ? opts.y0r : DEFAULT_REGION.y0r)));
    if (x0 >= W || y0 >= H) return;
    const box = { bx0: x0, by0: y0, bx1: W - 1, by1: H - 1 };
    const mask = new Uint8Array((W - x0) * (H - y0)).fill(1);
    bfsFillMask(imgData.data, W, H, mask, box);
  }

  const api = { removeWatermark, inpaintCorner, DEFAULTS, DEFAULT_REGION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Inpaint = api;
})(typeof self !== 'undefined' ? self : this);
