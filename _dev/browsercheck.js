'use strict';
/* _dev/browsercheck.js —— 真实浏览器（Edge headless + CDP）验收
 *   1) 手机视口下量帧率
 *   2) 采集「信封 -> 拆封 -> 主场景」整条流程的截图
 *   3) 模拟拖动，确认视角真的会转
 * 开发辅助，不参与页面发布。用法：node _dev/browsercheck.js
 * 注意：刻意不使用模板字符串。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
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

(function () {
  const profile = path.join(os.tmpdir(), 'edge_bc_' + Date.now());
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
      }, 40000);
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
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await sleep(2000);

    async function evaluate(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
      return r.result.value;
    }

    async function shot(name) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, name), Buffer.from(s.data, 'base64'));
    }

    /* 页面里有没有抛错？ */
    const errs = await evaluate('window.__errs ? JSON.stringify(window.__errs) : "无"');
    console.log('页面错误: ' + errs);

    console.log('环境: ' + await evaluate('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,pointer:!!window.PointerEvent})'));

    await shot('sc1_envelope.png');
    console.log('1) 信封封面 -> _dev/sc1_envelope.png');

    /* 点一下：拆封 */
    await evaluate('(function(){var c=document.getElementById("scene");' +
      'c.dispatchEvent(new PointerEvent("pointerdown",{clientX:195,clientY:500,pointerId:1,bubbles:true,cancelable:true}));' +
      'c.dispatchEvent(new PointerEvent("pointerup",{clientX:195,clientY:500,pointerId:1,bubbles:true,cancelable:true}));' +
      'return "tapped";})()');

    await sleep(400); await shot('sc2_opening.png');
    console.log('2) 拆封中(0.4s) -> _dev/sc2_opening.png');
    await sleep(450); await shot('sc3_letter.png');
    console.log('3) 信纸升起(0.85s) -> _dev/sc3_letter.png');
    await sleep(1800); await shot('sc4_heart.png');
    console.log('4) 主场景 -> _dev/sc4_heart.png');

    /* 帧率（主场景，软件渲染的最坏情况） */
    const fpsExpr = 'new Promise(function(res){var n=0,t0=performance.now(),worst=0,last=t0;' +
      'function tick(now){n++;var dt=now-last;last=now;if(n>1&&dt>worst)worst=dt;' +
      'if(now-t0<4000)requestAnimationFrame(tick);' +
      'else res(JSON.stringify({frames:n,fps:+(n/((now-t0)/1000)).toFixed(1),worstMs:+worst.toFixed(1)}));}' +
      'requestAnimationFrame(tick);})';
    console.log('手机 390x844 主场景帧率: ' + await evaluate(fpsExpr));

    /* 拖动转视角 */
    await evaluate('(function(){var c=document.getElementById("scene");' +
      'function pe(t,x,y){c.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,pointerId:1,bubbles:true,cancelable:true}));}' +
      'pe("pointerdown",195,560);for(var i=1;i<=24;i++)pe("pointermove",195,560-i*7);pe("pointerup",195,392);return "ok";})()');
    await sleep(500);
    await shot('sc5_dragged.png');
    console.log('5) 拖动后 -> _dev/sc5_dragged.png');

    console.log('验收完成');
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
