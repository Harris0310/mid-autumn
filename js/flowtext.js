/* ============================================================================
 * flowtext.js —— 流动的字
 *
 * 效果：多句文案随机抽取，一行一行自下而上匀速滚动（字幕式），粉色。
 *
 * 【为什么"速度一致"反而要做出不规律】
 *   每一行新出现的位置，是在上一行下方 gapMin~gapMax 倍字号之间的一个
 *   随机距离 —— 所以屏幕上的疏密是乱的，出现时间也乱，这就是视觉上的
 *   不规律感。
 *   但所有行速度完全一致，于是任意两行的相对间距一旦定下就永不改变：
 *   这种不规律会原封不动地一路保持到顶，绝不会互相追上或重叠。
 *   而间距又是在一个区间内随机取值，总体文字量依然稳定。
 *
 * 【坐标系】用视口坐标（1 单位 = 1 CSS 像素）而不是设计坐标：
 *   爱心按 contain 缩放，竖屏手机上设计框只占屏幕中间一半，字幕会被困在
 *   那条带子里。改成直接铺满整个视口高度，任何比例下都从上滚到下。
 * ========================================================================== */

(function (global) {
  'use strict';

  function FlowText(cfg, rnd) {
    this.cfg = cfg;
    this.rnd = rnd;
    this.sc = cfg.text.scroll;
    this.t = 0;
    this._last = -1;
    this.slots = [];
    this.nextY = 0;
    this.size = 0; this.speed = 0; this.top = 0;
    this.vh = 0; this.cx = 0;
    this.gapMin = 0; this.gapMax = 0;
  }

  /* 字号 = 设计字号 × 缩放比，但夹在 [视口高度 × minViewportRatio, maxSize]
     之间。竖屏手机上 k 只有 0.45，不夹的话字号会掉到 13px、屏上挤十几行。 */
  FlowText.prototype._scale = function (vh, k) {
    var sc = this.sc;
    var size = sc.size * k;
    var floor = vh * sc.minViewportRatio;
    if (floor > sc.maxSize) floor = sc.maxSize;
    if (size < floor) size = floor;
    if (size > sc.maxSize) size = sc.maxSize;
    return size;
  };

  /* 随机行距 —— 不规律感的来源 */
  FlowText.prototype._randGap = function () {
    return this.gapMin + this.rnd() * (this.gapMax - this.gapMin);
  };

  /* 随机取一句；避免与上一次完全相同 */
  FlowText.prototype._pick = function () {
    var pool = this.sc.pool;
    if (!pool || !pool.length) return '';
    if (pool.length === 1) return pool[0];
    var i = (this.rnd() * pool.length) | 0;
    if (i === this._last) i = (i + 1) % pool.length;
    this._last = i;
    return pool[i];
  };

  /* 每次视口变化时重排 */
  FlowText.prototype.layout = function (vw, vh, k, cx) {
    var sc = this.sc;
    this.cx = cx;
    this.vh = vh;
    this.size = this._scale(vh, k);
    this.speed = this.size * sc.speedRatio;
    this.gapMin = this.size * sc.gapMinRatio;
    this.gapMax = this.size * sc.gapMaxRatio;

    /* 上下各留两个行高的缓冲，淡入淡出不在屏幕边界上被切断 */
    this.top = -this.size * 2;

    /* 用随机间距从下往上铺满整条行程，开场就是满屏 */
    var y = this.top + (vh + this.size * 6);
    var slots = [];
    while (y > this.top && slots.length < 240) {
      slots.push({ y: y, text: this._pick(), phase: this.rnd() });
      y -= this._randGap();
    }
    if (!slots.length) slots.push({ y: this.top, text: this._pick(), phase: this.rnd() });

    this.slots = slots;
    /* 下一行的落点：始终在最下面那一行之下一个随机间距处 */
    this.nextY = slots[0].y + this._randGap();
  };

  FlowText.prototype.update = function (dt) {
    var sc = this.sc;
    if (!sc.enabled || !this.slots.length) return;
    this.t += dt;

    var move = this.speed * dt;
    for (var i = 0; i < this.slots.length; i++) {
      var s = this.slots[i];
      s.y -= move;
      if (s.y < this.top) {
        /* 从顶部出去的行直接落到底部下一个随机位置，并换一句新的。
           所有行速度一致，所以"随机间距"会被原样带上去。 */
        s.y = this.nextY;
        this.nextY += this._randGap();
        s.text = this._pick();
        s.phase = this.rnd();
      }
    }
  };

  /* 底部淡入 / 顶部淡出。行距不再固定，所以按屏幕边界来度量。 */
  FlowText.prototype._alphaAt = function (y) {
    var sc = this.sc;
    var finPx = this.vh * sc.fadeIn;
    var foutPx = this.vh * sc.fadeOut;

    var fin = finPx > 0 ? (this.vh - y) / finPx : 1;
    var fout = foutPx > 0 ? (y + foutPx) / foutPx : 1;
    if (fin > 1) fin = 1; else if (fin < 0) fin = 0;
    if (fout > 1) fout = 1; else if (fout < 0) fout = 0;

    return Math.min(fin, fout) * sc.alpha;
  };

  /* 粉色底 + 一道浅粉高光扫过（流光） */
  FlowText.prototype._sheen = function (ctx, x0, x1, phase) {
    var sc = this.sc;
    var g = ctx.createLinearGradient(x0, 0, x1, 0);
    var N = 20;
    var p = (this.t * sc.sheenSpeed + phase) % 1;
    if (p < 0) p += 1;

    var base = sc.color, hi = sc.highlight, wd = sc.sheenWidth;
    for (var i = 0; i <= N; i++) {
      var u = i / N;
      var d = u - p;
      d -= Math.round(d);                       /* 归一化到 [-0.5, 0.5] 的循环距离 */
      var k = Math.exp(-(d / wd) * (d / wd));   /* 高斯亮带 */
      g.addColorStop(u, 'rgb(' +
        Math.round(base[0] + (hi[0] - base[0]) * k) + ',' +
        Math.round(base[1] + (hi[1] - base[1]) * k) + ',' +
        Math.round(base[2] + (hi[2] - base[2]) * k) + ')');
    }
    return g;
  };

  /* 在视口坐标系下绘制（调用前 main.js 已把变换设成 CSS 像素） */
  FlowText.prototype.render = function (ctx) {
    var sc = this.sc;
    if (!sc.enabled || !this.slots.length) return;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = sc.font.replace('{size}', this.size.toFixed(2));
    ctx.shadowColor = sc.glow;
    ctx.shadowBlur = sc.glowBlur * (this.size / sc.size);

    for (var i = 0; i < this.slots.length; i++) {
      var s = this.slots[i];
      if (!s.text) continue;
      var a = this._alphaAt(s.y);
      if (a <= 0.01) continue;

      var w = ctx.measureText(s.text).width;
      ctx.globalAlpha = a;
      ctx.fillStyle = this._sheen(ctx, this.cx - w / 2, this.cx + w / 2, s.phase);
      ctx.fillText(s.text, this.cx, s.y);
    }

    ctx.restore();
  };

  global.FlowText = FlowText;
})(window);
