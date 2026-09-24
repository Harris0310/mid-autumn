/* ============================================================================
 * main.js —— 启动、视口适配与主循环
 *
 * 画面分两层，用两套变换：
 *   设计层（环境 + 爱心）  —— 在 config.design 里绘制，按 contain 等比缩放到
 *                             视口并居中，保证爱心在任何比例下都完整且不变形。
 *   视口层（流动的字）    —— 直接铺满整个视口高度，竖屏手机上字幕也能从上滚到
 *                             底，而不是被限制在设计框那一条带子里。
 *
 * 绘制顺序（自底向上）：氛围 -> 爱心 -> 流动的字。文字在爱心之上，
 * 保证粉色字幕压在深红粒子背景上依然清晰。
 *
 * 调试：URL 加 ?t=1.2 可把动画冻结在第 1.2 秒，方便抓静帧核对画面。
 * ========================================================================== */

(function () {
  'use strict';

  var cfg = window.MOONFEST;
  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');

  var rnd = window.MoonfestRandom(cfg.seed >>> 0);
  var heart = new window.HeartParticles(cfg);
  var flow = new window.FlowText(cfg, rnd);
  var ambient = new window.Ambient(cfg, rnd);

  var view = { dpr: 1, k: 1, ox: 0, oy: 0, w: 0, h: 0 };

  function resize() {
    var D = cfg.design;
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    /* 设计坐标等比缩放到视口，居中留边 */
    var k = Math.min(w / D.w, h / D.h) * D.fit;
    view.dpr = dpr; view.k = k; view.w = w; view.h = h;
    view.ox = (w - D.w * k) / 2;
    view.oy = (h - D.h * k) / 2;

    /* 字幕铺满视口；水平方向对齐爱心中线，视觉上才是一条轴 */
    flow.layout(w, h, k, view.ox + cfg.heart.cx * k);
  }

  function designTransform() {
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.k, view.k);
  }

  function draw(timeSec) {
    var H = cfg.heart;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    designTransform();
    ambient.render(ctx);

    /* 心跳 -> 绕心中心的等比缩放（节奏由 config.heart.beat.mode 决定） */
    var scale = window.HeartParticles.beatScale(timeSec, H.beat);
    heart.render(ctx, scale, timeSec);

    /* 视口层：1 单位 = 1 CSS 像素 */
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    flow.render(ctx);
  }

  /* ---------- 静帧模式：?t=秒 ---------- */
  var frozen = /[?&]t=([0-9.]+)/.exec(window.location.search);
  if (frozen) {
    var target = parseFloat(frozen[1]) || 0;
    resize();
    var acc = 0, step = 1 / 60;
    while (acc < target) {
      var d = Math.min(step, target - acc);
      flow.update(d);
      ambient.update(d);
      acc += d;
    }
    draw(target);
    window.addEventListener('resize', function () { resize(); draw(target); });
    return;
  }

  /* ---------- 正常动画 ---------- */
  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  if (reduce) {
    draw(0.12);   /* 尊重系统设置：只呈现一帧 */
    return;
  }

  var t0 = 0, last = 0;
  function frame(now) {
    if (!t0) { t0 = now; last = now; }
    var t = (now - t0) / 1000;
    var dt = Math.min(0.05, (now - last) / 1000);   /* 掉帧时钳制，避免字幕跳跃 */
    last = now;
    flow.update(dt);
    ambient.update(dt);
    draw(t);
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
})();
