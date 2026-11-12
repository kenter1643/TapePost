/*
 * inpaint.js — 纯 JS 图片水印去除（不依赖 OpenCV / wasm）
 *
 * 1.5.1 检测链路（按真机反馈重写）：局部对比（top-hat）亮笔画 + 宽松亮笔画
 *   → 全图「贴边」重叠瓦片扫描 → 自适应行阈值找水平水印条带 → 结构校验排除
 *   白色分隔条 / 天花板灯 / 白衣服高光 / 数字标号 → 条带纹理重建（低频按列插值 +
 *   上下真实高频纹理补偿 + 边缘羽化）。
 *
 *   1.4.28 漏掉右下角水印的三个原因（真图 1200x1466 实测）：
 *     1) 瓦片从 0 开始按固定步长滑动，最后一块不贴边：右侧缺 80~96px、底部缺
 *        46~71px；而微博水印恰好压在距右/下边缘 10~15px 处，整块落在扫描盲区。
 *     2) 只用严格 strong 种子做行列投影：白色细线字压在白衣服上时局部对比不足，
 *        水印所在的行根本达不到行阈值；反而把上下帧之间的纯白分隔条当成了水印。
 *     3) 条带没有结构校验，误检后把听诊器附近 1915 像素整块抹掉。
 *   现在瓦片补最后一块贴边、行列投影改用宽松种子、行阈值按瓦片中位数自适应，
 *   并用「列投影跳变数 + 梯度密度 + 强种子密度 + 最亮行占比 + 垂直连续段」联合
 *   确认，两张真图（1200x1466 右下角双水印 / 648x1920 中间双水印）都只命中真水印。
 *
 * 1.4.28 检测链路（保留说明）：局部对比（top-hat）亮笔画 → 全图重叠瓦片扫描 →
 *   水平水印条带 → 条带内放宽掩膜 → 局部真实纹理加权填充。
 *   覆盖拼接长图里任意位置的水印（右下角、中间、顶部、多帧重复水印）。
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

  // ---------- 1.4.28：局部对比 + 全图瓦片扫描，任意位置水印 ----------
  /*
   * 1.4.27 的「整块大区域做行列投影」有致命缺陷：区域里只要有一片更亮的
   * 天花板灯 / 白墙 / 反光，投影就会把那片大亮块当成水印，包围盒被撑爆后整块跳过；
   * 真正的小水印（例如拼接长图中间的「微博眼睛 + @用户名」）反而漏掉。
   *
   * 1.4.28 改为两步：
   *   1. 用积分图算每个像素的局部均值背景，只保留「比周围明显亮的低饱和细笔画」
   *      （top-hat）。大片均匀亮区的 L≈背景，会被自然抵消，不会被误判成水印。
   *   2. 把整图划成两档重叠瓦片（256x160 / 384x240），每块只找「水平细条带」：
   *      宽高比 ≥2.5、笔画稀疏但成串、列投影多次跳变。灯、白墙、噪点都不满足。
   *      瓦片覆盖全图，因此拼接长图里任意 y 位置、重复出现的水印都能各自框出。
   *   3. 条带确认后，在条带内放宽阈值重建掩膜，把半透明抗锯齿边缘一起纳入；
   *      再对每个掩膜像素，用周围真实背景像素的距离加权平均 + 轻微颗粒重建，
   *      只改掩膜像素，不整块矩形覆盖，避免拉丝 / 斑块 / 糊块。
   */
  const TILE_DEFAULTS = {
    radiusMin: 5, radiusMax: 14,   // 局部背景半径 = clamp(min(W,H)/90, ...)
    lumStrong: 175, deltaStrong: 18, satStrong: 40,   // 亮笔画（强种子）
    lumBand: 140, deltaBand: 6, satBand: 70,          // 条带内放宽：覆盖半透明边缘
    bandDilate: 1,
    tileW: 256, tileH: 160, stepX: 96, stepY: 70,     // 第一档瓦片
    tileW2: 384, tileH2: 240, stepX2: 144, stepY2: 105, // 第二档瓦片
    rowThrRatio: 0.022, rowGap: 3, rowMin: 5, rowMax: 50,
    colGap: 8, colMin: 35, colMax: 340, colThrRatio: 0.18,
    densMin: 0.03, densMax: 0.45, jumpsMin: 4, ratioMin: 2.5,
    mergeY: 14, mergeX: 36,
    expandGap: 14, expandLimit: 90, bandPadY: 4, boxPad: 6,
    maxBoxes: 4,
    fillRadius: 6, grain: 0.8,
    maxPixels: 20000000,

    // ---- 1.5.1：贴边扫描 + 宽松种子 + 结构校验 ----
    rowAdapt: 1.25,      // 行阈值 = 瓦片内行投影中位数 × 该系数（白衣服上也能框出水印）
    rowThrAbs: 8,        // 行阈值绝对下限
    rowGapScan: 5,       // 允许笔画行中间有 5px 低值空隙
    densScanMin: 0.05, densScanMax: 0.55, jumpsScanMin: 4, ratioScanMin: 2.5,
    // 结构确认：真水印列投影跳变多、梯度密、强种子够、不是实心白条也不是大片灯
    jumpsConfirm: 12, gradMin: 0.15, strongMin: 0.08, widthMin: 90,
    maxRowDens: 0.75, vRunMax: 6, brightMax: 0.75,
    expandGapScan: 3, expandLimitScan: 16,   // 收紧左右扩展，避免把背景吞进来稀释特征
    // ---- 1.5.1：条带纹理重建（低频按列插值 + 上下高频补偿 + 羽化）----
    rebuildPad: 8,       // 检测框外扩，覆盖描边/阴影
    rebuildMargin: 12,   // 参考行离条带的距离（避开水印光晕）
    rebuildGap: 8,       // 高频纹理取自条带上/下方 shift = 条带高 + gap
    rebuildFade: 8,      // 重建区边缘羽化像素
    // 高频增益按两张真图折中取 0.3：取太高会在房间 / 家具这类复杂背景上
    // 叠出网格状斜纹，取太低则整条带被抹成模糊块。
    lowRadius: 4, highRadius: 1, highGain: 0.3,
    minStrokeCov: 0.06   // 条带内亮笔画占比下限，过低说明是误检，不动原图
  };

  /** 预计算亮度 / 饱和度 / 局部均值背景（积分图）/ 强种子笔画 */
  function buildStrokeMask(data, W, H, o) {
    const N = W * H;
    const lum = new Float32Array(N), satv = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      lum[p] = 0.299 * r + 0.587 * g + 0.114 * b;
      satv[p] = Math.max(r, g, b) - Math.min(r, g, b);
    }
    const rad = clamp(Math.round(Math.min(W, H) / 90), o.radiusMin, o.radiusMax);
    const SW = W + 1, integ = new Float64Array(SW * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) {
        row += lum[y * W + x];
        integ[(y + 1) * SW + x + 1] = integ[y * SW + x + 1] + row;
      }
    }
    const bgAt = (x, y) => {
      const x0 = Math.max(0, x - rad), x1 = Math.min(W - 1, x + rad);
      const y0 = Math.max(0, y - rad), y1 = Math.min(H - 1, y + rad);
      const v = integ[(y1 + 1) * SW + x1 + 1] - integ[y0 * SW + x1 + 1] -
        integ[(y1 + 1) * SW + x0] + integ[y0 * SW + x0];
      return v / ((x1 - x0 + 1) * (y1 - y0 + 1));
    };
    // 1.5.1：同一次局部背景计算里产出两档种子。
    // strong 用于确认「确实是亮笔画」，soft 用于行列投影定位——白色细线字压在
    // 白衣服上时 delta 只有 6~15，用 strong 会整行漏掉。
    const strong = new Uint8Array(N), soft = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x, d = lum[p] - bgAt(x, y);
        if (satv[p] < o.satStrong && lum[p] > o.lumStrong && d > o.deltaStrong) strong[p] = 1;
        if (satv[p] < o.satBand && lum[p] > o.lumBand && d > o.deltaBand) soft[p] = 1;
      }
    }
    return { lum, satv, bgAt, strong, soft };
  }

  /** 找「连续密集」区间，允许 gap 空隙（字符间隙），限制最小/最大长度 */
  function denseSegments(counts, thr, gap, minLen, maxLen) {
    const out = [];
    let start = -1, last = -1;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= thr) {
        if (start < 0) start = i;
        else if (i - last > gap) {
          if (last - start + 1 >= minLen && last - start + 1 <= maxLen) out.push([start, last]);
          start = i;
        }
        last = i;
      }
    }
    if (start >= 0 && last - start + 1 >= minLen && last - start + 1 <= maxLen) out.push([start, last]);
    return out;
  }

  /** 1.5.1：瓦片起点强制贴边。旧版最后一档瓦片停在 limit 之前，右侧/底部
   *  留出 46~96px 盲区，而微博水印恰好压在距边缘 10~15px 处 —— 这是右下角
   *  水印整块漏检的主因。 */
  function tilePositions(limit, step) {
    const a = [];
    if (limit <= 0) return [0];
    for (let v = 0; v < limit; v += step) a.push(v);
    if (a[a.length - 1] !== limit) a.push(limit);
    return a;
  }

  /** 1.5.1：条带结构特征，用于把「实心白分隔条 / 天花板灯 / 白衣服高光 /
   *  数字标号」与真水印区分开。真水印是细笔画文字：梯度密、列投影跳变多、
   *  垂直连续段短、不会出现整行全亮。 */
  function bandStructure(ctx, soft, W, box) {
    const { x0, y0, x1, y1 } = box;
    let strong = 0, softN = 0, n = 0, bright = 0, maxRow = 0, grad = 0;
    const vRuns = [];
    for (let x = x0; x <= x1; x++) {
      let run = 0;
      for (let y = y0; y <= y1; y++) {
        const p = y * W + x;
        if (soft[p]) { run++; softN++; } else { if (run) vRuns.push(run); run = 0; }
        strong += ctx.strong[p]; n++;
        if (ctx.lum[p] > 210) bright++;
        if (x > x0 && x < x1 && y > y0 && y < y1) {
          const g = Math.abs(ctx.lum[p - 1] - ctx.lum[p + 1]) +
            Math.abs(ctx.lum[p - W] - ctx.lum[p + W]);
          if (g > 40) grad++;
        }
      }
      if (run) vRuns.push(run);
    }
    for (let y = y0; y <= y1; y++) {
      let c = 0;
      for (let x = x0; x <= x1; x++) c += soft[y * W + x];
      maxRow = Math.max(maxRow, c / (x1 - x0 + 1));
    }
    vRuns.sort((a, b) => a - b);
    return {
      strong: strong / n, soft: softN / n,
      vRun: vRuns.length ? vRuns[vRuns.length >> 1] : 99,
      maxRow: maxRow, grad: grad / n, bright: bright / n
    };
  }

  /** 1.5.1：全图贴边瓦片扫描 → 水平水印条带 → 结构确认 */
  function findWatermarkBands(soft, W, H, o, ctx) {
    const cands = [];
    const tiles = [
      [o.tileW, o.tileH, o.stepX, o.stepY],
      [o.tileW2, o.tileH2, o.stepX2, o.stepY2]
    ];
    for (const t of tiles) {
      const TW = Math.min(t[0], W), TH = Math.min(t[1], H);
      const SX = Math.max(1, Math.round(t[2] * TW / t[0]));
      const SY = Math.max(1, Math.round(t[3] * TH / t[1]));
      if (TW < 40 || TH < 24) continue;
      const txs = tilePositions(W - TW, SX), tys = tilePositions(H - TH, SY);
      for (const ty of tys) {
        for (const tx of txs) {
          const row = new Int32Array(TH);
          for (let y = 0; y < TH; y++) {
            let c = 0; const base = (ty + y) * W;
            for (let x = 0; x < TW; x++) c += soft[base + tx + x];
            row[y] = c;
          }
          // 自适应行阈值：白衣服 / 白墙区域整体偏亮，固定阈值会把整段连续行
          // 撑爆后丢弃；按瓦片中位数取相对峰值才能把水印那十几行切出来。
          const sorted = row.slice().sort((a, b) => a - b);
          const thr = Math.max(o.rowThrAbs, sorted[sorted.length >> 1] * o.rowAdapt);
          const rows = denseSegments(row, thr, o.rowGapScan, o.rowMin, o.rowMax);
          for (const seg of rows) {
            const ry0 = seg[0], ry1 = seg[1], rh = ry1 - ry0 + 1;
            const col = new Int32Array(TW);
            for (let x = 0; x < TW; x++) {
              let c = 0;
              for (let y = ry0; y <= ry1; y++) c += soft[(ty + y) * W + tx + x];
              col[x] = c;
            }
            const cols = denseSegments(col, Math.max(1, Math.round(rh * o.colThrRatio)),
              o.colGap, o.colMin, o.colMax);
            for (const cs of cols) {
              const cx0 = cs[0], cx1 = cs[1], bw = cx1 - cx0 + 1;
              let hits = 0;
              for (let y = ry0; y <= ry1; y++) {
                const base = (ty + y) * W;
                for (let x = cx0; x <= cx1; x++) hits += soft[base + tx + x];
              }
              const dens = hits / (bw * rh);
              let jumps = 0;
              for (let x = cx0 + 1; x <= cx1; x++) if ((col[x - 1] > 0) !== (col[x] > 0)) jumps++;
              if (dens < o.densScanMin || dens > o.densScanMax || jumps < o.jumpsScanMin ||
                bw / rh < o.ratioScanMin) continue;
              cands.push({ x0: tx + cx0, y0: ty + ry0, x1: tx + cx1, y1: ty + ry1,
                score: dens * 100 + jumps * 0.4 + Math.min(bw / rh, 12) * 0.5, jumps: jumps });
            }
          }
        }
      }
    }
    if (!cands.length) return [];
    // 同一水平行的相邻片段合并（字符间隙 / 瓦片边界会把一串文字切开）
    cands.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const merged = [];
    for (const c of cands) {
      let hit = null;
      for (const m of merged) {
        const cy = (c.y0 + c.y1) / 2, my = (m.y0 + m.y1) / 2;
        if (Math.abs(cy - my) < o.mergeY && c.x0 - m.x1 < o.mergeX && m.x0 - c.x1 < o.mergeX) {
          hit = m; break;
        }
      }
      if (hit) {
        hit.x0 = Math.min(hit.x0, c.x0); hit.x1 = Math.max(hit.x1, c.x1);
        hit.y0 = Math.min(hit.y0, c.y0); hit.y1 = Math.max(hit.y1, c.y1);
        hit.score = Math.max(hit.score, c.score);
      } else merged.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
        score: c.score, jumps: c.jumps });
    }
    // 行内左右扩展：只把 logo / 前后字符吞进来。1.4.28 允许扩 90px，
    // 在白衣服 / 墙面上会一路扩到瓦片边缘，把背景一起算进特征导致真水印被误杀。
    const colHas = (x, y0, y1) => {
      for (let y = y0; y <= y1; y++) if (soft[y * W + x]) return true;
      return false;
    };
    for (const m of merged) {
      const ey0 = Math.max(0, m.y0 - o.bandPadY), ey1 = Math.min(H - 1, m.y1 + o.bandPadY);
      let x = m.x0 - 1, gap = 0, left = m.x0;
      while (x >= 0 && m.x0 - x <= o.expandLimitScan) {
        if (colHas(x, ey0, ey1)) { left = x; gap = 0; }
        else if (++gap > o.expandGapScan) break;
        x--;
      }
      x = m.x1 + 1; gap = 0;
      let right = m.x1;
      while (x < W && x - m.x1 <= o.expandLimitScan) {
        if (colHas(x, ey0, ey1)) { right = x; gap = 0; }
        else if (++gap > o.expandGapScan) break;
        x++;
      }
      m.x0 = left; m.x1 = right; m.y0 = ey0; m.y1 = ey1;
    }
    // 结构确认：文字串的列投影跳变远多于白条 / 灯 / 衣服高光；
    // 再用梯度密度、强种子密度、最亮行占比、垂直连续段排除剩余误检。
    const scored = [];
    for (const m of merged) {
      let jumps = 0, prev = 0;
      for (let x = m.x0; x <= m.x1; x++) {
        let c = 0;
        for (let y = m.y0; y <= m.y1; y++) c += soft[y * W + x];
        if ((prev > 0) !== (c > 0)) jumps++;
        prev = c;
      }
      m.jumps = jumps;
      if (jumps < o.jumpsConfirm || m.x1 - m.x0 + 1 < o.widthMin) continue;
      if (ctx) {
        const s = bandStructure(ctx, soft, W, m);
        if (s.grad < o.gradMin || s.strong < o.strongMin ||
          s.maxRow > o.maxRowDens || s.vRun > o.vRunMax || s.bright > o.brightMax) continue;
        m.structure = s;
      }
      scored.push(m);
    }
    scored.sort((a, b) => b.jumps - a.jumps);
    const kept = [];
    for (const m of scored) {
      let dup = false;
      for (const k of kept) {
        const iw = Math.min(m.x1, k.x1) - Math.max(m.x0, k.x0);
        const ih = Math.min(m.y1, k.y1) - Math.max(m.y0, k.y0);
        if (iw > 0 && ih > 0 && (iw * ih) / Math.min(
          (m.x1 - m.x0 + 1) * (m.y1 - m.y0 + 1),
          (k.x1 - k.x0 + 1) * (k.y1 - k.y0 + 1)) > 0.4) { dup = true; break; }
      }
      if (!dup) kept.push(m);
      if (kept.length >= o.maxBoxes) break;
    }
    return kept;
  }

  function positionName(cx, cy, W, H) {
    const hx = cx / W, hy = cy / H;
    const v = hy < 0.33 ? '上' : (hy > 0.66 ? '下' : '中');
    const h = hx < 0.33 ? '左' : (hx > 0.66 ? '右' : '中');
    return (v === '中' && h === '中') ? '中间' : (h + v);
  }

  /** 1.5.1：某一行的盒式均值（垂直 2r+1 行累加 + 水平滑动窗口），O(r*W)。
   *  只对真正用到的行计算并缓存，避免对 4K 整图做卷积。 */
  function boxMeanRow(src, W, H, y, r) {
    const acc = [new Float32Array(W), new Float32Array(W), new Float32Array(W)];
    const out = [new Float32Array(W), new Float32Array(W), new Float32Array(W)];
    const n = 2 * r + 1;
    for (let dy = -r; dy <= r; dy++) {
      const yy = clamp(y + dy, 0, H - 1), base = yy * W;
      for (let x = 0; x < W; x++) {
        const i = (base + x) * 4;
        acc[0][x] += src[i]; acc[1][x] += src[i + 1]; acc[2][x] += src[i + 2];
      }
    }
    for (let c = 0; c < 3; c++) {
      const a = acc[c];
      let sum = 0;
      for (let x = 0; x <= Math.min(W - 1, r); x++) sum += a[x];
      for (let x = 0; x < W; x++) {
        const lo = Math.max(0, x - r), hi = Math.min(W - 1, x + r);
        out[c][x] = sum / ((hi - lo + 1) * n);
        if (x - r >= 0) sum -= a[x - r];
        if (x + r + 1 <= W - 1) sum += a[x + r + 1];
      }
    }
    return out;
  }

  /** 1.5.1：条带纹理重建。
   *  纯「按列插值」会拉丝，「整块平移克隆」会重影，「中值滤波」会把白衣服
   *  扩散成白块。这里拆成两层：低频取条带上下两条参考行的大半径均值按列插值
   *  （水印光晕外，避开字母轮廓），高频取条带上下方真实像素相对 3x3 均值的
   *  残差（保留皮肤 / 布料纹理），最后边缘羽化与原图衔接。
   *  返回改动像素数；src 始终是原图快照，多个条带之间不互相污染。 */
  function rebuildBand(data, src, W, H, box, o) {
    const { bx0, by0, bx1, by1 } = box;
    const bh = by1 - by0 + 1, shift = bh + o.rebuildGap;
    const y0r = Math.max(0, by0 - o.rebuildMargin);
    const y1r = Math.min(H - 1, by1 + o.rebuildMargin);
    if (y1r <= y0r) return 0;
    const cache = new Map();
    const rowMean = (y, r) => {
      const k = y + ':' + r;
      let v = cache.get(k);
      if (!v) { v = boxMeanRow(src, W, H, y, r); cache.set(k, v); }
      return v;
    };
    const L0 = rowMean(y0r, o.lowRadius), L1 = rowMean(y1r, o.lowRadius);
    let changed = 0;
    for (let y = by0; y <= by1; y++) {
      const yu = clamp(y - shift, 0, H - 1), yd = clamp(y + shift, 0, H - 1);
      const C0 = rowMean(yu, o.highRadius), C1 = rowMean(yd, o.highRadius);
      const a = (y - y0r) / (y1r - y0r);
      for (let x = bx0; x <= bx1; x++) {
        const gi = (y * W + x) * 4;
        const iu = (yu * W + x) * 4, id = (yd * W + x) * 4;
        const edge = Math.min(y - by0, by1 - y, x - bx0, bx1 - x);
        let alpha = 1;
        if (edge < o.rebuildFade) alpha = (edge + 1) / (o.rebuildFade + 1);
        if (alpha <= 0) continue;
        for (let c = 0; c < 3; c++) {
          const low = L0[c][x] * (1 - a) + L1[c][x] * a;
          const high = o.highGain * 0.5 *
            ((src[iu + c] - C0[c][x]) + (src[id + c] - C1[c][x]));
          data[gi + c] = src[gi + c] * (1 - alpha) + (low + high) * alpha;
        }
        changed++;
      }
    }
    return changed;
  }

  /**
   * 局部真实纹理加权填充：每个掩膜像素只由它周围非掩膜的真实背景像素决定，
   * 按距离加权（并略偏水平），加一点确定性颗粒，避免按列插值的拉丝、
   * 也避免从边界向内扩散带来的斑块。
   */
  function localTextureFill(data, W, H, mask, box, o) {
    const src = data.slice();
    const { bx0, by0, bx1, by1 } = box, bw = bx1 - bx0 + 1, R = o.fillRadius;
    const inM = (x, y) => {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) return false;
      return mask[(y - by0) * bw + (x - bx0)] === 1;
    };
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        if (!inM(x, y)) continue;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || inM(nx, ny)) continue;
            const d2 = dx * dx + dy * dy;
            if (d2 > R * R || d2 === 0) continue;
            const w = (1 / (d2 + 1)) * (1 + 0.6 * Math.exp(-Math.abs(dy) / 2));
            const ni = (ny * W + nx) * 4;
            r += src[ni] * w; g += src[ni + 1] * w; b += src[ni + 2] * w; wsum += w;
          }
        }
        if (wsum === 0) continue;
        const idx = (y * W + x) * 4;
        const j = ((((x * 73856093) ^ (y * 19349663)) % 7) - 3) * o.grain;
        data[idx] = r / wsum + j;
        data[idx + 1] = g / wsum + j;
        data[idx + 2] = b / wsum + j;
      }
    }
  }

  // ---------- 1.4.27：全图逐区域去水印（右下角 / 左下角 / 顶部 / 中间） ----------
  /*
   * 旧版只找「底部一条白字」，其它站、中间 logo、角落半透明水印一律放过。
   * 这一版的原则是「宁可少抹一点，也不能留下处理痕迹」：
   *   1. 整图划成 5 个候选区域，逐区域独立检测，任何区域没把握就跳过；
   *   2. 检测基于原始像素快照，前一个区域修完不会引发连锁误检；
   *   3. 只替换「疑似水印像素 + 1~2px 抗锯齿描边」，非水印像素一字节不动，
   *      绝不再整块矩形覆盖（那正是旧版毁图的原因）；
   *   4. 被替换的像素按同列上下背景做插值 + 端点羽化，保留原有明暗渐变。
   */
  const REGIONS = [
    { name: '右下角', x0: 0.45, y0: 0.78, x1: 1.00, y1: 1.00, minCov: 0.0025 },
    { name: '左下角', x0: 0.00, y0: 0.78, x1: 0.55, y1: 1.00, minCov: 0.0025 },
    { name: '右上角', x0: 0.45, y0: 0.00, x1: 1.00, y1: 0.22, minCov: 0.0030 },
    { name: '左上角', x0: 0.00, y0: 0.00, x1: 0.55, y1: 0.22, minCov: 0.0030 },
    // 中间区域面积大，覆盖率阈值要按面积调低；同时把包围盒限制收紧，
    // 避免把画面里正常的白色文字 / 高光当成水印。
    { name: '中间',   x0: 0.20, y0: 0.20, x1: 0.80, y1: 0.80,
      minCov: 0.0015, maxBoxWR: 0.35, maxBoxHR: 0.12 }
  ];

  const FULL_DEFAULTS = Object.assign({}, DEFAULTS, {
    lumMin: 188,        // 半透明白水印比纯白字暗，阈值比底部专用版低
    deltaMin: 14,       // 相对局部背景的亮度提升
    satMax: 58,         // 水印多为白 / 灰，排除彩色高光误检
    refDy: 12,
    pad: 3,
    dilate: 1,         // 只向外扩 1px 覆盖抗锯齿，扩太多会把文字连成实心块
    maxCov: 0.12,       // 整片亮像素 = 复杂纹理，跳过
    maxBoxWR: 0.62,
    maxBoxHR: 0.20
  });

  // 在指定矩形里找「偏白、低饱和、明显比上方背景亮」的像素
  function detectInRect(orig, W, H, rect, o) {
    const rx0 = Math.max(0, Math.floor(W * rect.x0));
    const rx1 = Math.min(W - 1, Math.ceil(W * rect.x1));
    const ry0 = Math.max(0, Math.floor(H * rect.y0));
    const ry1 = Math.min(H - 1, Math.ceil(H * rect.y1));
    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
    if (rw < 12 || rh < 6) return null;
    const seed = new Uint8Array(rw * rh);
    const colCount = new Int32Array(rw);
    const rowCount = new Int32Array(rh);
    let count = 0;
    for (let y = ry0; y <= ry1; y++) {
      const ry1ref = Math.max(ry0, y - o.refDy);
      const ry2ref = Math.max(ry0, y - o.refDy * 2);
      for (let x = rx0; x <= rx1; x++) {
        const i = (y * W + x) * 4;
        const r = orig[i], g = orig[i + 1], b = orig[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn > o.satMax) continue;            // 彩色物体不是水印
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        // 背景参考取上方两个采样点里更暗的那个：只取 12px 上方时，
        // 周期性笔画（文字 / logo）会正好落在另一笔上，导致整片漏检。
        const ri1 = (ry1ref * W + x) * 4, ri2 = (ry2ref * W + x) * 4;
        const R1 = 0.299 * orig[ri1] + 0.587 * orig[ri1 + 1] + 0.114 * orig[ri1 + 2];
        const R2 = 0.299 * orig[ri2] + 0.587 * orig[ri2 + 1] + 0.114 * orig[ri2 + 2];
        const R = Math.min(R1, R2);
        if (L > o.lumMin && (L - R) > o.deltaMin) {
          const li = (y - ry0) * rw + (x - rx0);
          seed[li] = 1; colCount[x - rx0]++; rowCount[y - ry0]++; count++;
        }
      }
    }
    return { seed, colCount, rowCount, count, rx0, ry0, rw, rh, cov: count / (rw * rh) };
  }

  // 只改 mask 像素：按同列上下最近的非水印像素插值，端点羽化，不动其它像素
  function fillMaskByColumn(data, W, H, mask, box) {
    const { bx0, by0, bx1, by1 } = box;
    const bw = bx1 - bx0 + 1;
    const at = (x, y) => mask[(y - by0) * bw + (x - bx0)] === 1;
    for (let x = bx0; x <= bx1; x++) {
      let y = by0;
      while (y <= by1) {
        if (!at(x, y)) { y++; continue; }
        const y0 = y;
        while (y <= by1 && at(x, y)) y++;
        const y1 = y - 1;
        let ty = y0 - 1;
        while (ty >= 0 && ty >= by0 - 2 && at(x, ty)) ty--;
        let by = y1 + 1;
        while (by < H && by <= by1 + 2 && at(x, by)) by++;
        const hasT = ty >= 0 && ty < H;
        const hasB = by < H;
        if (!hasT && !hasB) continue;
        const ti = (ty * W + x) * 4;
        const bi = (by * W + x) * 4;
        for (let yy = y0; yy <= y1; yy++) {
          const idx = (yy * W + x) * 4;
          let r, g, b;
          if (hasT && hasB) {
            const a = (yy - y0 + 1) / (y1 - y0 + 2);
            r = data[ti] * (1 - a) + data[bi] * a;
            g = data[ti + 1] * (1 - a) + data[bi + 1] * a;
            b = data[ti + 2] * (1 - a) + data[bi + 2] * a;
          } else {
            const si = hasT ? ti : bi;
            r = data[si]; g = data[si + 1]; b = data[si + 2];
          }
          // 端点 1px 羽化：让填充与未改动像素之间没有硬边
          const edge = (yy === y0 || yy === y1) ? 0.35 : 0;
          if (edge) {
            r = r * (1 - edge) + data[idx] * edge;
            g = g * (1 - edge) + data[idx + 1] * edge;
            b = b * (1 - edge) + data[idx + 2] * edge;
          }
          data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
        }
      }
    }
  }

  function boxesOverlap(a, b) {
    const iw = Math.min(a.bx1, b.bx1) - Math.max(a.bx0, b.bx0) + 1;
    const ih = Math.min(a.by1, b.by1) - Math.max(a.by0, b.by0) + 1;
    if (iw <= 0 || ih <= 0) return false;
    const area = (a.bx1 - a.bx0 + 1) * (a.by1 - a.by0 + 1);
    return (iw * ih) / area > 0.4;
  }

  function scanRegion(orig, data, W, H, rect, o, done) {
    const det = detectInRect(orig, W, H, rect, o);
    if (!det) return { changed: false, reason: '区域过小' };
    if (det.count === 0 || det.cov < rect.minCov) return { changed: false, reason: '未检测到水印' };
    if (det.cov > o.maxCov) return { changed: false, reason: '疑似复杂纹理，跳过以免破坏画面' };

    const colSeg = dominantRange(det.colCount, Math.max(3, Math.round(det.rw * 0.02)));
    const rowSeg = dominantRange(det.rowCount, Math.max(3, Math.round(det.rh * 0.02)));
    if (!colSeg || !rowSeg) return { changed: false, reason: '分布不连续' };

    const box = {
      bx0: clamp(det.rx0 + colSeg[0] - o.pad, 0, W - 1),
      bx1: clamp(det.rx0 + colSeg[1] + o.pad, 0, W - 1),
      by0: clamp(det.ry0 + rowSeg[0] - o.pad, 0, H - 1),
      by1: clamp(det.ry0 + rowSeg[1] + o.pad, 0, H - 1)
    };
    const bw = box.bx1 - box.bx0 + 1, bh = box.by1 - box.by0 + 1;
    if (bw < 8 || bh < 3) return { changed: false, reason: '区域过小' };
    const maxWR = rect.maxBoxWR || o.maxBoxWR;
    const maxHR = rect.maxBoxHR || o.maxBoxHR;
    if (bw > W * maxWR || bh > H * maxHR) {
      return { changed: false, reason: '包围盒异常过大，跳过' };
    }
    for (const d of done) {
      if (boxesOverlap(box, d)) return { changed: false, reason: '与已处理区域重叠' };
    }

    const mask = new Uint8Array(bw * bh);
    let rawHits = 0;
    for (let y = box.by0; y <= box.by1; y++) {
      for (let x = box.bx0; x <= box.bx1; x++) {
        const lx = x - det.rx0, ly = y - det.ry0;
        if (lx >= 0 && lx < det.rw && ly >= 0 && ly < det.rh) {
          const v = det.seed[ly * det.rw + lx];
          mask[(y - box.by0) * bw + (x - box.bx0)] = v;
          rawHits += v;
        }
      }
    }
    // 用「原始笔画密度」判误检，而不是膨胀后的覆盖率：文字笔画经膨胀会连成片，
    // 拿膨胀覆盖率判断会把正常的文字水印全部误杀（1.4.27 自检发现的坑）。
    // 只有整块实心白（密度 > 0.5）才可能是白色物体，宁可放过也不抹花。
    if (rawHits === 0) return { changed: false, reason: '无有效水印像素' };
    if (rawHits / (bw * bh) > 0.5) return { changed: false, reason: '实心亮块，跳过以免破坏画面' };
    const grown = dilateMask(mask, bw, bh, o.dilate);
    let hit = 0;
    for (let i = 0; i < grown.length; i++) hit += grown[i];
    if (hit === 0) return { changed: false, reason: '无有效水印像素' };
    fillMaskByColumn(data, W, H, grown, box);
    return { changed: true, name: rect.name, pixels: det.count, coverage: det.cov, box: box };
  }

  /**
   * 1.5.1 主入口：所有站点、所有图片逐张调用。
   * 贴边瓦片 + 宽松种子 + 结构校验定位任意位置（含最右下角、拼接长图中间、
   * 多帧重复）的亮色水印，再逐条带做纹理重建；检测不到水印时原图一个字节都不改。
   * @returns {{changed:boolean, reason:string, regions:Array, pixels:number, method:string}}
   */
  function removeWatermarks(imgData, opts) {
    const o = Object.assign({}, TILE_DEFAULTS, opts || {});
    const W = imgData.width, H = imgData.height, data = imgData.data;
    if (W < 64 || H < 64) return { changed: false, reason: '图片过小，跳过', regions: [], pixels: 0 };
    if (W * H > o.maxPixels) {
      return { changed: false, reason: '图片过大，跳过本机处理', regions: [], pixels: 0 };
    }
    let ctx, bands;
    try {
      ctx = buildStrokeMask(data, W, H, o);   // 全部基于原图快照
      bands = findWatermarkBands(ctx.soft, W, H, o, ctx);
    } catch (e) {
      return { changed: false, reason: '检测失败：' + String(e && e.message || e),
        regions: [], pixels: 0 };
    }
    if (!bands.length) {
      return { changed: false, reason: '未检测到水印', regions: [], pixels: 0 };
    }
    const src = data.slice();   // 原图快照：多条带重建互不污染
    const regions = [];
    for (const b of bands) {
      const box = {
        bx0: Math.max(0, b.x0 - o.rebuildPad), by0: Math.max(0, b.y0 - o.rebuildPad),
        bx1: Math.min(W - 1, b.x1 + o.rebuildPad), by1: Math.min(H - 1, b.y1 + o.rebuildPad)
      };
      const bw = box.bx1 - box.bx0 + 1, bh = box.by1 - box.by0 + 1;
      if (bw < 8 || bh < 3) continue;
      // 二次保险：条带里必须真有足够多的亮笔画，否则宁可不动原图
      const m = new Uint8Array(bw * bh);
      let strokes = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const p = (box.by0 + y) * W + (box.bx0 + x);
          const v = ctx.strong[p] || ctx.soft[p] ? 1 : 0;
          m[y * bw + x] = v; strokes += v;
        }
      }
      if (strokes / (bw * bh) < o.minStrokeCov) continue;
      let pixels = 0;
      try { pixels = rebuildBand(data, src, W, H, box, o); }
      catch (e) { pixels = 0; }
      if (!pixels) {
        // 极端场景（条带紧贴图像边缘导致参考行不可用）回退到逐像素纹理填充
        try {
          const grown = dilateMask(m, bw, bh, o.bandDilate);
          let hits = 0;
          for (let i = 0; i < grown.length; i++) hits += grown[i];
          if (hits) { localTextureFill(data, W, H, grown, box, o); pixels = hits; }
        } catch (e) { continue; }
      }
      if (!pixels) continue;
      regions.push({
        name: positionName((box.bx0 + box.bx1) / 2, (box.by0 + box.by1) / 2, W, H),
        pixels: pixels, coverage: pixels / (bw * bh), box: box
      });
    }
    const pixels = regions.reduce((n, r) => n + (r.pixels || 0), 0);
    return {
      changed: regions.length > 0,
      reason: regions.length ? '' : '未检测到水印',
      regions: regions,
      pixels: pixels,
      method: 'tile-edge-texture'
    };
  }

  const api = { removeWatermark, removeWatermarks, inpaintCorner,
    DEFAULTS, FULL_DEFAULTS, DEFAULT_REGION, REGIONS, TILE_DEFAULTS,
    buildStrokeMask, findWatermarkBands, localTextureFill,
    tilePositions, bandStructure, boxMeanRow, rebuildBand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Inpaint = api;
})(typeof self !== 'undefined' ? self : this);
