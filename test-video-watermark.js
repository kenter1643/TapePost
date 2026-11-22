/* TapePost 1.5.12 · 视频逐帧去水印专项自检
 * 运行：node test-video-watermark.js   （不进 Chrome Web Store 商店包）
 *
 * 背景：真机反馈「勾了逐帧去水印，导出的视频水印依然存在」。根因是
 * video-edit.js 直接复用了为静态高清图调参的 Inpaint.removeWatermarks：
 * 视频帧缩到 540~720p、经过 H.264 压缩、水印半透明且只有十几像素高，
 * lumStrong 175 / deltaStrong 18 / widthMin 90 / jumpsConfirm 12 几乎全部
 * 卡死，检测结果恒为 0 → boxes 为空 → 每帧原样 putImageData 回去。
 * 同时旧版只在首帧检测（之后每 90 帧）、检测不到也不告诉用户。
 *
 * 本脚本在 vm 里加载真实的 video-edit.js + inpaint.js，只测纯像素链路：
 * 手动框每帧无条件重建、自动模式放宽后能命中、未命中时明确报警、
 * 图片侧参数不受污染、框外像素一字节不动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

const Inpaint = require(path.join(DIR, 'inpaint.js'));
const sandbox = { Inpaint: Inpaint, console: console };
vm.createContext(sandbox);
vm.runInContext(read('video-edit.js'), sandbox, { filename: 'video-edit.js' });
const V = sandbox.VideoEdit;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1 : tol); }

/* 合成一帧：渐变低频背景 + 可选的稀疏亮笔画水印（模拟 H.264 后的半透明白字） */
function makeFrame(W, H, boxes, alpha, cov) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const base = 70 + 55 * (x / W) + 30 * Math.sin(y / 41) + 12 * Math.sin(x / 19 + y / 57);
      d[i] = base + 16; d[i + 1] = base + 6; d[i + 2] = base - 14; d[i + 3] = 255;
    }
  }
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const b of (boxes || [])) {
    const x0 = Math.round(b.x0 * W), x1 = Math.round(b.x1 * W);
    const y0 = Math.round(b.y0 * H), y1 = Math.round(b.y1 * H);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (rnd() > (cov == null ? 0.18 : cov)) continue;
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * (1 - alpha) + 248 * alpha;
      }
    }
  }
  return { width: W, height: H, data: d };
}
function meanLum(img, box) {
  const W = img.width, H = img.height;
  const x0 = Math.round(box.x0 * W), x1 = Math.round(box.x1 * W);
  const y0 = Math.round(box.y0 * H), y1 = Math.round(box.y1 * H);
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      s += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      n++;
    }
  }
  return n ? s / n : 0;
}
function slice(img, box) {
  const W = img.width;
  const x0 = Math.round(box.x0 * W), x1 = Math.round(box.x1 * W);
  const y0 = Math.round(box.y0 * img.height), y1 = Math.round(box.y1 * img.height);
  const out = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 4;
    out.push(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
  }
  return out;
}
function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\n[1] 模块与参数');
ok(!!V && typeof V.makeWatermarkProcessor === 'function', 'VideoEdit 导出 makeWatermarkProcessor');
ok(typeof V.rebuildVideoBox === 'function', '导出 rebuildVideoBox');
ok(typeof V.normalizeWmBoxes === 'function', '导出 normalizeWmBoxes');
ok(typeof V.wmNoteFor === 'function', '导出 wmNoteFor');
ok(!!V.VIDEO_WM_DEFAULTS, '导出视频专用参数');
ok(V.VIDEO_WM_DEFAULTS.lumStrong < Inpaint.TILE_DEFAULTS.lumStrong, '亮度阈值比图片版低');
ok(V.VIDEO_WM_DEFAULTS.deltaStrong < Inpaint.TILE_DEFAULTS.deltaStrong, '局部对比阈值比图片版低');
ok(V.VIDEO_WM_DEFAULTS.widthMin < Inpaint.TILE_DEFAULTS.widthMin, '最小水印宽度比图片版低');
ok(V.VIDEO_WM_DEFAULTS.jumpsConfirm < Inpaint.TILE_DEFAULTS.jumpsConfirm, '列跳变门槛比图片版低');
ok(Inpaint.TILE_DEFAULTS.lumStrong === 175 && Inpaint.TILE_DEFAULTS.widthMin === 90,
  '图片侧 TILE_DEFAULTS 未被污染');

