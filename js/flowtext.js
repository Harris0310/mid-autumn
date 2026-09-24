/* ============================================================================
 * flowtext.js —— 流动的字（满屏散点信息流）
 *
 * 效果：多句文案随机抽取，在屏幕的**随机位置、随机时刻**出现，带着随机字号
 *       （近大远小）向上飘，很快穿过屏幕并淡出 —— 粉色的信息流，满天都是。
 *
 * 【为什么不再是"一列字幕"】
 *   原来是一列居中、自下而上匀速滚。用户要的是「不要文案从一个位置出来，
 *   要从不同的位置、不同的时间出来，这样才有信息流的感觉」，并且单条文案
 *   约 1 秒就穿完一屏（≈ 原来的 10 倍速）。
 *   所以改成"发射器"模型：按固定速率不断随机发射一条文案，每条各自记住
 *   自己的字号 / 横向落点 / 生成高度 / 生命，飘出屏幕就被回收。
 *
 * 【不规律，但绝不压字】
 *   生成时刻（按速率均匀）、横向落点（全宽随机）、字号（近大远小）三处随机，
 *   所以同一眼看到的版式永远不一样；但**所有文案上升速度完全一致**
 *   （用户原话："往上走速度一样"），于是相对位置一旦定下就永不改变 ——
 *   空间上不规律，时间上却永远不会互相追上。
 *   再加一道出生避让：撒点若和屏上已有的文案撞上就换个位置，
 *   满屏撒字才不会糊成一团。
 *
 * 【慢/快只改一个数】
 *   crossSeconds = 一条文案从屏幕底穿到顶用几秒（默认 1.0）。
 *   淡入淡出、生成区间都按视口高度的**比例**算，所以调速度不会破坏观感比例；
 *   density 与速度解耦，调快不会顺带把屏幕塞满。
 *
 * 【坐标系】用视口坐标（1 单位 = 1 CSS 像素）而不是设计坐标：
 *   爱心按 contain 缩放，竖屏手机上设计框只占屏幕中间一半，文案会被困在
 *   那条带子里。改成直接铺满整个视口，任何比例下都是满屏信息流。
 * ========================================================================== */

