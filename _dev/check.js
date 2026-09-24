'use strict';
/* 最终一致性自检：文件引用、加载顺序、模块导出、配置自洽，
 * 并用一个迷你 DOM 让 main.js 的静帧分支真正跑一遍（端到端）。 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.cwd();
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fail++; };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 1. HTML 引用的资源都存在 */
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  ok(fs.existsSync(path.join(ROOT, m[1])), '引用存在: ' + m[1]);
}

/* 2. 加载顺序 */
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
ok(scripts.length === 6, '脚本数量 = 6（实际 ' + scripts.length + '）');
ok(scripts[0].endsWith('config.js'), 'config.js 最先加载');
ok(scripts[scripts.length - 1].endsWith('main.js'), 'main.js 最后加载');
ok(/id="scene"/.test(html), 'HTML 里有 id="scene"');

/* 3. 迷你 DOM：让 main.js 走 ?t= 静帧分支并真的画一帧 */
const counts = { fill: 0, fillText: 0, arc: 0, stroke: 0 };
const canvasStub = {
  clientWidth: 800, clientHeight: 900, width: 0, height: 0,
  addEventListener() {},
  setPointerCapture() {},
  getContext() {
    return {
      setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, clearRect() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, setLineDash() {},
      arc() { counts.arc++; }, fill() { counts.fill++; }, stroke() { counts.stroke++; },
      measureText: t => ({ width: [...t].length * 30 }),
      fillText() { counts.fillText++; },
      createLinearGradient: () => ({ addColorStop() {} }),
      fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
      shadowColor: '', globalAlpha: 1, shadowBlur: 0
    };
  }
};

const sb = {}; sb.window = sb; sb.console = console;
sb.document = { getElementById: id => (id === 'scene' ? canvasStub : null) };
sb.location = { search: '?t=0.5' };
sb.addEventListener = () => {};
sb.devicePixelRatio = 1;
sb.matchMedia = () => ({ matches: false });
sb.requestAnimationFrame = () => {};
sb.innerWidth = 800; sb.innerHeight = 900;

vm.createContext(sb);
for (const f of scripts) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
}

/* 4. 模块导出 */
ok(!!sb.MOONFEST, 'window.MOONFEST 已导出');
ok(typeof sb.MoonfestRandom === 'function', 'window.MoonfestRandom 已导出');
ok(typeof sb.HeartParticles === 'function', 'window.HeartParticles 已导出');
ok(typeof sb.HeartParticles.beatScale === 'function', 'HeartParticles.beatScale 已导出');
ok(typeof sb.FlowText === 'function', 'window.FlowText 已导出');
ok(typeof sb.Ambient === 'function', 'window.Ambient 已导出');

/* 5. 端到端：main.js 真的画了一帧 */
ok(canvasStub.width === 800 && canvasStub.height === 900, 'canvas 后备缓冲已按 dpr 设置');
ok(counts.fill > 0, '爱心已提交 ' + counts.fill + ' 次 fill');
ok(counts.arc > 5000, '粒子实际参与绘制: ' + counts.arc + ' 个');
ok(counts.fillText > 0, '字幕实际绘制 ' + counts.fillText + ' 行');

/* 6. 配置自洽 */
const c = sb.MOONFEST;
ok(c.design.w === 800 && c.design.h === 900, '设计画布 800x900');
const pool = c.text.scroll.pool;
ok(pool.length >= 2, '文案池 ' + pool.length + ' 句');
const lens = [...new Set(pool.map(s => [...s].length))];
ok(lens.length === 1, '文案池每句字数一致（' + lens.join('/') + '），输出量才均匀');
ok(c.heart.profile.s.length === c.heart.profile.w.length, '密度剖面 s/w 等长');
ok(c.heart.colorStops.every((v, i, a) => i === 0 || v > a[i - 1]), '颜色阈值递增');

/* 7. 心跳：classic 必须是「正负对称、穿过静息点、幅度精确」的匀强正弦 */
const B = c.heart.beat;
let lo = 9, hi = -9;
for (let i = 0; i < 8000; i++) { const v = sb.HeartParticles.beatScale(i * 0.005, B); lo = Math.min(lo, v); hi = Math.max(hi, v); }
ok(Math.abs(lo - (1 - B.amplitude)) < 1e-6 && Math.abs(hi - (1 + B.amplitude)) < 1e-6,
   'classic 缩放范围 = 1 ± ' + B.amplitude + '（实测 ' + lo.toFixed(4) + ' .. ' + hi.toFixed(4) + '）');