console.log('\n[2] 手动框：每帧无条件生效');
{
  const W = 720, H = 1280;
  const box = { x0: 0.60, y0: 0.87, x1: 0.98, y1: 0.98 };
  const p = { wm: true, wmMode: 'manual', wmBoxes: [box] };
  const wm = V.makeWatermarkProcessor(W, H, p);
  ok(wm.mode === 'manual', '模式 = manual');
  const before = makeFrame(W, H, [box], 0.9, 0.18);
  const outsideBefore = slice(before, { x0: 0.02, y0: 0.05, x1: 0.30, y1: 0.20 });
  const lumBefore = meanLum(before, box);
  for (let f = 0; f < 8; f++) {
    const img = makeFrame(W, H, [box], 0.9, 0.18);
    if (f === 0) {
      ok(sameArray(slice(img, { x0: 0.02, y0: 0.05, x1: 0.30, y1: 0.20 }), outsideBefore),
        '处理前框外像素作为基准一致');
    }
    wm.apply(img, f);
    if (f === 0) {
      const lumAfter = meanLum(img, box);
      ok(lumAfter < lumBefore - 8, '第 0 帧水印区亮度显著下降 (' + lumBefore.toFixed(1) + '→' + lumAfter.toFixed(1) + ')');
      ok(sameArray(slice(img, { x0: 0.02, y0: 0.05, x1: 0.30, y1: 0.20 }), outsideBefore),
        '框外像素一字节不动');
    }
  }
  const st = wm.stats();
  ok(st.frames === 8, '8 帧全部处理（frames=' + st.frames + '）');
  ok(st.regions === 1, '统计 1 个手动框');
  ok(st.detected === true, 'manual 模式 detected 为真');
  ok(st.scans === 0, 'manual 模式不做自动扫描，性能稳定');
  ok(V.wmNoteFor(st).indexOf('逐帧重建 8 帧') >= 0, '结果文案说明逐帧重建帧数');
}
{
  const W = 640, H = 360;
  const boxes = [
    { x0: 0.58, y0: 0.01, x1: 0.99, y1: 0.14 },
    { x0: 0.01, y0: 0.86, x1: 0.42, y1: 0.99 }
  ];
  const wm = V.makeWatermarkProcessor(W, H, { wm: true, wmMode: 'manual', wmBoxes: boxes });
  const img = makeFrame(W, H, boxes, 0.9, 0.18);
  const l0 = meanLum(img, boxes[0]), l1 = meanLum(img, boxes[1]);
  wm.apply(img, 0);
  ok(meanLum(img, boxes[0]) < l0 - 5, '右上框被重建');
  ok(meanLum(img, boxes[1]) < l1 - 5, '左下框被重建');
  ok(wm.stats().regions === 2, '统计 2 个手动框');
}
{
  const b = V.normalizeWmBoxes([{ x0: 0.25, y0: 0.5, x1: 0.75, y1: 0.9 }], 800, 400);
  ok(b.length === 1 && b[0].bx0 === 200 && b[0].bx1 === 600 && b[0].by0 === 200 && b[0].by1 === 360,
    '归一化坐标按 W/H 正确换算');
  ok(V.normalizeWmBoxes([{ x0: 0.1, y0: 0.1, x1: 0.1001, y1: 0.11 }], 100, 100).length === 0,
    '过小框被过滤');
  ok(V.normalizeWmBoxes([{ x0: 'x', y0: 0, x1: 1, y1: 1 }], 100, 100).length === 0,
    '非法坐标被过滤');
}
{
  const wm = V.makeWatermarkProcessor(640, 360, { wm: true, wmMode: 'manual', wmBoxes: [] });
  ok(wm.mode === 'auto', 'manual 但没给有效框时自动退回 auto，避免静默失效');
}

console.log('\n[3] F闭去水印');
{
  const W = 640, H = 360;
  const box = { x0: 0.5, y0: 0.8, x1: 0.99, y1: 0.99 };
  const wm = V.makeWatermarkProcessor(W, H, { wm: false });
  ok(wm.mode === 'off', 'wm=false → off');
  const img = makeFrame(W, H, [box], 0.9, 0.2);
  const snap = img.data.slice();
  wm.apply(img, 0);
  ok(sameArray(Array.from(img.data), Array.from(snap)), 'off 模式像素完全不动');
  ok(wm.stats().frames === 0, 'off 模式 frames=0');
  ok(V.wmNoteFor(wm.stats()) === '未启用去水印', 'off 模式文案正确');
  const wm2 = V.makeWatermarkProcessor(W, H, { wm: true, wmMode: 'off' });
  ok(wm2.mode === 'off', 'wmMode=off 优先于 wm=true');
}

