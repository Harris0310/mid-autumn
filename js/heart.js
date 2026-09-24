/* ============================================================================
 * heart.js —— 镂空跳动爱心 · Canvas 2D 粒子引擎
 *
 * 移植自参考实现：
 *   D:\dev\code\C code\heart\heart_particle.cpp   粒子质感（径向密度剖面、配色比例）
 *   D:\dev\code\C code\heart\heart_beat.cpp       双脉冲心跳的时间轴
 *
 * 与 C++ 版的三点差异（都是 Web 适配，不是算法改动）：
 *
 *   1. 坐标全部写在「设计坐标系」(config.design) 里，由 main.js 统一缩放到视口，
 *      所以 HEART_CX / IMAGE_ENLARGE 这些魔数可以原样沿用。
 *
 *   2. 径向密度 s 改用「自形心的射线归一化」：
 *          s = |p - 形心| / R(θ)      R(θ) = 形心沿 θ 方向到轮廓的距离
 *      C++ 版按行跨度归一化（s_x 与 s_y 取较大者），在顶部裂口和底部心尖处
 *      会把同一条等密度线压成不规则形状；射线归一化让「镂空环」严格贴合
 *      心形轮廓，中空区域也更干净。
 *
 *   3. 跳动本身是「绕心中心的等比缩放」，所以把粒子按 (颜色档, 半径, 透明度)
 *      预先分桶，每帧只提交约 200 条静态 Path，再由一个缩放矩阵完成心跳。
 *      每帧几乎没有 JS 计算量，且缩放发生在光栅化阶段，粒子边缘依然锐利。
 * ========================================================================== */

