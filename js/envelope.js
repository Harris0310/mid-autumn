/* ============================================================================
 * envelope.js —— 开场信封
 *
 * 点开链接先看到一封白色信封，中间一枚爱心封蜡，下面写着一行字。
 * 轻触之后：封蜡"破"开 -> 封盖绕上边缘翻开 -> 整封信放大淡出 ->
 * 接进主场景（镂空爱心 + 流动的字）。
 *
 * 封盖翻开用的是「绕上边缘旋转」的投影：三角形顶点相对上边缘的偏移量
 * 乘以 cos(角度)。角度从 0 转到 π，偏移就由 +flapH 经 0 变成 -flapH ——
 * 正好是"先压平、再向上翻起"，不用真的做 3D。
 * ========================================================================== */

(function (global) {
  'use strict';

  var TAU = Math.PI * 2;
  var HY_MID = (11.9232 - 17) / 2;   /* 心形参数方程 y 的中位，用来把封印心居中 */

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /* 用和主爱心同一个参数方程画一颗实心心，halfW 是半宽 */
  function heartPath(ctx, cx, cy, halfW) {
    var s = halfW / 16, N = 72;
    ctx.beginPath();
    for (var i = 0; i <= N; i++) {
      var t = i / N * TAU;
      var hx = 16 * Math.pow(Math.sin(t), 3);
      var hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      var px = cx + hx * s;
      var py = cy - (hy - HY_MID) * s;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function smooth(x) { return x * x * (3 - 2 * x); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  function Envelope(cfg) {
    this.cfg = cfg;
    this.E = cfg.envelope;
    this.t = 0;
    this.progress = 0;
    this.opening = false;
    this.done = false;
    this.animateIdle = true;   /* 尊重"减少动态效果"时置 false */
  }

  Envelope.prototype.start = function () {
    if (this.opening) return;
    this.opening = true;
    this.progress = 0;
  };

  Envelope.prototype.update = function (dt) {
    this.t += dt;
    if (!this.opening || this.done) return;
    this.progress += dt / this.E.duration;
    if (this.progress >= 1) { this.progress = 1; this.done = true; }
  };

  Envelope.prototype.render = function (ctx) {
    var E = this.E;
    var p = this.progress;

    /* ---- 各段进度 ---- */
    var ent = clamp01(this.t / 0.9);                    /* 入场 */
    var entE = 1 - Math.pow(1 - ent, 3);
    var seal = clamp01(this.opening ? p / E.sealPhase : 0);
    var flap = clamp01((p - E.flapStart) / (E.flapEnd - E.flapStart));
    var flapE = smooth(flap);
    var letter = clamp01((flap - 0.25) / 0.75);
    var exit = clamp01((p - E.exitStart) / (1 - E.exitStart));
    var exitE = smooth(exit);

    var breathe = this.animateIdle ? 1 + 0.010 * Math.sin(this.t * 2.0) : 1;
    var k = (0.90 + 0.10 * entE) * breathe * (1 + (E.exitScale - 1) * exitE);
    var alpha = entE * (1 - exitE);

    var cx = E.cx, cy = E.cy, W = E.w, H = E.h;
    var L = cx - W / 2, R = cx + W / 2, T = cy - H / 2, B = cy + H / 2;
    var flapH = H * E.flapRatio;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.translate(-cx, -cy);

    /* ---- 投影 ---- */
    ctx.fillStyle = E.shadow;
    roundRect(ctx, L + 6, T + 20, W, H, 12);
    ctx.fill();

    /* ---- 封盖：cos 决定顶点在下面还是翻到上面 ---- */
    var ang = flapE * Math.PI;
    var apexY = T + flapH * Math.cos(ang);
    var flapBehind = Math.cos(ang) < 0;

    function drawFlap() {
      ctx.beginPath();
      ctx.moveTo(L, T);
      ctx.lineTo(R, T);
      ctx.lineTo(cx, apexY);
      ctx.closePath();
      ctx.fillStyle = flapBehind ? '#ded7ca' : '#fbf9f5';
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,170,152,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (flapBehind) drawFlap();

    /* ---- 信纸：封盖翻开后从里面升起来 ---- */
    if (letter > 0) {
      var lw = W * 0.80, lh = H * 0.92;
      var lx = cx - lw / 2, ly = cy - lh / 2 - H * 0.30 * letter;
      ctx.save();
      ctx.globalAlpha = alpha * letter;
      ctx.fillStyle = '#fdfbf7';
      roundRect(ctx, lx, ly, lw, lh, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(190,178,158,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
      /* 信纸上的几道横线，暗示里面写了字 */
      ctx.strokeStyle = 'rgba(206,178,168,0.75)';
      ctx.lineWidth = 2;
      for (var r = 0; r < 3; r++) {
        var yy = ly + lh * (0.34 + r * 0.14);
        ctx.beginPath();
        ctx.moveTo(lx + lw * 0.16, yy);
        ctx.lineTo(lx + lw * (r === 2 ? 0.62 : 0.84), yy);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* ---- 信封正面 ---- */
    var g = ctx.createLinearGradient(0, T, 0, B);
    g.addColorStop(0, E.paper[0]);
    g.addColorStop(0.52, E.paper[1]);
    g.addColorStop(1, E.paper[2]);
    ctx.fillStyle = g;
    roundRect(ctx, L, T, W, H, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(186,176,158,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    /* 底部那张折页的 V 形折痕 */
    ctx.strokeStyle = 'rgba(196,186,168,0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(L + 2, B - 2);
    ctx.lineTo(cx, cy + H * 0.02);
    ctx.lineTo(R - 2, B - 2);
    ctx.stroke();

    if (!flapBehind) drawFlap();

    /* ---- 爱心封蜡 ---- */
    if (seal < 1) {
      var sealA = 1 - seal;
      var sealScale = (1 + seal * 0.9) * (this.animateIdle ? 1 + 0.07 * Math.sin(this.t * 3.2) : 1);
      var sy = flapBehind ? T : T + flapH;
      ctx.save();
      ctx.globalAlpha = alpha * sealA;
      ctx.shadowColor = 'rgba(214,40,58,0.75)';
      ctx.shadowBlur = 22;
      ctx.fillStyle = 'rgb(' + E.sealColor.join(',') + ')';
      heartPath(ctx, cx, sy, E.sealSize * sealScale);
      ctx.fill();
      ctx.restore();
    }

    /* ---- 下一行字 ---- */
    ctx.save();
    ctx.globalAlpha = alpha * entE;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = E.font.replace('{size}', E.textSize);
    ctx.shadowColor = E.textGlow;
    ctx.shadowBlur = 16;
    ctx.fillStyle = 'rgb(' + E.textColor.join(',') + ')';
    ctx.fillText(E.text, E.cx, B + E.textGap + (1 - entE) * 16);
    if (E.hint) {
      ctx.shadowBlur = 0;
      ctx.globalAlpha = alpha * 0.5 * (0.6 + 0.4 * Math.sin(this.t * 2.4));
      ctx.fillStyle = 'rgba(255,232,206,0.85)';
      ctx.font = E.font.replace('{size}', Math.round(E.textSize * 0.62));
      ctx.fillText(E.hint, E.cx, B + E.textGap + E.textSize * 1.9);
    }
    ctx.restore();

    ctx.restore();
  };

  global.Envelope = Envelope;
})(window);