(function (global) {
  'use strict';

  /* 发射时拿不到 ctx，只能估宽：CJK / 全角约 1em，其余（英文、数字）约 0.55em。
     只用来决定横向落点和渐变范围，真实绘制仍以 measureText 为准。 */
  function estWidth(text, size) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      w += text.charCodeAt(i) > 0x2e7f ? 1 : 0.55;
    }
    return w * size;
  }

  function FlowText(cfg, rnd) {
    this.cfg = cfg;
    this.rnd = rnd;
    this.sc = cfg.text.scroll;
    this.t = 0;
    this._last = -1;     /* 上一次抽中的句子下标，避免连着重复 */
    this.live = [];      /* 每句此刻在屏上出现几次（用于"优先给没出现过的"） */
    this.items = [];     /* 正在屏上飘的文案 */
    this._free = [];     /* 回收池：每秒要发射十几条，复用对象免掉 GC 抖动 */
    this._order = [];    /* 绘制顺序（按字号＝远近排），复用数组 */
    this._acc = 0;       /* 发射累加器（不足一条时留到下一帧） */
    this._spot = false;  /* 上一次找位置是否成功（见 _bestSpot / update） */
    this.vw = 0; this.vh = 0;
    this.size = 0;       /* 基准字号 */
    this.speed = 0;      /* 基准速度：crossSeconds 秒穿完一屏（像素/秒） */
    this.spawnRate = 0;  /* 每秒发射几条 */
    this.want = 0;       /* 屏上想同时看到的条数（已按视口大小放大） */
    this.fadeInPx = 0;   /* 淡入距离（像素） */
    this.fadeOutPx = 0;  /* 淡出距离（像素） */
    this.solid = '';     /* 关掉流光时用的纯色 */
    this._fonts = {};    /* 字号 -> 字体串缓存，键是量化后的字号 */
    this.reveal = 1;     /* 整体显现进度 0~1，由 main.js 在拆封过渡时驱动 */
    this.dim = 1;        /* 整体淡出（信升起前那几秒），1 = 全亮、0 = 已经看不见 */
  }

  /* 字号 = 设计字号 × 缩放比，但夹在 [视口高度 × minViewportRatio, maxSize]
     之间。竖屏手机上 k 只有 0.45，不夹的话字号会掉到 13px、屏上挤一大片。 */
  FlowText.prototype._scale = function (vh, k) {
    var sc = this.sc;
    var size = sc.size * k;
    var floor = vh * sc.minViewportRatio;
    if (floor > sc.maxSize) floor = sc.maxSize;
    if (size < floor) size = floor;
    if (size > sc.maxSize) size = sc.maxSize;
    return size;
  };

  /* 随机取一句的下标。
     优先挑"此刻屏上还没有的句子" —— 屏上同时撒着十几条，池子只有十句时
     重复是数学上不可避免的，但至少让它摊开，而不是同一句同时挂出好几条。
     池子里的句子比屏上条数多时，效果就是"每次出现的都是新句子"。 */
  FlowText.prototype._pick = function () {
    var pool = this.sc.pool;
    if (!pool || !pool.length) return -1;
    if (pool.length === 1) return 0;

    var free = null, i;
    for (i = 0; i < pool.length; i++) {
      if (!this.live[i] && i !== this._last) {
        if (!free) free = [];
        free.push(i);
      }
    }
    if (free) {
      this._last = free[(this.rnd() * free.length) | 0];
    } else {
      /* 池子太小、全都已在屏上：退一步，只要不是上一次那条就行 */
      i = (this.rnd() * pool.length) | 0;
      if (i === this._last) i = (i + 1) % pool.length;
      this._last = i;
    }
    return this._last;
  };

  FlowText.prototype._obtain = function () {
    return this._free.pop() || {
      text: '', pi: -1, x: 0, y: 0, y0: 0, size: 0, spd: 0,
      travel: 0, life: 0, maxLife: 0, phase: 0, alpha: 1,
      font: '', w: 0, grad: null, gq: -1, gw: -1
    };
  };

  /* 字号（已量化）-> 字体串。每条文案一辈子只换一次字体，
     不必每帧对每个字做一次 String.replace 再喂给 ctx.font。 */
  FlowText.prototype._font = function (size) {
    var key = size.toFixed(2);
    var hit = this._fonts[key];
    if (hit) return hit;
    var s = this.sc.font.replace('{size}', key);
    this._fonts[key] = s;
    return s;
  };

  /* 就地移除第 i 条（和末尾交换，避免数组搬移），对象回回收池 */
  FlowText.prototype._recycle = function (i) {
    var it = this.items[i];
    if (it.pi >= 0) this.live[it.pi]--;
    var last = this.items.pop();
    if (i < this.items.length) this.items[i] = last;
    if (this._free.length < 160) this._free.push(it);
  };

  /* 发射一条：随机字号（近大远小）、随机横向落点、随机生成高度，
     并避开屏上已有的文案（见 _bestSpot）。 */
  FlowText.prototype._emit = function () {
    var sc = this.sc, r = this.rnd;
    var it = this._obtain();
    it.pi = this._pick();
    it.text = it.pi >= 0 ? sc.pool[it.pi] : '';
    if (it.pi >= 0) this.live[it.pi]++;

    /* 字号随机 —— 参考图里字号差别很大，这是"有远有近"的主要来源。
       量化成 sizeSteps 档：字号完全连续的话，每条文案的字形都得重新栅格化，
       浏览器的字形缓存永远打不中（软件渲染下这是实打实的掉帧源）。 */
    var steps = sc.sizeSteps | 0;
    var n = r();
    if (steps > 1) n = ((n * steps) | 0) / (steps - 1);
    it.size = this.size * (sc.sizeMin + n * (sc.sizeMax - sc.sizeMin));
    it.alpha = sc.farAlpha + (1 - sc.farAlpha) * n;   /* 远处的字暗一点 */

    /* 长句子自动缩一点：字数多的句子按最大字号会顶满整个屏宽。
       代价是长句的字号区间被压低，但总比跑出屏幕外好。 */
    var unit = estWidth(it.text, 1);                  /* 每 1px 字号占多宽 */
    var cap = this.vw * sc.maxWidthRatio;
    if (unit > 0 && unit * it.size > cap) it.size = cap / unit;

    /* 速度全场一致（用户要的"往上走速度一样"）：
       于是相对位置永不改变，撒好的版式会原样保持到飘出屏幕。 */
    it.spd = this.speed;

    this._bestSpot(it);
    if (!this._spot) {                 /* 真的挤不下：这条先不发（见 update） */
      if (it.pi >= 0) this.live[it.pi]--;
      if (this._free.length < 160) this._free.push(it);
      return null;
    }

    /* 生命：刚好够它飘出屏幕顶，再多留一点当兜底（防止极端参数下卡住不回收） */
    it.maxLife = (it.y0 + it.size * 2) / it.spd * (1 + r() * 0.35);
    it.life = 0;
    it.travel = 0;
    it.phase = r();      /* 流光相位，让每条文案的高光各扫各的 */
    it.font = this._font(it.size);
    it.w = 0;            /* 首次绘制时量一次就记住（字体不会变） */
    it.grad = null;      /* 换了一句/换了位置，缓存的渐变作废 */
    return it;
  };

  /* 挑一个不撞车的位置：横向全宽随机、纵向在"出生带"内随机。
     满屏撒字很容易两句话压在一起（同一句还会看起来像重影），所以随机试
     placeTries 次，取最宽松的那个；一旦找到不重叠的就直接收工。
     一个都没让开就把 _spot 置 false —— 调用方会放弃这一条，等下一帧再试。
     这样"绝不压字"是结构上的保证，而不是靠调参调出来的。 */
  FlowText.prototype._bestSpot = function (it) {
    var sc = this.sc, r = this.rnd;
    var i, k, o, s, score;

    var half = estWidth(it.text, it.size) * 0.5;
    var lo = half * sc.edgeBleed, hi = this.vw - lo;
    if (lo > this.vw * 0.5) { lo = this.vw * 0.5; hi = lo; }

    var pad = it.size * sc.placePad;
    var halfH = it.size * 0.62 + pad;          /* 文案占的半高（行高约 1.24 字号）*/
    var top = this.vh * sc.spawnTopRatio;
    var bot = this.vh + it.size * 2;

    var bestX = 0, bestY = bot, best = -1;
    for (k = 0; k < sc.placeTries; k++) {
      var x = lo + r() * (hi - lo);
      var y = top + r() * (bot - top);
      score = 1e9;
      for (i = 0; i < this.items.length; i++) {
        o = this.items[i];
        /* 归一化距离：两个方向都 < 1 才算重叠，所以 max(dx,dy) >= 1 即已让开 */
        var dx = Math.abs(o.x - x) / (half + estWidth(o.text, o.size) * 0.5 + pad);
        var dy = Math.abs(o.y - y) / (halfH + o.size * 0.62 + pad);
        s = dx > dy ? dx : dy;
        if (s < score) score = s;
        if (score <= 0) break;
      }
      if (score > best) { best = score; bestX = x; bestY = y; }
      if (best >= 1) break;                    /* 已经让开了，不再试 */
    }

    this._spot = best >= 1;
    if (!this._spot) return;
    it.x = bestX;
    it.y0 = bestY;
    it.y = bestY;
  };

  /* 视口变化时重排 */
  FlowText.prototype.layout = function (vw, vh, k) {
    var sc = this.sc;
    this.vw = vw; this.vh = vh;
    this._fonts = {};
    this.size = this._scale(vh, k);
    this.speed = vh / Math.max(0.05, sc.crossSeconds);
    this.fadeInPx = vh * sc.fadeIn;
    this.fadeOutPx = vh * sc.fadeOut;
    this.solid = 'rgb(' + sc.color[0] + ',' + sc.color[1] + ',' + sc.color[2] + ')';

    /* 屏上同时几条。以手机视口（390×844）为基准，大屏按面积开方放大并夹住，
       这样电脑上全屏看也不会稀稀拉拉。 */
    var areaRatio = Math.sqrt((vw * vh) / (390 * 844));
    if (!(areaRatio > 1)) areaRatio = 1;
    if (areaRatio > 2.2) areaRatio = 2.2;
    this.want = sc.density * areaRatio;

    /* 发射速率由"屏上想同时看到几条"反推：
       meanLife ≈ 生成高度飘到屏幕顶要走的路程 / 基准速度。 */
    var bandMid = (vh * sc.spawnTopRatio + vh + this.size * 2) * 0.5;
    var meanLife = (bandMid + this.size * 2) / this.speed;
    if (!(meanLife > 0.12)) meanLife = 0.12;
    this.spawnRate = this.want / meanLife;

    /* 重排：先清空，再**空跑**一段让屏幕自然填满。
       直接"撒"一批固定的文案不行 —— 密度分布是假的，还会互相压字；
       照真实规则跑 1.6 屏时间，开场（以及拆封显形那一刻）就是稳定态。 */
    for (var i = 0; i < this.items.length; i++) this._free.push(this.items[i]);
    this.items.length = 0;
    this.live = [];
    for (var L = 0; L < (sc.pool ? sc.pool.length : 0); L++) this.live.push(0);
    this._acc = 0;
    this.t = 0;

    var warm = Math.ceil(sc.crossSeconds * 1.6 * 60);
    for (var j = 0; j < warm; j++) this.update(1 / 60);
    this.t = 0;
  };

  FlowText.prototype.update = function (dt) {
    var sc = this.sc;
    if (!sc.enabled) return;
    this.t += dt;

    /* 发射：按速率匀速发，与速度解耦 —— 想更密只调 density。
       挤不下（出生带被占满）就先不发，把额度留在累加器里下一帧再试：
       于是屏上条数会自动收敛到"塞得下的最大值"，且永不压字。 */
    this._acc += dt * this.spawnRate;
    if (this._acc > 4) this._acc = 4;            /* 别把欠账攒成爆发 */
    while (this._acc >= 1 && this.items.length < sc.maxItems) {
      var born = this._emit();
      if (!born) break;
      this.items.push(born);
      this._acc -= 1;
    }

    /* 推进：全场同速（"往上走速度一样"），飘出屏幕顶或活过 maxLife 就回收 */
    for (var i = this.items.length - 1; i >= 0; i--) {
      var it = this.items[i];
      var d = it.spd * dt;
      it.y -= d;
      it.travel += d;
      it.life += dt;
      if (it.y < -it.size * 2 || it.life > it.maxLife) this._recycle(i);
    }
  };

  /* 透明度：按"已飘过的距离"淡入、按"离屏幕顶的距离"淡出。
     两处都用像素距离而不是生命比例 —— 任何速度下观感比例都一致。 */
  FlowText.prototype._alphaAt = function (it) {
    var a = it.alpha;                 /* 远处（小字）本来就暗一点 */
    var k;
    if (this.fadeInPx > 0) {
      k = it.travel / this.fadeInPx;
      if (k < 1) a *= k > 0 ? k : 0;
    }
    if (this.fadeOutPx > 0) {
      k = it.y / this.fadeOutPx;
      if (k < 1) a *= k > 0 ? k : 0;
    }
    return a > 0 ? a : 0;
  };

  /* 粉色底 + 一道浅粉高光扫过（流光）。
     一条文案的字体、落点都是固定的，所以渐变**只随相位变**：把相位量化成
     sheenSteps 档并缓存，绝大多数帧直接复用上一帧的渐变对象 ——
     省掉每帧每条十几次 addColorStop 和十几个颜色字符串（那正是 GC 抖动、
     也就是偶发长帧的来源）。 */
  FlowText.prototype._sheen = function (ctx, it, w) {
    var sc = this.sc;
    var p = (this.t * sc.sheenSpeed + it.phase) % 1;
    if (p < 0) p += 1;

    var steps = sc.sheenSteps | 0;
    var q = steps > 0 ? (p * steps) | 0 : -1;
    if (it.grad && it.gq === q && it.gw === w) return it.grad;
    var pq = steps > 0 ? (q + 0.5) / steps : p;   /* 用档中心，缓存与画面一致 */

    var g = ctx.createLinearGradient(it.x - w / 2, 0, it.x + w / 2, 0);
    var N = sc.sheenStops || 12;
    var base = sc.color, hi = sc.highlight, wd = sc.sheenWidth;
    for (var i = 0; i <= N; i++) {
      var u = i / N;
      var d = u - pq;
      d -= Math.round(d);                       /* 归一化到 [-0.5, 0.5] 的循环距离 */
      var k = Math.exp(-(d / wd) * (d / wd));   /* 高斯亮带 */
      g.addColorStop(u, 'rgb(' +
        Math.round(base[0] + (hi[0] - base[0]) * k) + ',' +
        Math.round(base[1] + (hi[1] - base[1]) * k) + ',' +
        Math.round(base[2] + (hi[2] - base[2]) * k) + ')');
    }

    it.grad = g; it.gq = q; it.gw = w;
    return g;
  };

  /* 在视口坐标系下绘制（调用前 main.js 已把变换设成 CSS 像素） */
  FlowText.prototype.render = function (ctx) {
    var sc = this.sc;
    if (!sc.enabled || !this.items.length || this.reveal <= 0.01 || this.dim <= 0.01) return;

    /* 从小到大画：大字（近）压在小字（远）之上，纵深才成立 */
    var order = this._order;
    order.length = 0;
    for (var i = 0; i < this.items.length; i++) order.push(this.items[i]);
    order.sort(function (a, b) { return a.size - b.size; });

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = sc.glow;

    for (var j = 0; j < order.length; j++) {
      var it = order[j];
      var a = this._alphaAt(it);
      if (a <= 0.01) continue;

      ctx.font = it.font;
      if (!it.w) it.w = ctx.measureText(it.text).width;   /* 量一次就记住 */
      var w = it.w;
      ctx.globalAlpha = a * this.reveal * this.dim;
      /* 发光只给够大的字：小字本来就被压暗了，给它糊一圈光晕既看不出来
         又最费性能（软件渲染下逐个字形做高斯模糊是大头）。 */
      ctx.shadowBlur = it.size >= this.size * sc.glowMinMul ? sc.glowBlur * (it.size / sc.size) : 0;
      ctx.fillStyle = sc.sheen ? this._sheen(ctx, it, w) : this.solid;
      ctx.fillText(it.text, it.x, it.y);
    }

    ctx.restore();
  };

  /* 估宽函数挂到构造器上：_dev/check.js 的"压字"断言要跟实现用同一套算法，
     否则两边各估各的，测出来的重叠是假的（英文按全角算会宽出八成）。 */
  FlowText.estWidth = estWidth;

  global.FlowText = FlowText;
})(window);
