'use strict';
/* _dev/browsercheck.js —— 用真实浏览器（Edge headless + CDP）量帧率、看手机版式
 * 开发辅助，不参与页面发布。用法：node _dev/browsercheck.js
 * 注意：这里刻避免使用模板字符串，以免与外部包装冲突。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const ROOT = path.resolve(__dirname, '..');

const parts = path.join(ROOT, 'index.html').replace(/\\/g, '/').split('/');
const FILE_URL = 'file:///' + parts.map(function (s, i) {
  return i === 0 ? s : encodeURIComponent(s);
}).join('/');

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

(async function () {
  const profile = path.join(os.tmpdir(), 'edge_bc_' + Date.now());
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-crash-reporter', '--disable-breakpad', '--hide-scrollbars',
    '--remote-allow-origins=*',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + PORT,
    '--window-size=800,900',
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
      }, 30000);
    });
  }

  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(500);
      try {
        const list = await getJson('http://127.0.0.1:' + PORT + '/json/list');
        target = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0];
      } catch (e) { /* 浏览器还没起来 */ }
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
    await sleep(1500);

    async function evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    }

    function fpsExpr(ms) {
      return 'new Promise(function(res){' +
        'var n=0,t0=performance.now(),worst=0,last=t0;' +
        'function tick(now){' +
        'n++;var dt=now-last;last=now;' +
        'if(n>1&&dt>worst)worst=dt;' +
        'if(now-t0<' + ms + ')requestAnimationFrame(tick);' +
        'else res(JSON.stringify({frames:n,ms:Math.round(now-t0),fps:+(n/((now-t0)/1000)).toFixed(1),worstMs:+worst.toFixed(1)}));' +
        '}requestAnimationFrame(tick);})';
    }

    console.log('页面环境: ' + await evaluate('JSON.stringify({dpr:window.devicePixelRatio,w:innerWidth,h:innerHeight,cw:document.getElementById("scene").width,ch:document.getElementById("scene").height,pointer:!!window.PointerEvent})'));
    console.log('桌面 800x900（软件渲染，最坏情况）: ' + await evaluate(fpsExpr(4000)));

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(1500);
    console.log('手机 390x844 @3x         : ' + await evaluate(fpsExpr(4000)));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'phone.png'), Buffer.from(shot.data, 'base64'));

    await evaluate('(function(){var c=document.getElementById("scene");' +
      'function pe(t,x,y){c.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,pointerId:1,bubbles:true,cancelable:true}));}' +
      'pe("pointerdown",195,560);' +
      'for(var i=1;i<=24;i++)pe("pointermove",195,560-i*7);' +
      'pe("pointerup",195,392);return "ok";})()');
    await sleep(400);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'phone_dragged.png'), Buffer.from(shot2.data, 'base64'));

    console.log('截图 -> _dev/phone.png, _dev/phone_dragged.png');
    console.log('真实浏览器检查完成');
  } catch (e) {
    console.log('失败: ' + e.message);
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
})();