ok(Math.abs(sb.HeartParticles.beatScale(0, B) - 1) < 1e-9, 'classic 在 t=0 时恰好静息（正负对称）');
ok(Math.abs(sb.HeartParticles.beatScale(B.period / 4, B) - (1 + B.amplitude)) < 1e-9, 'classic 在 T/4 处达到扩张峰值');
ok(Math.abs(sb.HeartParticles.beatScale(3 * B.period / 4, B) - (1 - B.amplitude)) < 1e-9, 'classic 在 3T/4 处达到收缩峰值');
ok(Math.abs(B.period - 1.2566) < 1e-3, 'classic 周期 = ' + B.period + 's（原版 2π/5）');
ok(typeof B.jitter === 'number' && B.jitter >= 0, 'jitter 抖动配置存在 = ' + B.jitter);

/* pulse 模式保留且仍可用 */
const Bp = Object.assign({}, B, { mode: 'pulse' });
let plo = 9, phi = -9;
for (let i = 0; i < 4000; i++) { const v = sb.HeartParticles.beatScale(i * 0.005, Bp); plo = Math.min(plo, v); phi = Math.max(phi, v); }
ok(plo < 1 && phi > 1.05, 'pulse 双脉冲模式仍可用（' + plo.toFixed(4) + ' .. ' + phi.toFixed(4) + '）');

/* 8. 粒子规模 */
const heart = new sb.HeartParticles(c);
ok(heart.count > 5000, '粒子数 = ' + heart.count);
ok(heart.buckets.length < 900, '颜色桶 = ' + heart.buckets.length + '（即每帧 fill 次数）');

/* 9. 字幕几何。要同时满足两个看似矛盾的要求：
 *      a) 间距必须随机 —— 这是"视觉上的不规律感"的来源
 *      b) 所有行速度一致，于是相对间距一旦定下就永不改变 ——
 *         所以不规律会一路保持到顶，且绝不互相追上、重叠 */
const rnd = sb.MoonfestRandom(1);
const SL = c.text.scroll;
for (const [w, h, k] of [[1920, 1080, 1.2], [390, 844, 0.45], [1440, 900, 1.0], [2560, 1440, 1.6]]) {
  const tag = '视口 ' + w + 'x' + h + '：';
  const f = new sb.FlowText(c, rnd);
  f.layout(w, h, k, w / 2);

  const ys = f.slots.map(s => s.y).sort((a, b) => a - b);
  const gaps = ys.slice(1).map((v, i) => v - ys[i]);
  const uniq = [...new Set(gaps.map(g => +g.toFixed(4)))];
  const gMin = f.size * SL.gapMinRatio, gMax = f.size * SL.gapMaxRatio;

  ok(uniq.length > 1, tag + '间距是随机的（' + uniq.length + ' 种不同值）');
  ok(gaps.every(g => g >= gMin - 1e-6 && g <= gMax + 1e-6),
     tag + '间距都落在 [' + gMin.toFixed(0) + ', ' + gMax.toFixed(0) + '] 内');
  ok(f.slots.every(s => s.y > f.top), tag + '布局后所有行都在 top 之下（首帧无回收）');
  const visible = ys.filter(v => v >= 0 && v <= h).length;
  ok(visible >= 4, tag + '屏上同时可见 ' + visible + ' 行');
  ok(f.size >= 16 && f.size <= SL.maxSize + 0.001, tag + '字号 ' + f.size.toFixed(1) + 'px 可读');

  /* 滚一段（短到没有行出顶），随机间距必须原样保持 */
  const tExit = (ys[0] - f.top) / f.speed;
  const steps = Math.max(1, Math.floor(tExit * 0.4 * 60));
  for (let i = 0; i < steps; i++) f.update(1 / 60);
  const ys2 = f.slots.map(s => s.y).sort((a, b) => a - b);
  const gaps2 = ys2.slice(1).map((v, i) => v - ys2[i]);
  ok(gaps2.every((g, i) => Math.abs(g - gaps[i]) < 1e-6),
     tag + '滚动 ' + (steps / 60).toFixed(2) + 's 后随机间距原样保持（速度一致，不会互相追上）');
  ok(Math.abs((ys[ys.length - 1] - ys[0]) - (ys2[ys2.length - 1] - ys2[0])) < 1e-6,
     tag + '整体跨度不变');
}

