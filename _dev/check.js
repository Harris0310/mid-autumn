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
ok(scripts.length === 7, '脚本数量 = 7（实际 ' + scripts.length + '）');
ok(scripts[0].endsWith('config.js'), 'config.js 最先加载');
ok(scripts[scripts.length - 1].endsWith('main.js'), 'main.js 最后加载');
ok(/id="scene"/.test(html), 'HTML 里有 id="scene"');

/* 3. 迷你 DOM：让 main.js 走 ?t= 静帧分支并真的画一帧。
       measureText 按当前 ctx.font 的字号算宽（中文 1em、其余 0.55em），
       和 flowtext.js / letter.js 的估宽口径一致 —— 不然信自动排版测不准。 */
function makeCtx(counts, log) {
  return {
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {}, clearRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, setLineDash() {},
    arc() { if (counts) counts.arc++; },
    fill() { if (counts) counts.fill++; },
    stroke() { if (counts) counts.stroke++; },
    fillText(t) { if (counts) counts.fillText++; if (log) log.push(t); },
    drawImage() { if (counts) counts.image = (counts.image || 0) + 1; },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    measureText(t) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      const size = m ? parseFloat(m[1]) : 30;
      return { width: [...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55), 0) * size };
    },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    shadowColor: '', globalAlpha: 1, shadowBlur: 0, shadowOffsetY: 0
  };
}

function makeSandbox(search, counts, log) {
  const canvas = {
    clientWidth: 800, clientHeight: 900, width: 0, height: 0,
    addEventListener() {},
    setPointerCapture() {},
    getContext() { return makeCtx(counts, log); }
  };
  const s = {};
  s.window = s; s.console = console;
  s.document = {
    getElementById: id => (id === 'scene' ? canvas : null),
    /* 信纸会把自己的静态部分缓存成一张离屏画布（见 letter.js） */
    createElement: () => ({ width: 0, height: 0, getContext: () => makeCtx(counts, log) })
  };
  s.location = { search: search };
  s.addEventListener = () => {};
  s.devicePixelRatio = 1;
  s.matchMedia = () => ({ matches: false });
  s.requestAnimationFrame = () => {};
  s.innerWidth = 800; s.innerHeight = 900;
  vm.createContext(s);
  for (const f of scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), s, { filename: f });
  }
  s.__canvas = canvas;
  return s;
}

const counts = { fill: 0, fillText: 0, arc: 0, stroke: 0 };
const drawn = [];
const sb = makeSandbox('?t=0.5', counts, drawn);
const canvasStub = sb.__canvas;

/* 4. 模块导出 */
ok(!!sb.MOONFEST, 'window.MOONFEST 已导出');
ok(typeof sb.MoonfestRandom === 'function', 'window.MoonfestRandom 已导出');
ok(typeof sb.HeartParticles === 'function', 'window.HeartParticles 已导出');
ok(typeof sb.HeartParticles.beatScale === 'function', 'HeartParticles.beatScale 已导出');
ok(typeof sb.FlowText === 'function', 'window.FlowText 已导出');
ok(typeof sb.Ambient === 'function', 'window.Ambient 已导出');
ok(typeof sb.Letter === 'function', 'window.Letter 已导出');

/* 5. 端到端：main.js 真的画了一帧 */
ok(canvasStub.width === 800 && canvasStub.height === 900, 'canvas 后备缓冲已按 dpr 设置');
ok(counts.fill > 0, '爱心已提交 ' + counts.fill + ' 次 fill');
ok(counts.arc > 5000, '粒子实际参与绘制: ' + counts.arc + ' 个');
ok(counts.fillText > 0, '字幕实际绘制 ' + counts.fillText + ' 行');
ok(drawn.indexOf(sb.MOONFEST.letter.greeting) < 0, '?t=0.5 时信还没出现（时间轴没跑过头）');

/* 6. 配置自洽 */
const c = sb.MOONFEST;
ok(c.design.w === 800 && c.design.h === 900, '设计画布 800x900');
const pool = c.text.scroll.pool;
ok(pool.length >= 2, '文案池 ' + pool.length + ' 句');
const lens = [...new Set(pool.map(s => [...s].length))];
ok(new Set(pool).size === pool.length, '文案池没有重复句（' + pool.length + ' 句，字数 ' + lens.join('/') + '）');
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

/* 9. 流动的字（满屏信息流）。要同时满足：
 *      a) 从**随机位置、随机时刻**出现 —— 横向落点全宽、生成高度分档
 *      b) 单条约 crossSeconds 秒穿完一屏（约 10 倍于原来的单列字幕）
 *      c) 字号随机 + 近快远慢的运动视差 —— 屏上才有纵深
 *      d) 不泄漏：长跑之后条目数稳定在目标密度附近
 *      e) 首帧就预填满屏 —— 拆封显形那一刻不会先空一片 */
