/* ============================================================================
 * flowtext.js —— 流动的字
 *
 * 效果：多句文案随机抽取，一行一行自下而上匀速滚动（字幕式），粉色。
 *
 * 【为什么用固定槽位，而不是"定时生成 + 回收"】
 *   所有槽位共享同一个速度，彼此的垂直间距恒等于 gap；槽位移出顶部时不是
 *   销毁，而是整段 +span 回到最底部并换一句。于是屏上的文字总量恒定
 *   （这就是「输出量都差不多」）—— 句子长短只会影响横向宽度，不会让文字
 *   忽多忽少，也不会出现重叠或空档。
 *
 * 【为什么用视口坐标系而不是设计坐标系】
 *   爱心按 contain 缩放，在竖屏手机上设计框只占屏幕中间一半，字幕会被困在
 *   那条带子里。字幕改为直接铺满整个视口高度，任何比例下都从上滚到下。
 *   字号/行距/速度按同一个 k 缩放，所以和爱心的比例关系保持不变。
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
    this.size = 0; this.gap = 0; this.speed = 0;
    this.top = 0; this.span = 0; this.count = 0;
    this.cx = 0;
  }

  /* 每次视口变化时重排：k 是设计坐标 -> CSS 像素的缩放比。
     字号不直接取 sc.size * k —— 竖屏手机上 k 只有 0.45，那样字号会掉到
     13px 左右、屏上挤十几行。这里把字号夹到 [视口高度 × minViewportRatio,
     maxSize]，行距与速度随之按比例推导，于是"同时可见几行"在任何屏幕上
     都是常数。 */
  FlowText.prototype._scale = function (vh, k) {
    var sc = this.sc;
    var size = sc.size * k;
    var floor = vh * sc.minViewportRatio;
    if (floor > sc.maxSize) floor = sc.maxSize;
    if (size < floor) size = floor;
    if (size > sc.maxSize) size = sc.maxSize;
    return size;
  };

  FlowText.prototype.layout = function (vw, vh, k, cx) {
    var sc = this.sc;
    this.cx = cx;
    this.size = this._scale(vh, k);
    this.gap = this.size * sc.gapRatio;
    this.speed = this.size * sc.speedRatio;

    /* 上下各留两个行高的缓冲，保证淡入淡出不在屏幕边界上被切断 */
    this.top = -this.size * 2;
    var need = vh + this.size * 4;
    var n = Math.max(1, Math.ceil(need / this.gap));
    this.span = n * this.gap;   /* 取整到 gap 的整数倍，间距永不漂移 */
    this.count = n;

    this.slots = [];
    for (var i = 0; i < n; i++) {
      this.slots.push({
        /* 开场就均匀铺满整条行程，而不是从底部一行行慢慢爬上来 */
        y: this.top + this.span - i * this.gap,
        text: this._pick(),
        phase: this.rnd()
      });
    }
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

  FlowText.prototype.update = function (dt) {
    var sc = this.sc;
    if (!sc.enabled || !this.slots.length) return;
    this.t += dt;

    var move = this.speed * dt;
    for (var i = 0; i < this.slots.length; i++) {
      var s = this.slots[i];
      s.y -= move;
      if (s.y < this.top) {
        s.y += this.span;        /* 回到最底部，间距保持不变 */
        s.text = this._pick();   /* 换一句新的 */
        s.phase = this.rnd();
      }
    }
  };

  /* 底部淡入 / 顶部淡出：u=0 在顶部，u=1 在底部 */
  FlowText.prototype._alphaAt = function (y) {
    var sc = this.sc;
    var u = (y - this.top) / this.span;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    var fin  = Math.min(1, (1 - u) / sc.fadeIn);
    var fout = Math.min(1, u / sc.fadeOut);
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
