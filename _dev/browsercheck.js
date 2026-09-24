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
    await sleep(450); await shot('sc3_paper.png');
    console.log('3) 信纸升起(0.85s) -> _dev/sc3_paper.png');
    await sleep(1200); await shot('sc4_heart.png');
    console.log('4) 主场景（爱心 + 信息流） -> _dev/sc4_heart.png');

    /* 信息流：隔开一点时间连拍两张，验证「不同位置、不同时间」。
       必须趁早拍 —— 信息流只飘 letter.flowSeconds 秒就要让位给信了。 */
    await sleep(250); await shot('sc5_flow1.png');
    console.log('5) 信息流 t+0.0s -> _dev/sc5_flow1.png');
    await sleep(450); await shot('sc6_flow2.png');
    console.log('6) 信息流 t+0.45s -> _dev/sc6_flow2.png');

    /* 速度实测：跟着一条文案走 1 秒，量它实际飘了多少像素。
       代码里的 speed 是多少不算数，主循环把 dt 喂进去之后真的走了多少才算数。 */
    const speedProbe = 'new Promise(function(res){' +
      'var f=window.__moonfest.flow, vh=innerHeight;' +
      'var cur=null, prevY=0, disp=0, t0=0, replaced=0;' +
      'function tick(now){' +
      '  if(!t0)t0=now;' +
      '  if(!cur||f.items.indexOf(cur)<0){' +
      '    var best=null;' +
      '    for(var i=0;i<f.items.length;i++){if(!best||f.items[i].y>best.y)best=f.items[i];}' +
      '    cur=best; prevY=best?best.y:0; replaced++;' +
      '  }' +
      '  if(cur){ if(prevY>cur.y)disp+=prevY-cur.y; prevY=cur.y; }' +
      '  var el=(now-t0)/1000;' +
      '  if(el<1.2)requestAnimationFrame(tick);' +
      '  else res({视口高:vh,实测速度:Math.round(disp/el),' +
      '    穿一屏秒:+(vh/(disp/el)).toFixed(2),屏上条数:f.items.length,跟过的条数:replaced});' +
      '}' +
      'requestAnimationFrame(tick);})';
    console.log('速度实测(手机): ' + JSON.stringify(await evaluate(speedProbe)));
    console.log('信息流状态: ' + await evaluate('(function(){' +
      'var m=window.__moonfest; if(!m) return "（main.js 未暴露 __moonfest）";' +
      'var f=m.flow, it=f.items, s=it.map(function(i){return i.size;});' +
      'return JSON.stringify({条数:it.length,屏内:it.filter(function(i){return i.y>=0&&i.y<=innerHeight;}).length,' +
      '字号:[Math.min.apply(null,s).toFixed(0),Math.max.apply(null,s).toFixed(0)],' +
      '速度:f.speed.toFixed(0),发射:+f.spawnRate.toFixed(1),淡出进度:f.dim});})()'));

    /* 拖动转视角 */
    await evaluate('(function(){var c=document.getElementById("scene");' +
      'function pe(t,x,y){c.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,pointerId:1,bubbles:true,cancelable:true}));}' +
      'pe("pointerdown",195,560);for(var i=1;i<=24;i++)pe("pointermove",195,560-i*7);pe("pointerup",195,392);return "ok";})()');
    await sleep(500);
    await shot('sc7_dragged.png');
    console.log('7) 拖动后 -> _dev/sc7_dragged.png');

    /* 帧率（主场景，软件渲染的最坏情况）。
       报中位数与 p90：均值会被个别长帧（GC/合成）带偏，中位数才反映稳态。 */
    const fpsExpr = 'new Promise(function(res){var d=[],last=performance.now(),t0=last;' +
      'function q(s,p){return +s[Math.min(s.length-1,Math.floor(s.length*p))].toFixed(2);}' +
      'function tick(now){d.push(now-last);last=now;' +
      'if(now-t0<5000)requestAnimationFrame(tick);' +
      'else{var s=d.slice(1).sort(function(a,b){return a-b;});' +
      'res({帧数:s.length,fps:+(1000/(s.reduce(function(a,b){return a+b;},0)/s.length)).toFixed(1),' +
      '中位:q(s,0.5),p90:q(s,0.9),p99:q(s,0.99),最慢:+s[s.length-1].toFixed(1)});}}' +
      'requestAnimationFrame(tick);})';
    console.log('手机 390x844 信息流帧时(ms): ' + JSON.stringify(await evaluate(fpsExpr)));

    /* ---- 信息流飘满 -> 信纸升起 ---- */
    const wait = await evaluate('(function(){var L=window.MOONFEST.letter;' +
      'return JSON.stringify({信息流秒数:L.flowSeconds,升起用时:L.duration,信已出场:!!window.__moonfest.letter.active});})()');
    console.log('信的配置: ' + wait);

    /* 等信升起来（信息流 9s + 升起 2s，前面已经花掉一些） */
    await sleep(9000);
    await shot('sc8_letter.png');
    console.log('8) 信 -> _dev/sc8_letter.png');
    console.log('信的状态: ' + await evaluate('(function(){var m=window.__moonfest;' +
      'var lt=m.letter; return JSON.stringify({出场:lt.active,进度:+lt.progress.toFixed(2),完成:lt.done,' +
      '信息流已淡出:m.flow.dim===0,排版字号:(lt._fit&&lt._fit.size)||null,' +
      '行数:(lt._fit&&lt._fit.lines.length)||null});})()'));
    console.log('手机 390x844 信帧时(ms): ' + JSON.stringify(await evaluate(fpsExpr)));

    /* 桌面视口也量一次。换视口会触发 resize，信的排版会重新试字号。 */
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(2500);
    await shot('sc9_desktop.png');
    console.log('9) 桌面 1440x900 -> _dev/sc9_desktop.png');
    console.log('桌面信帧时(ms): ' + JSON.stringify(await evaluate(fpsExpr)));
    console.log('桌面信排版: ' + await evaluate('(function(){var lt=window.__moonfest.letter;' +
      'return JSON.stringify({字号:lt._fit&&lt._fit.size,行数:lt._fit&&lt._fit.lines.length,' +
      '信纸:[Math.round(lt.pw),Math.round(lt.ph)]});})()'));

    /* 最后：重新开一个干净页面（?open=1，不经信封、不截图）再量一次。
       这里量到的才是"信息流在跑"的稳态帧时 —— 本页前面那几次都被截图、
       拆封动画、信的升起混在一起了，口径不同，报告里必须分清楚。 */
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Page.navigate', { url: FILE_URL + '?open=1' });
    await sleep(5000);
    console.log('干净页面(?open=1) 信息流帧时(ms): ' + JSON.stringify(await evaluate(fpsExpr)));
    console.log('干净页面 复测(ms): ' + JSON.stringify(await evaluate(fpsExpr)));

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