(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  /* ---------- 确定性随机：同一 seed 得到同一颗心 ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 心跳节奏 ----------
   * classic：原版 heart.cpp 的匀强正弦 ratio = 15·sin(frame·0.1)。
   *   原版 50fps（Sleep(20)）下 0.1·frame = 5·t，所以 ω = 5 rad/s、
   *   周期 2π/5 ≈ 1.2566 秒，且正负对称、中间不停顿 —— 这就是"有力量感"
   *   的来源：等幅、持续、一下一下很实。原版的力场位移
   *       |d| = ratio / r^0.04
   *   在 r 从 50 到 340 之间几乎是常数（12~14px），换算下来就是整体
   *   约 ±5% 的等比缩放，所以这里直接用一个等比系数表达，完全等价。
   *
   * pulse：仿真心音的双脉冲（强搏动 + 弱搏动 + 舒张期），更写实但力量感弱。 */
  function smoothstep(x) { return x * x * (3 - 2 * x); }

  function pulse(t, s, e, k) {
    if (t < s || t > e) return 0;
    return k * Math.sin(smoothstep((t - s) / (e - s)) * Math.PI);
  }

  /* 双脉冲在一个周期内的相位，范围约 [-0.55, +1.0]（正=扩张）。
     刻意不用连续的 -cos(2πt) 基础项 —— 它会在第一声强搏动发生时正好落在
     波谷把强脉冲抵消掉，导致第二声弱搏动反而更明显，与真实心音强弱相反。 */
  function pulsePhase(t, B) {
    var bump = pulse(t, B.lub[0], B.lub[1], 1.00)
             + pulse(t, B.dub[0], B.dub[1], 0.52);
    var relax;
    if (t > 0.46)      relax = -0.55 * Math.sin((t - 0.46) / 0.54 * Math.PI);
    else if (t < 0.03) relax = -0.20;   /* 周期起点的收缩末基线 */
    else               relax = 0;
    return bump + relax;
  }

  /* 绕心中心的等比缩放系数：1 = 静息，>1 扩张，<1 收缩 */
  function beatScale(timeSec, B) {
    if (B.mode === 'classic') {
      return 1 + B.amplitude * Math.sin((2 * Math.PI / B.period) * timeSec);
    }
    var u = ((timeSec / B.pulsePeriod) % 1 + 1) % 1;
    return 1 + B.pulseAmplitude * pulsePhase(u, B);
  }

  /* ==========================================================================
   * HeartParticles
   * ======================================================================== */
  function HeartParticles(cfg) {
    this.cfg = cfg;
    this.H = cfg.heart;
    this.rnd = mulberry32(cfg.seed >>> 0);

    this.poly = this._buildOutline();     /* 单位心形 -> 屏幕方向 */
    this.rows = this._buildRowTable();    /* 逐行横区间表（保住顶部裂口） */
    this.rad  = this._buildRadialTable(); /* 形心 + R(θ) 查表 */

    this._buildParticles();
  }

  /* 单位心形参数方程（y 向上） */
  HeartParticles.prototype._heartPos = function (t) {
    var s = Math.sin(t), c = Math.cos(t);
    return [
      16 * s * s * s,
      13 * c - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    ];
  };

  /* 屏幕方向：横向拉伸 + y 翻转，使心尖朝下 */
  HeartParticles.prototype._buildOutline = function () {
    var N = 1440, SX = this.H.stretchX;
    var p = new Float64Array(N * 2);
    for (var i = 0; i < N; i++) {
      var h = this._heartPos(i / N * TAU);
      p[i * 2]     = h[0] * SX;
      p[i * 2 + 1] = -h[1];
    }
    return p;
  };

  /* 逐行横区间表：心形顶部同一 y 会有两个分离区间，必须全部保留，
     否则用 min/max 合并会把顶部裂口填死。 */
  HeartParticles.prototype._buildRowTable = function () {
    var poly = this.poly, N = poly.length / 2, DY = 0.02, i, k;
    var px = new Float64Array(N), py = new Float64Array(N);
    for (i = 0; i < N; i++) { px[i] = poly[i * 2]; py[i] = poly[i * 2 + 1]; }

    var ymin = py[0], ymax = py[0];
    for (i = 1; i < N; i++) {
      if (py[i] < ymin) ymin = py[i];
      if (py[i] > ymax) ymax = py[i];
    }

    var steps = Math.floor((ymax - ymin) / DY) + 1;
    var rows = new Array(steps);

    for (i = 0; i < steps; i++) {
      var y = ymin + i * DY, xs = [], j = N - 1;
      for (k = 0; k < N; k++) {
        if ((py[k] > y) !== (py[j] > y)) {
          xs.push((px[j] - px[k]) * (y - py[k]) / (py[j] - py[k]) + px[k]);
        }
        j = k;
      }
      xs.sort(function (a, b) { return a - b; });

      var segs = null;
      for (var a = 0; a + 1 < xs.length; a += 2) {
        if (xs[a + 1] - xs[a] > 1e-6) {
          if (!segs) segs = [];
          segs.push([xs[a], xs[a + 1]]);
        }
      }
      rows[i] = segs;
    }

    return { y0: ymin, dy: DY, rows: rows, ymin: ymin, ymax: ymax };
  };

  /* R(θ)：自形心沿 θ 方向到轮廓的最大距离。用它把任意内点归一化成
     s ∈ [0,1]，s=1 恰好落在轮廓上，于是密度剖面可以直接当成"环"来用。 */
  HeartParticles.prototype._buildRadialTable = function () {
    var poly = this.poly, n = poly.length / 2, i, j;

    /* 面积形心 */
    var a = 0, ccx = 0, ccy = 0;
    for (i = 0; i < n; i++) {
      var x0 = poly[i * 2], y0 = poly[i * 2 + 1];
      j = (i + 1) % n;
      var x1 = poly[j * 2], y1 = poly[j * 2 + 1];
      var cr = x0 * y1 - x1 * y0;
      a += cr; ccx += (x0 + x1) * cr; ccy += (y0 + y1) * cr;
    }
    a *= 0.5; ccx /= (6 * a); ccy /= (6 * a);

    var M = 720, R = new Float64Array(M);
    for (var m = 0; m < M; m++) {
      var th = m / M * TAU, dx = Math.cos(th), dy = Math.sin(th), best = 0;
      for (i = 0; i < n; i++) {
        j = (i + 1) % n;
        var ax = poly[i * 2], ay = poly[i * 2 + 1];
        var ex = poly[j * 2] - ax, ey = poly[j * 2 + 1] - ay;
        var den = dx * ey - dy * ex;
        if (den === 0) continue;
        var wx = ax - ccx, wy = ay - ccy;
        var tt = (wx * ey - wy * ex) / den;   /* 射线参数 */
        var uu = (wx * dy - wy * dx) / den;   /* 线段参数 */
        if (tt > best && uu >= 0 && uu <= 1) best = tt;
      }
      R[m] = best > 0 ? best : 1e-6;
    }

    return { cx: ccx, cy: ccy, M: M, R: R };
  };

  HeartParticles.prototype._frac = function (x, y) {
    var rd = this.rad;
    var dx = x - rd.cx, dy = y - rd.cy;
    var r = Math.sqrt(dx * dx + dy * dy);
    if (r < 1e-9) return 0;
    var th = Math.atan2(dy, dx);
    if (th < 0) th += TAU;
    var f = th / TAU * rd.M;
    var i0 = Math.floor(f), fr = f - i0;
    i0 %= rd.M;
    var i1 = (i0 + 1) % rd.M;
    var rr = rd.R[i0] * (1 - fr) + rd.R[i1] * fr;
    return rr > 1e-9 ? Math.min(1, r / rr) : 0;
  };

  /* 密度剖面的线性插值 */
  HeartParticles.prototype._weightAt = function (s) {
    var P = this.H.profile, S = P.s, W = P.w;
    if (s <= S[0]) return W[0];
    for (var i = 0; i < S.length - 1; i++) {
      if (s >= S[i] && s <= S[i + 1]) {
        var span = S[i + 1] - S[i];
        var k = span > 0 ? (s - S[i]) / span : 0;
        return W[i] * (1 - k) + W[i + 1] * k;
      }
    }
    return W[W.length - 1];
  };

  HeartParticles.prototype._rowSegs = function (y) {
    var R = this.rows;
    var i = Math.floor((y - R.y0) / R.dy);
    if (i < 0 || i >= R.rows.length) return null;
    return R.rows[i];
  };

  /* 配色：粉白 0.2% / 亮红 1.8% / 中红 12.4% / 深红 85.6%（实测比例） */
  HeartParticles.prototype._color = function (k) {
    var st = this.H.colorStops, r = this.rnd(), R, G, B;
    if (r < st[0]) {
      R = 228 + (this.rnd() * 28 | 0); G = 150 + (this.rnd() * 46 | 0); B = 158 + (this.rnd() * 48 | 0);
    } else if (r < st[1]) {
      R = 208 + (this.rnd() * 40 | 0); G = 100 + (this.rnd() * 55 | 0); B = 106 + (this.rnd() * 58 | 0);
    } else if (r < st[2]) {
      R = 150 + (this.rnd() * 56 | 0); G = 58 + (this.rnd() * 50 | 0); B = 62 + (this.rnd() * 52 | 0);
    } else {
      R = 76 + (this.rnd() * 76 | 0); G = 6 + (this.rnd() * 30 | 0); B = 10 + (this.rnd() * 32 | 0);
    }
    if (k !== 1) {
      R = Math.min(255, R * k | 0);
      G = Math.min(255, G * k | 0);
      B = Math.min(255, B * k | 0);
    }
    return [R, G, B];
  };

  /* 以 1px 细颗粒为主，少量 2~3px 亮点 */
  HeartParticles.prototype._radius = function () {
    var r = this.rnd() * 100 | 0;
    return r < 86 ? 1 : (r < 97 ? 2 : 3);
  };

  /* 半厚度剖面 T(s) = thickness · √(1 − s²)：中心最厚、轮廓收到 0。
     于是正面看仍是原来那颗镂空的心，转起来才是一颗立体的中空心形。 */
  HeartParticles.prototype._thick = function (s) {
    var t = 1 - s * s;
    return t > 0 ? this.H.depth.thickness * Math.sqrt(t) : 0;
  };

  /* 壳层取点：一半落正面、一半落背面，再乘一点厚度抖动，
     避免正反两层薄成一张"纸片"。 */
  HeartParticles.prototype._shellZ = function (s) {
    var T = this._thick(s);
    if (T <= 0) return 0;
    var dir = this.rnd() < 0.5 ? 1 : -1;
    return dir * T * (1 + (this.rnd() - 0.5) * 2 * this.H.depth.shellJitter);
  };

  HeartParticles.prototype._mk = function (x, y, z, c, a, flash) {
    return {
      x: x, y: y, z: z, r: this._radius(), c: c, a: a,
      flash: !!flash,
      flashSpd: 1.6 + this.rnd() * 2.6,
      flashPh: this.rnd() * TAU
    };
  };

  /* -------- 主体浓密层：按实测径向剖面布点 --------
     关键：按「行区间」均匀布点，而不是「沿轮廓点向内缩放」。
     后者在 s→0 时会把所有角度映射到同一点，在中心轴堆成一条亮竖线。 */
  HeartParticles.prototype._genBody = function (count) {
    var H = this.H, R = this.rows, out = [], i;
    var wmax = 0;
    for (i = 0; i < H.profile.w.length; i++) if (H.profile.w[i] > wmax) wmax = H.profile.w[i];

    var guard = 0, limit = count * 60;
    while (out.length < count && guard++ < limit) {
      var uy = R.ymin + this.rnd() * (R.ymax - R.ymin);
      var segs = this._rowSegs(uy);
      if (!segs) continue;

      var tot = 0;
      for (i = 0; i < segs.length; i++) tot += segs[i][1] - segs[i][0];
      if (tot <= 0) continue;

      /* 心尖处该行跨度趋于 0，逐步降低接受率，避免粒子堆成孤立团块 */
      var tipFade = 1;
      if (tot < 4.0) tipFade = (tot - 0.6) / 3.4;
      if (tipFade <= 0) continue;

      /* 按区间宽度加权选一段 */
      var pick = 0, acc = 0, rr = this.rnd() * tot;
      for (i = 0; i < segs.length; i++) {
        acc += segs[i][1] - segs[i][0];
        pick = i;
        if (rr <= acc) break;
      }
      var seg = segs[pick];
      var ux = seg[0] + this.rnd() * (seg[1] - seg[0]);

      var s = this._frac(ux, uy);
      if (this.rnd() > (this._weightAt(s) / wmax) * tipFade) continue;

      out.push(this._mk(ux, uy, this._shellZ(s), this._color(1), 1, this.rnd() < H.flashRatio));
    }
    return out;
  };

  /* -------- 轮廓毛边：沿轮廓法线做三段式抖动 -------- */
  HeartParticles.prototype._genOutline = function (count) {
    var SX = this.H.stretchX, band = this.H.outlineBand, out = [];
    for (var n = 0; n < count; n++) {
      var t = this.rnd() * TAU;
      var h = this._heartPos(t);
      var eps = 1e-4;
      var h1 = this._heartPos(t + eps), h2 = this._heartPos(t - eps);
      var tx = h1[0] - h2[0], ty = h1[1] - h2[1];
      var len = Math.sqrt(tx * tx + ty * ty);
      var nx = len > 0 ? ty / len : 0, ny = len > 0 ? -tx / len : 0;

      /* 3 个均匀分布求和后减 1.5 ≈ 近似正态，集中在中轴 */
      var g = this.rnd() + this.rnd() + this.rnd() - 1.5;
      var u = this.rnd(), d;
      if (u < 0.70)      d = g * 0.35;   /* 紧贴轮廓 */
      else if (u < 0.94) d = g * 0.83;   /* 外扩晕圈 */
      else               d = g * 1.80;   /* 毛边飞散 */

      var hx = h[0] + nx * d * band, hy = h[1] + ny * d * band;
      /* 轮廓处的 s 基本是 1，T 自然趋近 0 —— 心形的"赤道"就落在 z=0 上，
         这正是抱枕边缘该有的样子 */
      out.push(this._mk(hx * SX, -hy, this._shellZ(this._frac(hx * SX, -hy)),
                        this._color(0.92), 1, false));
    }
    return out;
  };

  /* -------- 内部雾状散点：让中空区域不是死黑 -------- */
  HeartParticles.prototype._genHaze = function (count) {
    var R = this.rows, out = [];
    for (var n = 0; n < count; n++) {
      var uy = R.ymin + this.rnd() * (R.ymax - R.ymin);
      var segs = this._rowSegs(uy);
      if (!segs) continue;
      var best = -1, pick = 0;
      for (var k = 0; k < segs.length; k++) {
        var w = segs[k][1] - segs[k][0];
        if (w > best) { best = w; pick = k; }
      }
      /* 雾点只铺在厚度中间薄薄一层：让中空处不是死黑，
         又不会在转动时把"镂空"糊成实心 */
      var hx2 = segs[pick][0] + this.rnd() * best;
      var Tz = this._thick(this._frac(hx2, uy)) * this.H.depth.hazeSpread;
      out.push(this._mk(hx2, uy, (this.rnd() * 2 - 1) * Tz,
                        this._color(0.42), this.H.hazeAlpha, false));
    }
    return out;
  };

  /* -------- 分桶：把静态粒子按 (半径, 量化色, 透明度) 归组，每帧一条 Path -------- */
  HeartParticles.prototype._buildParticles = function () {
    var L = this.H.layers;
    var all = this._genBody(L.body)
      .concat(this._genOutline(L.outline), this._genHaze(L.haze));

    /* 坐标统一存成「相对心中心的 3D 设计像素」三元组，
       3D 旋转与透视都在 render 里逐点做。 */
    var E = this.H.enlarge;
    var map = new Map();
    this.flashList = [];

    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      var bx = p.x * E, by = p.y * E, bz = p.z * E;
      p.bx = bx; p.by = by; p.bz = bz;

      if (p.flash) { this.flashList.push(p); continue; }

      /* 颜色量化到 16 阶，让相近颜色合到同一条 Path */
      var key = p.r + '|' + (p.c[0] >> 4) + ',' + (p.c[1] >> 4) + ',' + (p.c[2] >> 4) + '|' + p.a;
      var b = map.get(key);
      if (!b) { b = { r: p.r, a: p.a, c: p.c, coords: [] }; map.set(key, b); }
      b.coords.push(bx, by, bz);
    }

    this.buckets = [];
    map.forEach(function (b) {
      b.coords = new Float32Array(b.coords);
      b.color = 'rgb(' + b.c[0] + ',' + b.c[1] + ',' + b.c[2] + ')';
      this.buckets.push(b);
    }, this);

    this.count = all.length;
  };

  /* 绘制。
   *   scale —— 心跳的等比缩放（1.0 为静息）
   *   view  —— 视角 { pitch, yaw }，单位弧度
   *
   * 3D 完全在 JS 里逐点算：先按心跳放大，再绕 Y 轴（左右）、X 轴（上下）
   * 旋转，最后做透视除法。粒子按深度分成 bands 档、由远及近绘制 ——
   * 最远一档压低透明度，于是前后有了层次，近处的粒子也自然盖住远处的。
   *
   * 坐标系约定：x 向右、y 向下（心尖在 y>0）、z 向观察者为正。
   *
   * 关于逐点抖动（config: heart.beat.jitter）：原版每帧给每个点加
   * rand()%3-1 的随机偏移，整颗心会持续"沸腾"，搏动时才不像一张放大的
   * 静态图。代价是每帧要重新提交约 8.7k 段圆弧（分桶结构仍在，fill 次数
   * 不变）。设为 0 可省下这部分开销。 */
  HeartParticles.prototype.render = function (ctx, scale, timeSec, view) {
    var H = this.H, D = H.depth;
    var jit = H.beat.jitter || 0;
    var rnd = this.rnd;

    var pitch = view.pitch, yaw = view.yaw;
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var cyw = Math.cos(yaw), syw = Math.sin(yaw);

    var F = D.perspective;
    var bands = D.bands;
    var cx = H.cx, cy = H.cy;

    /* 深度归一化基准。绕 X 轴旋转后，心形的"高度"也会投影进 z，
       所以基准必须随俯仰角变化，否则分档会整体偏掉。 */
    var zRef = (17.0 * Math.abs(sp) + D.thickness) * H.enlarge * scale;

    var i, k, band, X, Y, Z, X1, Z1, Y1, Z2, tt, bd, pr, sx, sy, rr;

    ctx.save();

    for (band = 0; band < bands; band++) {
      var bandAlpha = bands === 1 ? 1
        : D.backAlpha + (1 - D.backAlpha) * (band / (bands - 1));

      for (i = 0; i < this.buckets.length; i++) {
        var b = this.buckets[i], co = b.coords;
        ctx.globalAlpha = b.a * bandAlpha;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        var n = 0;

        for (k = 0; k < co.length; k += 3) {
          X = co[k] * scale; Y = co[k + 1] * scale; Z = co[k + 2] * scale;

          X1 = X * cyw + Z * syw;      /* 绕 Y 轴：左右 */
          Z1 = Z * cyw - X * syw;
          Y1 = Y * cp - Z1 * sp;       /* 绕 X 轴：上下 */
          Z2 = Y * sp + Z1 * cp;

          tt = (Z2 / zRef + 1) * 0.5;
          bd = tt <= 0 ? 0 : (tt >= 1 ? bands - 1 : (tt * bands) | 0);
          if (bd !== band) continue;   /* 不属于本档 */

          pr = F / (F - Z2);           /* 透视：Z2 > 0 更靠近观察者 */
          sx = cx + X1 * pr;
          sy = cy + Y1 * pr;
          if (jit) {
            sx += (((rnd() * 3) | 0) - 1) * jit;
            sy += (((rnd() * 3) | 0) - 1) * jit;
          }
          rr = b.r * pr * scale;
          ctx.moveTo(sx + rr, sy);     /* 断开上一段，避免连线 */
          ctx.arc(sx, sy, rr, 0, TAU);
          n++;
        }

        if (n) ctx.fill();             /* 本档没有粒子就整个跳过 */
      }
    }

    /* 会呼吸闪烁的粒子：数量少（默认 3.5%），逐颗单独绘制 */
    var fl = this.flashList;
    if (fl.length) {
      ctx.globalAlpha = 1;
      for (i = 0; i < fl.length; i++) {
        var p = fl[i];
        X = p.bx * scale; Y = p.by * scale; Z = p.bz * scale;
        X1 = X * cyw + Z * syw;
        Z1 = Z * cyw - X * syw;
        Y1 = Y * cp - Z1 * sp;
        Z2 = Y * sp + Z1 * cp;
        pr = F / (F - Z2);
        sx = cx + X1 * pr;
        sy = cy + Y1 * pr;
        if (jit) {
          sx += (((rnd() * 3) | 0) - 1) * jit;
          sy += (((rnd() * 3) | 0) - 1) * jit;
        }
        var kk = 0.58 + 0.42 * (0.5 + 0.5 * Math.sin(timeSec * p.flashSpd + p.flashPh));
        ctx.fillStyle = 'rgb(' + (p.c[0] * kk | 0) + ',' + (p.c[1] * kk | 0) + ',' + (p.c[2] * kk | 0) + ')';
        ctx.beginPath();
        ctx.arc(sx, sy, p.r * pr * scale, 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  };

  global.HeartParticles = HeartParticles;
  global.HeartParticles.beatScale = beatScale;
  global.MoonfestRandom = mulberry32;
})(window);
