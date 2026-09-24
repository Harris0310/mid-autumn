'use strict';
/* _dev/perfprobe.js —— 真实浏览器里量"流动的字"各选项的开销
 *
 * 手机视口 + 强制软件渲染（--disable-gpu）下，逐个改一个参数、各量 3 秒帧率，
 * 用来判断掉帧到底出在哪（发光？渐变？条数？）。
 * 开发辅助，不参与页面发布。用法：node _dev/perfprobe.js
 * 注意：刻意不使用模板字符串。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const ROOT = path.resolve(__dirname, '..');

/* 设备像素比：browsercheck 用 3，这里默认 2（main.js 会把画布 dpr 夹到 2），
   想对齐 browsercheck 的口径就传 3。用法：node _dev/perfprobe.js [dsf] [tap]
   加 tap 就走完整流程（信封 -> 轻触拆封 -> 主场景），否则用 ?open=1 直接进主场景。 */
const DSF = parseFloat(process.argv[2] || '2') || 2;
const TAP = process.argv[3] === 'tap';

const parts = path.join(ROOT, 'index.html').replace(/\\/g, '/').split('/');
const FILE_URL = 'file:///' + parts.map(function (s, i) {
  return i === 0 ? s : encodeURIComponent(s);
}).join('/') + (TAP ? '' : '?open=1');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function getJson(url) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(2000, function () { req.destroy(new Error('timeout')); });
  });
}

/* 每个变体：在页面里跑一段 JS 改配置，再量帧时。
   每轮都从出厂值复位，整张表跑两轮 —— 渲染开销的测量噪声不小，
   看两轮是否一致才知道差异是不是真的。 */
const VARIANTS = [
  ['现状（条数16/大字发光/流光）', 'true'],
  ['关发光', 'F.sc.glowBlur=0;true'],
  ['关流光（纯色填充）', 'F.sc.sheen=false;true'],
  ['关发光 + 关流光', 'F.sc.glowBlur=0;F.sc.sheen=false;true'],
  ['条数 8', 'F.sc.density=8;F.relayout();true'],
  ['现状（复测）', 'true']
];

