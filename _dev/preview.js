'use strict';
/* ============================================================================
 * _dev/preview.js —— 离线预览/自检（开发用，不参与页面发布）
 *
 * 沙箱里跑不了 Chromium（mojo 命名管道被拦），所以这里用 Node 直接加载真实的
 * js/heart.js 与 js/flowtext.js，配一个只实现所需子集的迷你 Canvas2D，
 * 把画面光栅化成 PNG，用来核对「镂空」形状与字幕版式。
 *
 * 文字没有字体光栅器，这里用等宽色块代替字形：
 *   中文单字宽度 ≈ 1em，所以色块宽度 = 字数 × 字号，位置/透明度与真实一致。
 * ========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const W = 800, H = 900;

/* 用法：node _dev/preview.js [pitch] [yaw] [输出文件名]
   pitch/yaw 单位是弧度。默认 0 0，即正面视角。 */
const ARG_PITCH = parseFloat(process.argv[2] || '0') || 0;
const ARG_YAW = parseFloat(process.argv[3] || '0') || 0;
const OUT_NAME = process.argv[4] || 'heart_preview.png';

/* ---------------- 迷你 Canvas2D ---------------- */
function createCanvas(w, h) {
  const buf = new Float32Array(w * h * 4);   // 已合成的 RGB + A，0..1

  /* 背景：模拟 css/style.css 的径向渐变 */
  const gx = w * 0.5, gy = h * 0.42;
  const maxR = Math.hypot(Math.max(gx, w - gx), Math.max(gy, h - gy));
  const stops = [
    [0.00, [0x2a, 0x0d, 0x1c]], [0.34, [0x15, 0x0a, 0x17]],
    [0.62, [0x0a, 0x07, 0x10]], [1.00, [0x06, 0x04, 0x09]]
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = Math.min(1, Math.hypot(x - gx, y - gy) / maxR);
      let i = 0;
      while (i < stops.length - 2 && u > stops[i + 1][0]) i++;
      const a = stops[i], b = stops[i + 1];
      const k = (u - a[0]) / (b[0] - a[0] || 1);
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        buf[o + c] = (a[1][c] + (b[1][c] - a[1][c]) * k) / 255;
      }
      buf[o + 3] = 1;
    }
  }

  function blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    buf[o]     = buf[o]     * (1 - a) + r * a;
    buf[o + 1] = buf[o + 1] * (1 - a) + g * a;
    buf[o + 2] = buf[o + 2] * (1 - a) + b * a;
    buf[o + 3] = buf[o + 3] * (1 - a) + a;
  }

  function parseColor(s) {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s);
    return m ? [+m[1] / 255, +m[2] / 255, +m[3] / 255] : [0, 0, 0];
  }

  /* fillStyle 可能是纯色字符串，也可能是渐变对象；渐变按 u 采样 */
  function colorAt(style, u) {
    if (typeof style === 'string') return parseColor(style);
    const st = style._stops;
    if (!st || !st.length) return [0, 0, 0];
    let i = 0;
    while (i < st.length - 2 && u > st[i + 1][0]) i++;
    const a = st[i], b = st[i + 1] || st[i];
    const k = (u - a[0]) / ((b[0] - a[0]) || 1);
    const ca = parseColor(a[1]), cb = parseColor(b[1]);
    return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k];
  }

  let m = [1, 0, 0, 1, 0, 0], fill = 'rgb(0,0,0)', alpha = 1, font = '30px x';
  let stack = [], discs = [], textCalls = [];

  const mul = (A, B) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]
  ];
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  return {
    canvas: { width: w, height: h },
    buf,
    textCalls,
    set fillStyle(v) { fill = v; }, get fillStyle() { return fill; },
    set globalAlpha(v) { alpha = v; }, get globalAlpha() { return alpha; },
    set font(v) { font = v; }, get font() { return font; },
    set textAlign(v) {}, get textAlign() { return 'center'; },
    set textBaseline(v) {}, get textBaseline() { return 'middle'; },
    set shadowColor(v) {}, set shadowBlur(v) {}, set shadowOffsetX(v) {}, set shadowOffsetY(v) {},
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    save() { stack.push([m.slice(), fill, alpha]); },
    restore() { const s = stack.pop(); if (s) { m = s[0]; fill = s[1]; alpha = s[2]; } },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    scale(x, y) { m = mul(m, [x, 0, 0, y, 0, 0]); },
    clearRect() {},
    beginPath() { discs = []; },
    moveTo() {},
    arc(x, y, r) {
      const p = apply(x, y);
      const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
      discs.push([p[0], p[1], r * Math.sqrt(det)]);
    },
    fill() {
      const [fr, fg, fb] = colorAt(fill, 0.5);
      for (const [x, y, r] of discs) {
        const x0 = Math.max(0, Math.floor(x - r - 1)), x1 = Math.min(w - 1, Math.ceil(x + r + 1));
        const y0 = Math.max(0, Math.floor(y - r - 1)), y1 = Math.min(h - 1, Math.ceil(y + r + 1));
        for (let py = y0; py <= y1; py++) {
          for (let px = x0; px <= x1; px++) {
            const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
            const cov = Math.max(0, Math.min(1, r + 0.5 - d));
            if (cov > 0) blend(px, py, fr, fg, fb, cov * alpha);
          }
        }
      }
      discs = [];
    },
    createLinearGradient(x0, y0, x1, y1) {
      const stops = [];
      return { _stops: stops, _x0: x0, _x1: x1, addColorStop(o, c) { stops.push([o, c]); } };
    },
    measureText(t) {
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
      return { width: [...t].length * size };
    },
    fillText(t, x, y) {
      /* 用色块代替字形：宽度 = 字数 × 字号，高度 = 字号，垂直居中 */
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
      const wid = [...t].length * size;
      const [fr, fg, fb] = colorAt(fill, 0.5);
      textCalls.push({ t, x, y, wid, size, alpha });
      const x0 = Math.round(x - wid / 2), y0 = Math.round(y - size / 2);
      for (let py = y0; py < y0 + size; py++) {
        for (let px = x0; px < x0 + wid; px++) blend(px, py, fr, fg, fb, alpha * 0.9);
      }
    }
  };
}

