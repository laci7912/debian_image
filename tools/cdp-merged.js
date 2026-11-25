/*
 * A feladat-terminal.html teljes ellenőrzése file:// címről:
 *  - elindul-e a vendég
 *  - a fülek váltanak-e (Feladatok <-> Súgó)
 *  - a példa-csempék beírják-e a parancsot
 *  - a parancssáv végrehajt-e egy parancsot a valódi terminálon
 *  - a rendszerinfó (Súgó fül) kitöltődik-e
 *
 * Használat: node cdp-merged.js <fajl-utvonal>
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const FILE = process.argv[2];
if (!FILE) {
  console.error("Használat: node cdp-merged.js <html fajl vagy http(s) URL>");
  process.exit(1);
}
let URL_;
if (/^https?:/i.test(FILE)) {
  URL_ = FILE;
} else {
  if (!fs.existsSync(FILE)) {
    console.error("Nincs ilyen fájl: " + FILE);
    process.exit(1);
  }
  URL_ = "file:///" + path.resolve(FILE).replace(/\\/g, "/");
}
const PORT = 9341;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
const profile = path.join(process.env.TEMP, "cdp-m-" + Date.now());

const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--allow-file-access-from-files",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + PORT,
  "--window-size=1500,950", URL_
], { stdio: ["ignore", "pipe", "pipe"] });

let pageErrors = [];
proc.stderr.on("data", d => {
  const s = d.toString();
  // A bongeszo sajat infrastruktura-uzenetei (task manager, elevation service,
  // GPU, fontconfig) nem az oldal hibai - ezeket kiszurjuk.
  if (/fallback_task_provider|elevation_service|LaunchUpdateCmd|Fontconfig|GPU|gles|Vulkan|dbus|DevTools|CONSOLE/i.test(s)) return;
  if (/ERROR|error/i.test(s)) {
    pageErrors.push(s.trim().slice(0, 200));
  }
});

const getJSON = p => new Promise((res, rej) => {
  http.get("http://127.0.0.1:" + PORT + p, r => {
    let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

async function endpoint() {
  for (let i = 0; i < 200; i++) {
    try { const l = await getJSON("/json/list"); if (l && l.length) return l; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("no devtools endpoint");
}

function wsConnect(wsUrl) {
  const u = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write("GET " + u.pathname + (u.search || "") + " HTTP/1.1\r\nHost: " + u.host +
        "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " +
        crypto.randomBytes(16).toString("base64") + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    let buf = Buffer.alloc(0), upgraded = false;
    let messageHandler = null;
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        if (!/101/.test(buf.subarray(0, i).toString())) return reject(new Error("no upgrade"));
        buf = buf.subarray(i + 4); upgraded = true;
        resolve({
          send(obj) {
            const p = Buffer.from(JSON.stringify(obj));
            const mask = crypto.randomBytes(4);
            let head;
            if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
            else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
            else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(p.length), 2); }
            const masked = Buffer.alloc(p.length);
            for (let k = 0; k < p.length; k++) masked[k] = p[k] ^ mask[k % 4];
            sock.write(Buffer.concat([head, mask, masked]));
          },
          onMessage(cb) { messageHandler = cb; },
          close() { try { sock.destroy(); } catch (e) {} }
        });
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 8) return;
        if (op === 1) { try { if (messageHandler) messageHandler(JSON.parse(payload.toString())); } catch (e) {} }
      }
    });
    sock.on("error", reject);
  });
}

let msgId = 0;
const pending = new Map();
function rpc(ws, method, params) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send({ id, method, params: params || {} });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 120000);
  });
}

async function evaluate(ws, expr) {
  const r = await rpc(ws, "Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error("JS: " + (r.exceptionDetails.text || ""));
  return r.result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  try {
    const list = await endpoint();
    const page = list.find(t => t.type === "page") || list[0];
    const ws = await wsConnect(page.webSocketDebuggerUrl);
    ws.onMessage(m => { if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await rpc(ws, "Runtime.enable");
    await rpc(ws, "Log.enable");
    await sleep(500);

    // which engine loaded? (a halozatrol toltott konyvtarak 1-3 masodpercet
    // is igenybe vehetnek, ezert addig varunk, amig meg nem erkeznek)
    let engine = "undefined/undefined/undefined";
    for (let i = 0; i < 80; i++) {
      engine = await evaluate(ws, "typeof Terminal + '/' + typeof V86 + '/' + typeof LazyDisk");
      if (/^function\/function\/function$/.test(engine)) break;
      await sleep(250);
    }
    console.log("engine: " + engine);
    if (!/^function\/function\/function$/.test(engine)) {
      console.log("FAIL: a konyvtarak nem toltenek be");
      console.log("errors: " + pageErrors.slice(0, 5).join(" | "));
      proc.kill(); process.exit(1);
    }

    // wait for guest
    let ready = false, t0 = Date.now();
    for (let i = 0; i < 400; i++) {
      try { ready = await evaluate(ws, "!!(window.__ready && window.__ready())"); } catch (e) {}
      if (ready) break;
      await sleep(250);
    }
    console.log("READY: " + ready + " in " + Math.round((Date.now() - t0) / 1000) + "s");
    if (!ready) { proc.kill(); process.exit(1); }

    // --- 1) tabs
    const tabTest = await evaluate(ws, `(function(){
      var tabs = document.querySelectorAll('.tab');
      var help = document.getElementById('pane-help');
      var tasks = document.getElementById('pane-tasks');
      tabs[1].click();
      var helpOn = !help.classList.contains('hidden') && tasks.classList.contains('hidden');
      var activeOk = tabs[1].classList.contains('active');
      tabs[0].click();
      var backOk = !tasks.classList.contains('hidden') && help.classList.contains('hidden');
      return { helpOn: helpOn, activeOk: activeOk, backOk: backOk, count: tabs.length };
    })()`);
    console.log("tabs: " + JSON.stringify(tabTest));

    // --- 2) example chips fill the command bar
    // A parancssáv most a modulé (.dtx-input / .dtx-run).
    const chipTest = await evaluate(ws, `(function(){
      var c = document.getElementById('chips').querySelectorAll('.chip');
      if (!c.length) return { count: 0 };
      c[3].click();
      var inp = document.querySelector('.dtx-input');
      var v = inp ? inp.value : 'NINCS INPUT';
      if (inp) inp.value = '';
      return { count: c.length, filled: v };
    })()`);
    console.log("chips: " + JSON.stringify(chipTest));

    // --- 3) command bar runs a real command
    await evaluate(ws, `(function(){
      document.querySelector('.dtx-input').value = 'echo MERGED-OK-$$';
      document.querySelector('.dtx-run').click();
    })()`);
    await sleep(3500);
    const ranOk = await evaluate(ws, `window.__termText().indexOf('MERGED-OK-') !== -1`);
    console.log("cmdbar: " + ranOk);

    // --- 4) system info filled
    const info = await evaluate(ws, `(function(){
      var o = {};
      ['k-name','k-ver','k-host','k-kernel','k-fs','k-dev','k-pkgs'].forEach(function(id){
        var el = document.getElementById(id);
        o[id] = el ? el.textContent : 'MISSING';
      });
      return o;
    })()`);
    const infoFilled = Object.keys(info).filter(k => info[k] !== '–' && info[k] !== 'MISSING').length;
    console.log("info filled: " + infoFilled + "/7  " + JSON.stringify(info));

    // --- 5) a task still works (no regression of the checker)
    // A "cd /root" az 1. feladatot (index 0) teljesiti, ezert azt ellenorizzuk.
    const oneTask = await evaluate(ws, `(function(){
      return window.__guestRun('cd /root').then(function(r){ return { out: r.out }; });
    })()`);
    const taskOk = await evaluate(ws, `(function(){
      return window.__checkOne(0).then(function(ok){ return ok; });
    })()`);
    console.log("guestRun: " + JSON.stringify(oneTask) + " | checkOne(0) [cd /root]: " + taskOk);

    // after the check the command bar must be usable again
    const barBack = await evaluate(ws, `(function(){
      var i = document.querySelector('.dtx-input'), b = document.querySelector('.dtx-run');
      return !!i && !!b && !i.disabled && !b.disabled;
    })()`);
    console.log("cmdbar re-enabled after check: " + barBack);

    console.log("disk stats: " + await evaluate(ws, "JSON.stringify(window.__diskStats)"));
    console.log("page errors: " + (pageErrors.length ? pageErrors.slice(0, 5).join(" | ") : "none"));

    const ok = tabTest.helpOn && tabTest.backOk && chipTest.count > 0 &&
               chipTest.filled && ranOk && infoFilled >= 5 && taskOk && barBack;
    console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");

    proc.kill();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.log("ERROR: " + e.message);
    proc.kill();
    process.exit(1);
  }
})();