const rnd = sb.MoonfestRandom(1);
const SL = c.text.scroll;

/* 速度是用户的口味，改过好几次（1.0 → 0.75 → 1.0 → 2.0），所以这里只守量程：
   太快看不清、太慢就成了慢动作。确切数值由 browsercheck 在真浏览器里实测。 */
ok(SL.crossSeconds >= 0.4 && SL.crossSeconds <= 3,
   '穿屏用时 ' + SL.crossSeconds + 's 在量程内（0.4~3s）');
ok(SL.density >= 6, '目标密度 ' + SL.density + ' 条/屏');

for (const [w, h, k] of [[1920, 1080, 1.2], [390, 844, 0.45], [1440, 900, 1.0], [2560, 1440, 1.6]]) {
  const tag = '视口 ' + w + 'x' + h + '：';
  const f = new sb.FlowText(c, rnd);
  f.layout(w, h, k);

  const base = f.size;
  ok(Math.abs(f.speed - h / SL.crossSeconds) < 1e-6,
     tag + '基准速度 = 屏高 / crossSeconds（' + f.speed.toFixed(0) + ' px/s）');
  ok(f.items.length >= 5, tag + '首帧就预填 ' + f.items.length + ' 条（满屏，不用等飘上来）');
  ok(f.items.every(it => it.x >= 0 && it.x <= w), tag + '横向落点都在屏内');

  /* 长句子不许顶出屏幕：字号会被按宽度夹住。
     宽度一律用 flowtext.js 自己的估算函数，两边口径必须一致。 */
  const estW = sb.FlowText.estWidth;
  const probeW = new sb.FlowText(c, rnd);
  probeW.layout(w, h, k);
  probeW.items.length = 0;
  const wide = [];
  for (let i = 0; i < 200; i++) {
    const it = probeW._emit();
    wide.push(estW(it.text, it.size) / w);
  }
  ok(Math.max(...wide) <= SL.maxWidthRatio + 1e-6,
     tag + '最宽的文案占屏宽 ' + (Math.max(...wide) * 100).toFixed(0) + '%（上限 ' +
     (SL.maxWidthRatio * 100).toFixed(0) + '%）');

  const sizes = f.items.map(it => it.size);
  const sMin = Math.min(...sizes), sMax = Math.max(...sizes);
  ok(sMin >= base * SL.sizeMin - 1e-6 && sMax <= base * SL.sizeMax + 1e-6,
     tag + '字号都在 [' + (base * SL.sizeMin).toFixed(0) + ', ' + (base * SL.sizeMax).toFixed(0) + '] 内' +
     '（实测 ' + sMin.toFixed(0) + '~' + sMax.toFixed(0) + '）');
  ok(sMax / sMin > 1.2, tag + '字号有近大远小的差距（' + (sMax / sMin).toFixed(2) + ' 倍）');

  const spds = f.items.map(it => it.spd / f.speed);
  ok(spds.every(v => v === 1), tag + '所有文案速度完全一致（用户要的"往上走速度一样"）');

  /* 不许压字：任意两条的包围盒都不能相交（出生避让的验收）。
     宽度用 flowtext.js 的估算函数；高度按行高 1.24 字号算。 */
  function overlaps(fl) {
    let n = 0;
    for (let i = 0; i < fl.items.length; i++) {
      for (let j = i + 1; j < fl.items.length; j++) {
        const a = fl.items[i], b = fl.items[j];
        const hw = (estW(a.text, a.size) + estW(b.text, b.size)) * 0.5;
        const hh = (a.size + b.size) * 0.62;
        if (Math.abs(a.x - b.x) < hw && Math.abs(a.y - b.y) < hh) n++;
      }
    }
    return n;
  }
  ok(overlaps(f) === 0, tag + '首帧没有互相压字（重叠对数 ' + overlaps(f) + '）');

  const half = f.items.filter(it => it.y < h / 2).length;
  ok(half >= 2 && f.items.length - half >= 2,
     tag + '上下半屏都有文案（上半 ' + half + ' / 下半 ' + (f.items.length - half) + '），不是挤在一头');

  /* 跑 30 秒：条目数收敛、确有回收（否则就是泄漏） */
  for (let i = 0; i < 30 * 60; i++) f.update(1 / 60);
  const areaRatio = Math.min(2.2, Math.max(1, Math.sqrt(w * h / (390 * 844))));
  const want = SL.density * areaRatio;
  ok(f._free.length > 0, tag + '飘出屏幕的文案被回收进池（复用 ' + f._free.length + ' 个对象）');
  ok(f.items.length <= SL.maxItems, tag + '30s 后条目数 ' + f.items.length + ' 不超过上限 ' + SL.maxItems);
  ok(Math.abs(f.items.length - want) < want * 0.5,
     tag + '稳定在目标密度附近：' + f.items.length + ' ≈ ' + want.toFixed(1));
  ok(overlaps(f) === 0, tag + '同速下跑 30s 依然零压字（相对位置永不变）');
}