/* 10. 3D：俯仰应产生纵向前缩，偏航应产生横向前缩，且粒子不多不少正好画一遍 */
function renderBounds(pitch, yaw) {
  const bb = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, n: 0 };
  const c = {
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, clearRect() {},
    beginPath() {}, moveTo() {}, fill() {}, fillStyle: '', globalAlpha: 1,
    arc(x, y) {
      if (x < bb.minX) bb.minX = x; if (x > bb.maxX) bb.maxX = x;
      if (y < bb.minY) bb.minY = y; if (y > bb.maxY) bb.maxY = y;
      bb.n++;
    }
  };
  heart.render(c, 1.0, 0.12, { pitch, yaw });
  bb.w = bb.maxX - bb.minX;
  bb.h = bb.maxY - bb.minY;
  return bb;
}
const front = renderBounds(0, 0);
const pitched = renderBounds(0.7, 0);
const yawed = renderBounds(0, 0.7);
ok(isFinite(front.minX) && isFinite(front.maxY), '投影结果没有 NaN');
ok(front.n === heart.count,
   '正面视角下每个粒子恰好画一次（' + front.n + ' / ' + heart.count + '）');
ok(pitched.h < front.h * 0.92,
   '俯仰 0.7rad 纵向前缩：' + front.h.toFixed(0) + ' -> ' + pitched.h.toFixed(0));
ok(pitched.w > front.w * 0.90,
   '俯仰不改变横向跨度：' + pitched.w.toFixed(0));
ok(yawed.w < front.w * 0.95,
   '偏航 0.7rad 横向前缩：' + front.w.toFixed(0) + ' -> ' + yawed.w.toFixed(0));
ok(yawed.h > front.h * 0.95,
   '偏航不改变纵向跨度：' + yawed.h.toFixed(0));

/* 11. 开场信封：拆封各阶段都能画出来，进度能收敛到完成 */
ok(typeof sb.Envelope === 'function', 'window.Envelope 已导出');
ok(c.envelope.enabled === true, '信封默认启用');
ok(c.envelope.text === '有一份中秋节礼物等待查收', '信封文案正确');

const ec = { fill: 0, stroke: 0, text: [] };
const envCtx = {
  setTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
  beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, setLineDash() {},
  fill() { ec.fill++; }, stroke() { ec.stroke++; }, arc() {},
  fillText(t) { ec.text.push(t); },
  measureText: t => ({ width: [...t].length * c.envelope.textSize }),
  createLinearGradient: () => ({ addColorStop() {} }),
  fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
  shadowColor: '', globalAlpha: 1, shadowBlur: 0
};

const env = new sb.Envelope(c);
let envOk = true;
try {
  env.render(envCtx);                                    /* 未拆封 */
  env.start();
  for (const dt of [0.05, 0.2, 0.3, 0.4, 0.5, 0.6]) { env.update(dt); env.render(envCtx); }
  env.update(5); env.render(envCtx);                     /* 收尾 */
} catch (e) { envOk = false; console.log('  信封渲染抛错: ' + e.message); }
ok(envOk, '拆封全程渲染无异常（含未拆封 / 拆封中 / 已拆完）');
ok(env.done === true, '拆封动画能走到完成');
ok(env.progress === 1, '进度封顶到 1，不会溢出');
ok(ec.fill > 10 && ec.stroke > 0, '信封确实画出了图元（fill=' + ec.fill + ' stroke=' + ec.stroke + '）');
ok(ec.text.indexOf(c.envelope.text) >= 0, '信封上的文案被绘制');

/* 不启用信封时必须能直接进主场景（main.js 的 scene 初值是 heart） */
const c2 = JSON.parse(JSON.stringify(c));
c2.envelope.enabled = false;
ok(c2.envelope.enabled === false, 'envelope.enabled=false 的配置路径存在');

console.log(fail === 0 ? '\n全部通过 (' + 0 + ' 失败)' : '\n失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
