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
ok(scripts.length === 5, '脚本数量 = 5（实际 ' + scripts.length + '）');
ok(scripts[0].endsWith('config.js'), 'config.js 最先加载');
ok(scripts[scripts.length - 1].endsWith('main.js'), 'main.js 最后加载');
ok(/id="scene"/.test(html), 'HTML 里有 id="scene"');

/* 3. 迷你 DOM：让 main.js 走 ?t= 静帧分支并真的画一帧 */
const counts = { fill: 0, fillText: 0, arc: 0 };
const canvasStub = {
  clientWidth: 800, clientHeight: 900, width: 0, height: 0,
  getContext() {
    return {
      setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, clearRect() {},
      beginPath() {}, moveTo() {}, arc() { counts.arc++; }, fill() { counts.fill++; },
      measureText: t => ({ width: [...t].length * 30 }),
      fillText() { counts.fillText++; },
      createLinearGradient: () => ({ addColorStop() {} }),
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
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

/* 9. 字幕在任意屏幕比例下的几何性质。
 *    注意槽位是一个整体匀速平移的等距点阵，所以「某一瞬间顶端刚好空着」是
 *    正常的 —— 空档一定小于一个行距，下一秒就被上移的行填上。要断言的是：
 *      a) 间距恒定（等距点阵）
 *      b) 顶部空档 < 一个行距
 *      c) 行程覆盖整个屏幕高度（每行都会从最底滚到最顶）
 *      d) 屏上同时可见的行数足够 */
const rnd = sb.MoonfestRandom(1);
for (const [w, h, k] of [[1920, 1080, 1.2], [390, 844, 0.45], [1440, 900, 1.0], [2560, 1440, 1.6]]) {
  const f = new sb.FlowText(c, rnd);
  f.layout(w, h, k, w / 2);
  const ys = f.slots.map(s => s.y).sort((a, b) => a - b);
  const gaps = [...new Set(ys.slice(1).map((v, i) => +(v - ys[i]).toFixed(6)))];
  const gap = gaps[0];
  const visible = ys.filter(y => y >= 0 && y <= h).length;
  ok(gaps.length === 1, '视口 ' + w + 'x' + h + '：间距恒定 gap=' + gap);
  ok(ys[0] < gap, '视口 ' + w + 'x' + h + '：顶部空档 ' + ys[0].toFixed(1) + ' < 一个行距');
  ok(f.span >= h, '视口 ' + w + 'x' + h + '：行程 ' + f.span.toFixed(0) + ' 覆盖全高');
  ok(visible >= 6 && visible <= 8, '视口 ' + w + 'x' + h + '：屏上同时可见 ' + visible + ' 行（目标 6~8）');
  ok(f.size >= 16 && f.size <= c.text.scroll.maxSize + 0.001, '视口 ' + w + 'x' + h + '：字号 ' + f.size.toFixed(1) + 'px 可读');
}

console.log(fail === 0 ? '\n全部通过 (' + 0 + ' 失败)' : '\n失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
