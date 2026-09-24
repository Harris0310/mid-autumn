/* ============================================================================
 * letter.js —— 信
 *
 * 信息流飘满 letter.flowSeconds 秒（长长久久）之后，信纸从屏幕下方升起来，
 * 上面是一封写给她的信。
 *
 * 【一屏放下】正文一百多字，却要整封一屏展示，所以字号是**自动试出来的**：
 *   从 maxSize 往下试，每档都做一次断行、量一遍总高度，第一个装得下的就是
 *   最终字号。所以以后改文案不用管排版，它自己会缩。
 *
 * 【断行】canvas 没有自动换行，这里逐字量宽自己断。中文任意处可断；
 *   英文单词尽量整词挪到下一行（退到最后一个空格），不会把 "love" 劈成两半。
 *
 * 【坐标系】和流动的字一样用视口坐标（1 单位 = 1 CSS 像素）：信是盖在
 *   整个画面上的一层纸，不该被爱心的设计框那一小块尺寸限制。
 * ========================================================================== */

(function (global) {
  'use strict';

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
    ctx.arcTo(x, y + r, x + r, y, r);
    ctx.closePath();
  }

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }

  /* 逐字断行。firstW 是第一行可用宽度（要留首行缩进），restW 是其余行。 */
  function wrapLines(ctx, text, firstW, restW) {
    var lines = [], line = '', lineW = 0, limit = firstW, space = -1;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var w = ctx.measureText(ch).width;
      if (line && lineW + w > limit) {
        if (space > 0 && /[A-Za-z0-9]/.test(ch)) {
          /* 正在英文单词中间：退到最后一个空格断，整词挪到下一行 */
          lines.push(line.slice(0, space));
          line = line.slice(space + 1) + ch;
        } else {
          lines.push(line);
          line = ch;
        }
        lineW = ctx.measureText(line).width;
        limit = restW;
        space = -1;
      } else {
        line += ch;
        lineW += w;
      }
      if (ch === ' ') space = line.length - 1;
    }
    if (line) lines.push(line);
    return lines;
  }

  function Letter(cfg) {
    this.cfg = cfg;
    this.L = cfg.letter;
    this.t = 0;
    this.progress = 0;
    this.active = false;
    this.done = false;
    this.vw = 0; this.vh = 0;
    this.pw = 0; this.ph = 0;
    this._fit = null;
  }

  Letter.prototype.layout = function (vw, vh) {
    var L = this.L;
    this.vw = vw; this.vh = vh;
    this.pw = Math.min(vw * L.paperW, L.paperMaxW);
    this.ph = Math.min(vh * L.paperH, this.pw * L.paperRatio);
    this._fit = null;                 /* 尺寸变了，字要重新试 */
  };

  Letter.prototype.start = function () {
    if (this.active) return;
    this.active = true;
    this.t = 0;
    this.progress = 0;
    this.done = false;
  };

  /* 信已经完全升到位。此时爱心在暗纱下面已经看不见了（见验收截图），
     main.js 据此省掉每帧的爱心 / 星点 / 信息流绘制。 */
  Letter.prototype.covered = function () {
    return this.active && this.progress >= 1;
  };

  Letter.prototype.update = function (dt) {
    if (!this.active) return;
    this.t += dt;
    var dur = Math.max(0.05, this.L.duration);
    this.progress = this.t >= dur ? 1 : this.t / dur;
    if (this.progress >= 1) this.done = true;
  };

  /* 按某个字号排一版：返回每一行的文字、字号、纵向中线位置，以及总高度 */
  Letter.prototype._typeset = function (ctx, size, innerW) {
    var L = this.L;
    var gSize = size * L.greetingScale;
    var gLineH = gSize * L.lineHeight;
    var lineH = size * L.lineHeight;
    var indentW = size * L.indent;
    var lines = [], h = 0, i, p;

    if (L.seal) {
      var sealH = gSize * L.sealScale * 1.25;
      lines.push({ text: L.seal, size: gSize * L.sealScale, mid: h + sealH * 0.5, indent: 0, kind: 'seal' });
      h += sealH + size * 0.5;
    }

    ctx.font = L.greetingFont.replace('{size}', gSize.toFixed(2));
    lines.push({ text: L.greeting, size: gSize, mid: h + gLineH * 0.5, indent: 0, kind: 'greeting' });
    h += gLineH + size * L.greetingGap;

    for (p = 0; p < L.body.length; p++) {
      ctx.font = L.font.replace('{size}', size.toFixed(2));
      var wrapped = wrapLines(ctx, L.body[p], innerW - indentW, innerW);
      for (i = 0; i < wrapped.length; i++) {
        lines.push({
          text: wrapped[i], size: size, mid: h + lineH * 0.5,
          indent: i === 0 ? indentW : 0, kind: 'body'
        });
        h += lineH;
      }
      h += size * L.paraGap;
    }
    return { size: size, lines: lines, h: h };
  };

  /* 从 maxSize 往下试，第一个整段装得下的字号就是最终字号 */
  Letter.prototype._fitText = function (ctx) {
    var L = this.L;
    var innerW = this.pw - this.pw * L.padX * 2;
    var innerH = this.ph - this.ph * L.padY * 2;
    var best = null;
    for (var size = L.maxSize; size >= L.minSize - 1e-6; size -= 0.5) {
      var t = this._typeset(ctx, size, innerW);
      best = t;                       /* 万一一直装不下，就用最小号的这一版 */
      if (t.h <= innerH) return t;
    }
    return best;
  };

  /* 信纸 + 投影是静态的，缓存成一张离屏位图。
     否则每帧都要对一块 335×500 的圆角矩形做一次 30px 高斯模糊 ——
     软件渲染下这是整封信最贵的一笔，而它每帧画出来都一模一样。
     离屏按 2 倍分辨率画，贴回来时再缩到实际尺寸，边缘依然干净。 */
  Letter.prototype._paperBitmap = function (w, h) {
    if (this._bmp && this._bmpW === w && this._bmpH === h) return this._bmp;

    var L = this.L;
    var pad = Math.ceil(L.shadowOffsetY + L.shadowBlur * 1.5);   /* 给投影留出边 */
    var s = 2;
    var cv = document.createElement('canvas');
    cv.width = Math.ceil((w + pad * 2) * s);
    cv.height = Math.ceil((h + pad * 2) * s);
    var c = cv.getContext('2d');
    c.scale(s, s);

    c.shadowColor = L.shadow;
    c.shadowBlur = L.shadowBlur;
    c.shadowOffsetY = L.shadowOffsetY;
    var g = c.createLinearGradient(0, pad, 0, pad + h);
    g.addColorStop(0, L.paper[0]);
    g.addColorStop(0.55, L.paper[1]);
    g.addColorStop(1, L.paper[2]);
    c.fillStyle = g;
    roundRect(c, pad, pad, w, h, L.radius);
    c.fill();

    c.shadowBlur = 0;                     /* 描边不带影子，边缘才干净 */
    c.shadowOffsetY = 0;
    c.strokeStyle = L.edge;
    c.lineWidth = 1;
    roundRect(c, pad + 0.5, pad + 0.5, w - 1, h - 1, L.radius);
    c.stroke();

    this._bmp = cv; this._bmpW = w; this._bmpH = h; this._bmpPad = pad;
    return cv;
  };

  Letter.prototype.render = function (ctx) {
    if (!this.active || this.progress <= 0) return;
    var L = this.L;
    if (!this._fit) this._fit = this._fitText(ctx);
    var fit = this._fit;

    var e = easeOut(this.progress);
    var w = this.pw, h = this.ph;
    var x = (this.vw - w) * 0.5;
    var yFrom = this.vh + h * L.riseFrom;
    var yTo = (this.vh - h) * 0.5;
    var y = yFrom + (yTo - yFrom) * e;
    var scale = L.startScale + (1 - L.startScale) * e;
    var alpha = clamp01(this.progress / 0.55);

    var padX = w * L.padX, padY = h * L.padY;

    ctx.save();
    ctx.globalAlpha = alpha;
    /* 以信纸中心为原点做缩放：升起来的同时"贴"到位，不做多余的位移 */
    ctx.translate(this.vw * 0.5, y + h * 0.5);
    ctx.scale(scale, scale);
    ctx.translate(-this.vw * 0.5, -(y + h * 0.5));

    /* ---- 信纸（缓存位图，见 _paperBitmap） ---- */
    var bmp = this._paperBitmap(w, h);
    var pad = this._bmpPad;
    ctx.drawImage(bmp, x - pad, y - pad, w + pad * 2, h + pad * 2);

    /* ---- 正文 ---- */
    var top = y + padY + (h - padY * 2 - fit.h) * 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < fit.lines.length; i++) {
      var ln = fit.lines[i];
      var font = ln.kind === 'greeting' ? L.greetingFont : L.font;
      ctx.font = font.replace('{size}', ln.size.toFixed(2));
      if (ln.kind === 'seal') {
        ctx.fillStyle = 'rgb(' + L.sealColor.join(',') + ')';
        ctx.fillText(ln.text, x + w * 0.5, top + ln.mid);
      } else {
        ctx.textAlign = 'left';
        ctx.fillStyle = ln.kind === 'greeting'
          ? 'rgb(' + L.greetingColor.join(',') + ')'
          : 'rgb(' + L.textColor.join(',') + ')';
        ctx.fillText(ln.text, x + padX + ln.indent, top + ln.mid);
        ctx.textAlign = 'center';
      }
    }

    ctx.restore();
  };

  global.Letter = Letter;
})(window);