(function () {
  const profile = path.join(os.tmpdir(), 'edge_pp_' + Date.now());
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + PORT,
    '--window-size=390,844',
    FILE_URL
  ], { stdio: 'ignore' });

  let ws = null, id = 0;
  const pending = new Map();

  function send(method, params) {
    return new Promise(function (resolve, reject) {
      const mid = ++id;
      pending.set(mid, { resolve: resolve, reject: reject });
      ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
      setTimeout(function () {
        if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP timeout: ' + method)); }
      }, 60000);
    });
  }

  async function run() {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(500);
      try {
        const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        target = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0];
      } catch (e) {}
    }
    if (!target) throw new Error('连不上浏览器调试端口');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(function (res, rej) {
      ws.onopen = res;
      ws.onerror = function () { rej(new Error('WebSocket 连接失败')); };
      setTimeout(function () { rej(new Error('WebSocket 超时')); }, 15000);
    });
    ws.onmessage = function (ev) {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DSF, mobile: true });
    await sleep(2500);
    console.log('deviceScaleFactor = ' + DSF);

    async function evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
      return r.result.value;
    }

    /* 一个全局的工具对象：F 指向 flow，relayout() 按当前视口重排 */
    await evaluate('window.F=(function(){var f=window.__moonfest.flow,v=window.__moonfest.view;' +
      'return{sc:f.sc,color:f.sc.color,highlight:f.sc.highlight,flow:f,' +
      'relayout:function(){f.layout(v.w,v.h,v.k);}};})();"ok"');

    if (TAP) {
      await evaluate('(function(){var c=document.getElementById("scene");' +
        'c.dispatchEvent(new PointerEvent("pointerdown",{clientX:195,clientY:500,pointerId:1,bubbles:true,cancelable:true}));' +
        'c.dispatchEvent(new PointerEvent("pointerup",{clientX:195,clientY:500,pointerId:1,bubbles:true,cancelable:true}));' +
        'return "tapped";})()');
      await sleep(3500);
      console.log('已走完整流程（信封 -> 拆封 -> 主场景）');
    }

    const fpsExpr = 'new Promise(function(res){var d=[],last=performance.now(),t0=last;' +
      'function q(s,p){return +s[Math.min(s.length-1,Math.floor(s.length*p))].toFixed(2);}' +
      'function tick(now){d.push(now-last);last=now;' +
      'if(now-t0<4000)requestAnimationFrame(tick);' +
      'else{var s=d.slice(1).sort(function(a,b){return a-b;});' +
      'res({中位:q(s,0.5),p90:q(s,0.9),p99:q(s,0.99),最慢:+s[s.length-1].toFixed(1)});}}' +
      'requestAnimationFrame(tick);})';

    /* 冷启动曲线：不做任何复位，从刚加载开始连续量几个窗口。
       用来回答"偶发长帧是不是只是头几秒在填字形/模糊缓存"。
       第 4 个参数是量之前先执行的 JS：noflow = 关掉字幕只量爱心，
       也可以直接写一段调参（如 F.sc.glowMinMul=1.2）来试冷启动余量。 */
    const PRE = process.argv[4] || '';
    if (PRE === 'noflow') {
      await evaluate('window.F.sc.enabled=false;"flow off"');
      console.log('（已关掉流动的字，只量爱心）');
    } else if (PRE === 'shots') {
      /* 连拍几张图再量：browsercheck 就是这么干的，用来验证"截图会不会污染测量" */
      for (let i = 0; i < 5; i++) {
        const s = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(os.tmpdir(), 'pp_shot_' + i + '.png'), Buffer.from(s.data, 'base64'));
      }
      console.log('（已先连拍 5 张截图）');
    } else if (PRE) {
      await evaluate(PRE);
      console.log('（已先执行: ' + PRE + '）');
    }
    console.log('--- 冷启动曲线（无复位，连续 4 秒窗口）---');
    for (let i = 1; i <= 4; i++) {
      const rr = await evaluate(fpsExpr);
      console.log('  第 ' + i + ' 个窗口  中位=' + String(rr.中位).padStart(6) +
        '  p90=' + String(rr.p90).padStart(6) + '  最慢=' + rr.最慢);
    }

    for (let pass = 1; pass <= 2; pass++) {
      console.log('--- 第 ' + pass + ' 轮（帧时 ms，越小越好；中位 16.7 = 满 60fps）---');
      for (const [name, js] of VARIANTS) {
        /* 每个变体前先还原成出厂值，避免互相污染 */
        await evaluate('(function(){var d=window.MOONFEST.text.scroll,f=window.F;' +
          'f.sc.glowBlur=d.glowBlur;f.sc.sheenStops=d.sheenStops;f.sc.density=d.density;' +
          'f.sc.glowMinMul=d.glowMinMul;f.sc.sheen=d.sheen;f.relayout();return "reset";})()');
        await evaluate(js);
        await sleep(400);
        const r = await evaluate(fpsExpr);
        console.log('  ' + String(name).padEnd(26, ' ') + ' 中位=' + String(r.中位).padStart(6) +
          '  p90=' + String(r.p90).padStart(6) + '  p99=' + String(r.p99).padStart(6) + '  最慢=' + r.最慢);
      }
    }

    /* 第三轮：对齐 browsercheck 的条件 —— 先截一张 1170×2532 的图再量。
       用来判断"偶发长帧"到底是页面的问题，还是截图（同步 PNG 编码）造成的。 */
    console.log('--- 第 3 轮：截图前/后 ---');
    let r = await evaluate(fpsExpr);
    console.log('  截图前                         中位=' + r.中位 + '  p90=' + r.p90 + '  最慢=' + r.最慢);
    await send('Page.captureScreenshot', { format: 'png' });
    r = await evaluate(fpsExpr);
    console.log('  紧接着截图之后                   中位=' + r.中位 + '  p90=' + r.p90 + '  最慢=' + r.最慢);
    await sleep(2000);
    r = await evaluate(fpsExpr);
    console.log('  截图 2 秒之后                    中位=' + r.中位 + '  p90=' + r.p90 + '  最慢=' + r.最慢);

    /* 第四轮：模拟 browsercheck 的拖动。转过来的心近处粒子被透视放大、
       覆盖面更大，理论上比正面更费 —— 量一下确认。 */
    console.log('--- 第 4 轮：拖动转视角之后 ---');
    await evaluate('(function(){var c=document.getElementById("scene");' +
      'function pe(t,x,y){c.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,pointerId:1,bubbles:true,cancelable:true}));}' +
      'pe("pointerdown",195,560);for(var i=1;i<=24;i++)pe("pointermove",195,560-i*7);pe("pointerup",195,392);return "ok";})()');
    await sleep(600);
    r = await evaluate(fpsExpr);
    console.log('  拖动之后                        中位=' + r.中位 + '  p90=' + r.p90 + '  最慢=' + r.最慢);
  }

  run().catch(function (e) { console.log('失败: ' + e.message); }).then(function () {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    setTimeout(function () {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
      process.exit(0);
    }, 800);
  });
})();