/* 9b. 出生位置：新发射的文案都落在"出生带"里（[视口高 × spawnTopRatio,
 *     屏幕下方一点点]），而不是凭空出现在屏幕上方 */
{
  const probe = new sb.FlowText(c, rnd);
  probe.layout(390, 844, 0.45);
  probe.items.length = 0;
  const ys = [];
  for (let i = 0; i < 200; i++) ys.push(probe._emit().y0);
  const lo = 844 * SL.spawnTopRatio, hi = 844 + 46 * SL.sizeMax * 2;
  ok(ys.every(v => v >= lo - 1e-6 && v <= hi + 1e-6),
     '出生高度都落在 [' + lo.toFixed(0) + ', ' + hi.toFixed(0) + ']（' +
     Math.min(...ys).toFixed(0) + '~' + Math.max(...ys).toFixed(0) + '）');
  ok(Math.max(...ys) - Math.min(...ys) > 20, '出生高度是随机的（' + (Math.max(...ys) - Math.min(...ys)).toFixed(0) + 'px 跨度）');
}

/* 9c. 淡入淡出：用像素距离度量，任何速度下比例一致 */
const probe = new sb.FlowText(c, rnd);
probe.layout(390, 844, 0.45);
ok(probe._alphaAt({ alpha: 1, travel: 0, y: 400 }) === 0, '刚出现时透明（淡入起点）');
ok(probe._alphaAt({ alpha: 1, travel: 0.12 * 844, y: 400 }) > 0.99, '淡入距离走完就满透明');
ok(probe._alphaAt({ alpha: 1, travel: 1e9, y: 0 }) === 0, '到屏幕顶透明（淡出终点）');
ok(probe._alphaAt({ alpha: 1, travel: 1e9, y: 0.16 * 844 }) > 0.99, '离开淡出区就满透明');
ok(Math.abs(probe._alphaAt({ alpha: 0.5, travel: 1e9, y: 1e9 }) - 0.5) < 1e-9, '远处小字按自身 alpha 压暗');

/* 9d. 取句：不连着重复，且长跑能覆盖整池。
 *     这里直接连抽 400 次，所以先把屏上清空（否则出生带挤满会拒绝发射）。 */
const probe2 = new sb.FlowText(c, rnd);
probe2.layout(390, 844, 0.45);
probe2.items.length = 0;
probe2.live = probe2.live.map(() => 0);
const seen = [];
for (let i = 0; i < 400; i++) seen.push(probe2._emit().text);
let twice = false;
for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) twice = true;
ok(!twice, '连续两次不会抽到同一句（随机且有信息量）');
ok(new Set(seen).size === SL.pool.length,
   '长跑覆盖整个文案池（' + new Set(seen).size + '/' + SL.pool.length + '）');

/* 9e. 取句的"优先给没出现过的"：池子比屏上条数多时，同屏不应该出现重复句 */
const big = JSON.parse(JSON.stringify(c));
big.text.scroll.pool = Array.from({ length: 40 }, (_, i) => '测试文案第' + i + '句');
const probe3 = new sb.FlowText(big, sb.MoonfestRandom(7));
probe3.layout(390, 844, 0.45);
const onScreenTexts = probe3.items.map(it => it.text);
ok(new Set(onScreenTexts).size === onScreenTexts.length,
   '池子够大时同屏无重复句（' + onScreenTexts.length + ' 条 / ' +
   new Set(onScreenTexts).size + ' 种不同句子）');


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

/* ==========================================================================
 * 12. 信：信息流飘满 flowSeconds 秒之后自动升起，整封一屏放得下
 * ======================================================================== */
ok(c.letter.enabled === true, '信默认启用');
ok(Math.abs(c.letter.flowSeconds - 9) < 1e-9,
   '信息流持续 ' + c.letter.flowSeconds + ' 秒（长长久久）');
ok(c.letter.flowFade > 0 && c.letter.flowFade < c.letter.flowSeconds,
   '淡出时长 ' + c.letter.flowFade + 's 落在信息流时长之内');
const letterChars = c.letter.body.join('').length + c.letter.greeting.length;
ok(letterChars > 100, '信正文 ' + letterChars + ' 字');