/* ---------------- PNG 编码 ---------------- */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 加载真实模块 ---------------- */
const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
vm.createContext(sandbox);
for (const f of ['js/config.js', 'js/heart.js', 'js/flowtext.js', 'js/ambient.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const cfg = sandbox.MOONFEST;

/* ---------------- 统计：径向密度（验证「镂空」） ---------------- */
const heart = new sandbox.HeartParticles(cfg);
const rnd = sandbox.MoonfestRandom(cfg.seed >>> 0);

const BINS = 10, hist = new Array(BINS).fill(0);
/* 单独重生成一层主体粒子来统计，避免依赖内部结构 */
const bodyPts = heart._genBody(cfg.heart.layers.body);
for (const p of bodyPts) {
  const s = heart._frac(p.x, p.y);
  hist[Math.min(BINS - 1, Math.floor(s * BINS))]++;
}

/* ---------------- 合成画面 ---------------- */
const ctx = createCanvas(W, H);
const H_ = cfg.heart;
/* 0.12s 约落在原版正弦的第一个扩张峰附近 */
const scale = sandbox.HeartParticles.beatScale(0.12, H_.beat);

/* 字幕：推进 20 秒，让槽位填满并稳定 */
const flow = new sandbox.FlowText(cfg, rnd);
flow.layout(W, H, 1, cfg.heart.cx);     /* 预览按 1:1，k=1 */
for (let i = 0; i < 20 * 60; i++) flow.update(1 / 60);

/* 让文字色块按真实位置画出来（transform 保持 identity，与设计坐标一致） */
const ambient = new sandbox.Ambient(cfg, rnd);
for (let i = 0; i < 20 * 60; i++) ambient.update(1 / 60);

ambient.render(ctx);
heart.render(ctx, scale, 0.12, { pitch: ARG_PITCH, yaw: ARG_YAW });
flow.render(ctx);

/* ---------------- 导出 PNG ---------------- */
const out = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(ctx.buf[i * 4 + c] * 255)));
  out[i * 4 + 3] = 255;
}
const png = encodePNG(W, H, out);
fs.writeFileSync(path.join(__dirname, OUT_NAME), png);

/* ---------------- 文字版式诊断 ---------------- */
const ys = flow.slots.map(s => s.y).sort((a, b) => a - b);
const gaps = ys.slice(1).map((v, i) => +(v - ys[i]).toFixed(4));
const uniq = [...new Set(gaps)];
const alphas = ys.map(y => +flow._alphaAt(y).toFixed(3));

console.log('=== 粒子 ===');
console.log('总粒子数:', heart.count, '| 颜色桶:', heart.buckets.length, '| 闪烁:', heart.flashList.length);
console.log('心跳缩放(峰值):', scale.toFixed(4));
console.log('=== 径向密度直方图（s=0 中心 → s=1 轮廓）===');
const maxh = Math.max(...hist);
for (let i = 0; i < BINS; i++) {
  const lo = (i / BINS).toFixed(1), hi = ((i + 1) / BINS).toFixed(1);
  console.log('  s ' + lo + '-' + hi + ' | ' + '#'.repeat(Math.round(hist[i] / maxh * 46)) + ' ' + hist[i]);
}
console.log('=== 字幕版式 ===');
console.log('槽位数:', flow.count, '| 行程:', flow.span, '| top:', flow.top, '| bottom:', flow.bottom);
console.log('行距是否恒定:', uniq.length === 1 ? '是  gap=' + uniq[0] : '否 -> ' + JSON.stringify(uniq));
console.log('屏内(0..900)行数:', ys.filter(y => y >= 0 && y <= 900).length);
console.log('alpha 曲线(自顶向下):', alphas.join(' '));
console.log('前景文字框数:', ctx.textCalls.length);
console.log('视角 pitch=' + ARG_PITCH.toFixed(2) + ' yaw=' + ARG_YAW.toFixed(2));
console.log('PNG ->', path.join(__dirname, OUT_NAME), png.length, 'bytes');