console.log('\n[4] 自动模式：放宽参数后能命中');
{
  const W = 720, H = 405;
  const box = { x0: 0.70, y0: 0.90, x1: 0.95, y1: 0.97 };
  const wm = V.makeWatermarkProcessor(W, H, { wm: true });
  ok(wm.mode === 'auto', '默认模式 = auto');
  let detected = false;
  for (let f = 0; f < 12; f++) {
    const img = makeFrame(W, H, [box], 0.7, 0.18);
    wm.apply(img, f);
    if (wm.stats().detected) detected = true;
  }
  const st = wm.stats();
  ok(detected, '半透明水印在前 12 帧内被自动检出');
  ok(st.scans === 4, '片头 12 帧内每 3 帧扫一次（避开黑帧且不拖慢录制），scans=' + st.scans);
  ok(st.frames > 0, '检出后有帧被重建，frames=' + st.frames);
  ok(st.regions >= 1, '统计命中区域数 >= 1');
  ok(V.wmNoteFor(st).indexOf('自动检出') >= 0, '命中时文案说明检出结果');
  const st2 = V.makeWatermarkProcessor(W, H, { wm: true });
  st2.apply(makeFrame(W, H, [box], 0.7, 0.18), 0);
  const s0 = st2.stats().scans;
  st2.apply(makeFrame(W, H, [], 0.7, 0.18), 30);
  ok(st2.stats().scans === s0 + 1, '第 30 帧触发周期重检');
}

console.log('\n[5] 自动模式：检不出必须明确报警');
{
  const W = 640, H = 360;
  const wm = V.makeWatermarkProcessor(W, H, { wm: true });
  for (let f = 0; f < 90; f++) wm.apply(makeFrame(W, H, [], 0.7, 0.18), f);
  const st = wm.stats();
  ok(!st.detected, '无水印画面不会误检');
  ok(st.frames === 0, '没检出时 frames=0，成品即原画面');
  const note = V.wmNoteFor(st);
  ok(note.indexOf('未自动检出水印') >= 0, '文案明确告知未检出');
  ok(note.indexOf('水印位置') >= 0, '文案指引用户改用手动框');
  ok(st.mode === 'auto', '统计里带 mode 供 UI 判断');
}

console.log('\n[6] 重建函数本身');
{
  const W = 200, H = 120;
  const src = makeFrame(W, H, [{ x0: 0.3, y0: 0.3, x1: 0.7, y1: 0.6 }], 1, 0.5);
  const data = src.data.slice();
  const box = { bx0: 60, by0: 36, bx1: 140, by1: 72 };
  const outside = slice({ width: W, height: H, data: data }, { x0: 0.05, y0: 0.05, x1: 0.2, y1: 0.2 });
  const n = V.rebuildVideoBox(data, src.data, W, H, box);
  ok(n > 0, 'rebuildVideoBox 返回改动像素数 (' + n + ')');
  const after = { width: W, height: H, data: data };
  ok(sameArray(slice(after, { x0: 0.05, y0: 0.05, x1: 0.2, y1: 0.2 }), outside), '重建不越界改框外像素');
  ok(meanLum(after, { x0: 0.35, y0: 0.35, x1: 0.65, y1: 0.55 }) < 160, '重建后框内亮度回到背景量级');
  ok(V.rebuildVideoBox(new Uint8ClampedArray(4 * 4 * 4), new Uint8ClampedArray(4 * 4 * 4), 4, 4,
    { bx0: 1, by0: 1, bx1: 2, by1: 2 }) >= 0, '极小画布不抛异常');
}

console.log('\n[7] 运动画面逐帧一致性');
{
  const W = 640, H = 360;
  const box = { x0: 0.6, y0: 0.85, x1: 0.98, y1: 0.98 };
  const wm = V.makeWatermarkProcessor(W, H, { wm: true, wmMode: 'manual', wmBoxes: [box] });
  let allChanged = true;
  for (let f = 0; f < 6; f++) {
    // 每帧背景相位不同，模拟运动物体
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const base = 60 + 50 * Math.sin((x + f * 23) / 60) + 30 * Math.cos((y + f * 17) / 40);
      d[i] = base + 12; d[i + 1] = base; d[i + 2] = base - 12; d[i + 3] = 255;
    }
    const bx0 = Math.round(box.x0 * W), bx1 = Math.round(box.x1 * W);
    const by0 = Math.round(box.y0 * H), by1 = Math.round(box.y1 * H);
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) d[i + c] = 250;
    }
    const img = { width: W, height: H, data: d };
    const before = meanLum(img, box);
    wm.apply(img, f);
    if (!(meanLum(img, box) < before - 20)) allChanged = false;
  }
  ok(allChanged, '6 帧不同背景下手动框都生效');
  ok(wm.stats().frames === 6, '运动画面 frames=6');
}

console.log('\n结果：' + pass + '/' + (pass + fail) + (fail ? '  失败 ' + fail + ' 项' : '  全部通过'));
process.exit(fail ? 1 : 0);