for (const [w, h] of [[390, 844], [360, 640], [1440, 900], [1920, 1080], [2560, 1440]]) {
  const tag = '视口 ' + w + 'x' + h + '：';
  const lt = new sb.Letter(c);
  lt.layout(w, h);
  const fit = lt._fitText(makeCtx());
  const innerH = lt.ph - lt.ph * c.letter.padY * 2;

  ok(lt.pw <= w && lt.ph <= h,
     tag + '信纸没超出屏幕（' + lt.pw.toFixed(0) + '×' + lt.ph.toFixed(0) + '）');
  ok(fit.h <= innerH + 1e-6,
     tag + '整封信一屏放得下（正文高 ' + fit.h.toFixed(0) + ' ≤ 可用 ' + innerH.toFixed(0) +
     '，自动排到 ' + fit.size + 'px）');
  ok(fit.size >= c.letter.minSize, tag + '字号 ' + fit.size + 'px 不算小');
  ok(fit.lines.filter(l => l.kind === 'body').length >= 6,
     tag + '正文排了 ' + fit.lines.filter(l => l.kind === 'body').length + ' 行');
  ok(fit.lines[0].kind === 'seal' || fit.lines[0].kind === 'greeting',
     tag + '第一行是封记或称呼');
}

/* 13. 信的升起动画与绘制 */
const lc = { fill: 0, stroke: 0, text: [], fillRect: 0 };
const letterCtx = makeCtx(lc, lc.text);
const lt2 = new sb.Letter(c);
lt2.layout(390, 844);
ok(lt2.active === false, '信一开始不出场（要等信息流飘满）');
let letterOk = true;
try {
  lt2.start();
  lt2.update(c.letter.duration * 0.35);
  lt2.render(letterCtx);                       /* 升到一半 */
  lt2.update(99);
  lt2.render(letterCtx);                       /* 停稳 */
} catch (e) { letterOk = false; console.log('  信渲染抛错: ' + e.message); }
ok(letterOk, '信升起全程渲染无异常（半途 / 停稳）');
ok(lt2.done === true && lt2.progress === 1, '升起动画能走到完成');
ok(lc.text.indexOf(c.letter.greeting) >= 0, '称呼被绘制');
ok(c.letter.body.every(p => lc.text.join('').replace(/\s/g, '').indexOf(p.slice(0, 8)) >= 0),
   '两段正文都被绘制');

/* 结尾那行"注"：要真的画出来，而且断行不能把 emoji 的代理对劈开
   （劈开会量错宽度、行尾顶出信纸，屏幕上还会出现半个方块） */
{
  const LL = c.letter;
  ok(!!LL.note, '信的结尾有注：' + LL.note);
  ok(lc.text.join('').indexOf(LL.note.slice(0, 4)) >= 0, '注被绘制');
  const fit = new sb.Letter(c);
  fit.layout(390, 844);
  const laid = fit._fitText(makeCtx());
  const noteLines = laid.lines.filter(l => l.kind === 'note').map(l => l.text);
  ok(noteLines.length > 0, '注排了 ' + noteLines.length + ' 行');
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const allText = laid.lines.map(l => l.text).join('') + noteLines.join('');
  ok(!lone.test(allText), '断行没有把一个 emoji 的代理对劈成两半');
  ok(noteLines.join('').indexOf('😘') >= 0, '注里的 emoji 完整保留');
  ok(laid.size < LL.maxSize, '加了注之后字号自动缩到 ' + laid.size + 'px，整封仍一屏');
}
ok(lt2._bmp && lt2._bmp.width > 0 && lt2._bmp.height > 0,
   '信纸缓存位图已生成（' + lt2._bmp.width + '×' + lt2._bmp.height + '，按 2 倍分辨率）');
ok((lc.image || 0) > 0, '信纸用了缓存位图（drawImage ' + (lc.image || 0) + ' 次），不是每帧重新做模糊');

/* 14. 端到端（时间轴）：?t=12 应该已经翻到信，而且信息流已经淡完 */
{
  const cnt = { fill: 0, fillText: 0, arc: 0, stroke: 0 };
  const shown = [];
  const s3 = makeSandbox('?t=12', cnt, shown);
  ok(shown.indexOf(s3.MOONFEST.letter.greeting) >= 0,
     '?t=12（信息流 9s + 信 2s 之后）画面里已经有信');
  ok(cnt.fillText > 0, '此帧确实画了字（' + cnt.fillText + ' 次 fillText）');
  ok(s3.__moonfest.flow.dim === 0, '此时信息流已经完全淡出（dim=0），不用再算它了');
}

console.log(fail === 0 ? '\n全部通过 (' + 0 + ' 失败)' : '\n失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
