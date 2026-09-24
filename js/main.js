/* ============================================================================
 * main.js —— 启动、视口适配、视角交互与主循环
 *
 * 画面分两层，用两套变换：
 *   设计层（环境 + 爱心）  —— 在 config.design 里绘制，按 contain 等比缩放到
 *                             视口并居中，保证爱心在任何比例下都完整且不变形。
 *                             爱心内部再自己做一遍 3D 旋转 + 透视。
 *   视口层（流动的字）    —— 直接铺满整个视口，文案才散得开、铺得满，
 *                             而不是被限制在设计框那一条带子里。
 *
 * 绘制顺序（自底向上）：氛围 -> 爱心 -> 流动的字。文字在爱心之上，
 * 保证粉色字幕压在深红粒子背景上依然清晰。
 *
 * 交互：手指 / 鼠标拖动可以上下左右转动爱心（上下 = 俯仰，左右 = 偏航），
 *       松手后有惯性，静止一会儿会自己缓慢左右摆动，暗示这是立体的。
 *
 * 调试：URL 加 ?t=1.2 可把动画冻结在第 1.2 秒，方便抓静帧核对画面。
 * ========================================================================== */

(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var cfg = window.MOONFEST;
  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');

  var rnd = window.MoonfestRandom(cfg.seed >>> 0);
  var heart = new window.HeartParticles(cfg);
  var flow = new window.FlowText(cfg, rnd);
  var ambient = new window.Ambient(cfg, rnd);
  var env = cfg.envelope.enabled ? new window.Envelope(cfg) : null;

  var view = { dpr: 1, k: 1, ox: 0, oy: 0, w: 0, h: 0 };

  /* 开发辅助：把关键对象挂到 window，方便 _dev/browsercheck.js 在真实浏览器里
     直接查状态。页面本身不依赖它，删掉也不影响运行。 */
  window.__moonfest = { flow: flow, heart: heart, ambient: ambient, view: view };

  /* ==========================================================================
   * 场景：envelope(等拆封) -> opening(拆封中) -> heart(主场景)
   * reveal 是主场景的显现进度，拆封过渡的后半段由它驱动
   * ======================================================================== */
  var scene = env ? 'envelope' : 'heart';
  var reveal = env ? 0 : 1;

  /* ==========================================================================
   * 视角状态
   * ======================================================================== */
  var O = cfg.orbit;
  var orbit = {
    pitch: 0, yaw: 0,      /* 用户拖出来的角度 */
    vpitch: 0, vyaw: 0,    /* 松手后的角速度（惯性） */
    dragging: false,
    lastX: 0, lastY: 0,
    idle: 0,               /* 距上次松手过了多少秒 */
    sway: 1                /* 静止摆动的权重：拖动时收到 0，空闲后慢慢回来 */
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* "抓住表面拖"的模型：
   *   往右拖 -> 正面被拖向右边，左侧转到前面来 -> yaw 增大
   *   往 下拖 -> 正面被拖向下方，顶面转到前面来 -> pitch 减小
   * （坐标系：x 右、y 下、z 朝观察者，见 heart.js） */
  function applyDrag(dx, dy) {
    var dyaw = dx * O.yawSensitivity * (O.invertYaw ? -1 : 1);
    var dpitch = -dy * O.pitchSensitivity * (O.invertPitch ? -1 : 1);

    orbit.yaw = clamp(orbit.yaw + dyaw, -O.maxYaw, O.maxYaw);
    orbit.pitch = clamp(orbit.pitch + dpitch, -O.maxPitch, O.maxPitch);

    /* 记下瞬时速度，松手后当惯性初速 */
    orbit.vyaw = dyaw;
    orbit.vpitch = dpitch;
  }

  function startDrag(e) {
    orbit.dragging = true;
    orbit.idle = 0;
    orbit.vyaw = 0;
    orbit.vpitch = 0;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
    if (canvas.setPointerCapture && e.pointerId !== undefined) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }
  }

  function moveDrag(e) {
    if (!orbit.dragging) return;
    applyDrag(e.clientX - orbit.lastX, e.clientY - orbit.lastY);
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
  }

  function endDrag() {
    if (!orbit.dragging) return;
    orbit.dragging = false;
    orbit.idle = 0;
  }

  /* 指针事件先看场景：还在信封上，点一下就是拆封 */
  function handleDown(e) {
    if (scene === 'envelope') {
      env.start();
      scene = 'opening';
      return;
    }
    if (scene === 'heart') startDrag(e);
  }
  function handleMove(e) {
    if (scene === 'heart') moveDrag(e);
  }
  function handleUp() {
    if (scene === 'heart') endDrag();
  }

  function bindOrbit() {
    if (!O.enabled || !canvas.addEventListener) return;

    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', handleDown);
      canvas.addEventListener('pointermove', handleMove);
      canvas.addEventListener('pointerup', handleUp);
      canvas.addEventListener('pointercancel', handleUp);
      return;
    }

    /* 兜底：部分较老的 WebView（比如某些安卓微信内核）没有 PointerEvent，
       退回 touch 事件，保证链接分享出去以后还是一样能拖着转。 */
    canvas.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) handleDown(e.touches[0]);
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      handleMove(e.touches[0]);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', handleUp);
    canvas.addEventListener('touchcancel', handleUp);
  }

  function updateOrbit(dt) {
    if (!O.enabled) return;

    if (!orbit.dragging) {
      /* 惯性：松手后继续转一会儿，再衰减停住 */
      if (orbit.vyaw || orbit.vpitch) {
        orbit.yaw = clamp(orbit.yaw + orbit.vyaw, -O.maxYaw, O.maxYaw);
        orbit.pitch = clamp(orbit.pitch + orbit.vpitch, -O.maxPitch, O.maxPitch);
        var damp = Math.pow(O.inertia, dt * 60);
        orbit.vyaw *= damp;
        orbit.vpitch *= damp;
        if (Math.abs(orbit.vyaw) < 1e-4) orbit.vyaw = 0;
        if (Math.abs(orbit.vpitch) < 1e-4) orbit.vpitch = 0;
      }
      orbit.idle += dt;
    }

    /* 静止摆动：拖动时收起，松手 idleSwayDelay 秒后缓慢恢复。
       作用只是让人一眼看出这是 3D，而不是一张平面图。 */
    var want = (!orbit.dragging && orbit.idle > O.idleSwayDelay) ? 1 : 0;
    orbit.sway += (want - orbit.sway) * Math.min(1, dt * 1.5);
  }

  function currentView(timeSec) {
    var sway = O.enabled
      ? O.idleSwayYaw * orbit.sway * Math.sin(TAU * timeSec / O.idleSwayPeriod)
      : 0;
    return { pitch: orbit.pitch, yaw: orbit.yaw + sway };
  }

  /* ==========================================================================
   * 视口适配
   * ======================================================================== */
  function resize() {
    var D = cfg.design;
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    var k = Math.min(w / D.w, h / D.h) * D.fit;
    view.dpr = dpr; view.k = k; view.w = w; view.h = h;
    view.ox = (w - D.w * k) / 2;
    view.oy = (h - D.h * k) / 2;

    flow.layout(w, h, k);
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

    /* 显现缓动：easeOutCubic */
    var e = reveal <= 0 ? 0 : (reveal >= 1 ? 1 : 1 - Math.pow(1 - reveal, 3));

    /* 还没显现时干脆不画爱心，省电（信封可能被盯很久才点） */
    if (e > 0) {
      var beat = window.HeartParticles.beatScale(timeSec, H.beat);
      heart.render(ctx, beat * (0.42 + 0.58 * e), timeSec, currentView(timeSec));
    }

    /* 视口层：1 单位 = 1 CSS 像素 */
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    flow.reveal = e;
    flow.render(ctx);

    /* 信封最后画，压在所有东西之上 */
    if (env && scene !== 'heart') {
      designTransform();
      env.render(ctx);
    }
  }

  /* 推进拆封进度 */
  function updateScene(dt) {
    if (!env) return;
    if (scene === 'envelope') {
      env.update(dt);                       /* 只推进入场与待机脉动 */
      return;
    }
    if (scene !== 'opening') return;

    env.update(dt);
    var E = cfg.envelope;
    var u = (env.progress - E.revealStart) / (1 - E.revealStart);
    reveal = u <= 0 ? 0 : (u >= 1 ? 1 : u);
    if (env.done) { scene = 'heart'; reveal = 1; }
  }

  /* ==========================================================================
   * 启动
   * ======================================================================== */
  bindOrbit();

  /* ---------- 静帧模式：?t=秒 ---------- */
  /* ?open=1 跳过信封直接进主场景；?t= 静帧模式同理 */
  var frozen = /[?&]t=([0-9.]+)/.exec(window.location.search);
  if (/[?&]open=1/.test(window.location.search)) { scene = 'heart'; reveal = 1; }
  if (frozen) {
    var target = parseFloat(frozen[1]) || 0;
    scene = 'heart'; reveal = 1;
    orbit.sway = 0;                 /* 静帧不要摆动，便于逐帧比对 */
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

  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  if (reduce) {
    orbit.sway = 0;                       /* 尊重系统设置：不自动摆动 */
    if (env) env.animateIdle = false;     /* 也不做待机呼吸与脉动 */
    draw(0.12);
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
    updateOrbit(dt);
    updateScene(dt);
    draw(t);
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
})();
