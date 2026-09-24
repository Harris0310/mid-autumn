/* ============================================================================
 * ambient.js —— 背景氛围：星点 + 上升的金色微尘
 * 只为压住大片纯黑，让画面不空；不参与叙事。
 * ========================================================================== */

(function (global) {
  'use strict';

  function Ambient(cfg, rnd) {
    this.cfg = cfg;
    this.a = cfg.ambient;
    this.rnd = rnd;
    this.t = 0;
    this.stars = [];
    this.motes = [];
    if (!this.a.enabled) return;

    var D = cfg.design, i;
    for (i = 0; i < this.a.stars; i++) {
      this.stars.push({
        x: rnd() * D.w,
        y: rnd() * D.h,
        r: 0.5 + rnd() * 1.2,
        ph: rnd() * Math.PI * 2,
        spd: 0.5 + rnd() * 1.6,
        a: 0.12 + rnd() * 0.45
      });
    }
    for (i = 0; i < this.a.motes; i++) this.motes.push(this._mote(rnd() * D.h));
  }

  Ambient.prototype._mote = function (y) {
    var D = this.cfg.design, rnd = this.rnd;
    return {
      x: rnd() * D.w,
      y: y,
      r: 0.8 + rnd() * 1.8,
      vy: 6 + rnd() * 14,
      sway: 8 + rnd() * 22,
      spd: 0.25 + rnd() * 0.6,
      ph: rnd() * Math.PI * 2,
      a: 0.18 + rnd() * 0.5
    };
  };

  Ambient.prototype.update = function (dt) {
    if (!this.a.enabled) return;
    this.t += dt;
    var D = this.cfg.design;
    for (var i = 0; i < this.motes.length; i++) {
      this.motes[i].y -= this.motes[i].vy * dt;
      if (this.motes[i].y < -20) this.motes[i] = this._mote(D.h + 20);
    }
  };

  Ambient.prototype.render = function (ctx) {
    if (!this.a.enabled) return;
    var t = this.t, i;
    var sc = this.a.starColor, mc = this.a.moteColor;

    ctx.save();

    ctx.fillStyle = 'rgb(' + sc[0] + ',' + sc[1] + ',' + sc[2] + ')';
    for (i = 0; i < this.stars.length; i++) {
      var s = this.stars[i];
      ctx.globalAlpha = s.a * (0.55 + 0.45 * Math.sin(t * s.spd + s.ph));
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }

    ctx.fillStyle = 'rgb(' + mc[0] + ',' + mc[1] + ',' + mc[2] + ')';
    for (i = 0; i < this.motes.length; i++) {
      var m = this.motes[i];
      ctx.globalAlpha = m.a * (0.5 + 0.5 * Math.sin(t * 0.8 + m.ph));
      ctx.beginPath();
      ctx.arc(m.x + Math.sin(t * m.spd + m.ph) * m.sway, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  };

  global.Ambient = Ambient;
})(window);
