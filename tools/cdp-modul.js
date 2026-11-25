/*
 * A beépíthető terminál modul (js/debian-terminal.js) ellenőrzése.
 *
 * Azt méri, amit egy beépítésnél ellenőrizni kell:
 *  - a modul magától betölti-e a függőségeit
 *  - elindul-e a vendég
 *  - működik-e a `run()` API (kimenet szövege)
 *  - a konténer átméretezésekor igazodik-e a terminál
 *  - két példány él-e egyszerre ugyanazon az oldalon
 *  - a `destroy()` rendben eldobja-e az emulátort
 *
 * Használat: node cdp-modul.js <url vagy fajl>
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

let target = process.argv[2] || "http://localhost:8097/beepites-pelda.html";
if (!/^https?:/.test(target)) {
  if (!fs.existsSync(target)) { console.error("Nincs ilyen fájl: " + target); process.exit(1); }
  target = "file:///" + path.resolve(target).replace(/\\/g, "/");
}

const PORT = 9353;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
const profile = path.join(process.env.TEMP, "cdp-mod-" + Date.now());

const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--allow-file-access-from-files",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + PORT,
  "--window-size=1500,950", target
], { stdio: ["ignore", "pipe", "pipe"] });

const errs = [];
proc.stderr.on("data", d => {
  const s = d.toString();
  if (/fallback_task_provider|elevation_service|LaunchUpdateCmd|Fontconfig|GPU|gles|Vulkan|dbus|DevTools|CONSOLE/i.test(s)) return;
  if (/ERROR|error/i.test(s)) errs.push(s.trim().slice(0, 200));
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
    let buf = Buffer.alloc(0), upgraded = false, onMsg = null;
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
            const m = Buffer.alloc(p.length);
            for (let k = 0; k < p.length; k++) m[k] = p[k] ^ mask[k % 4];
            sock.write(Buffer.concat([head, mask, m]));
          },
          onMessage(cb) { onMsg = cb; },
          close() { try { sock.destroy(); } catch (e) {} }
        });
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const pl = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 8) return;
        if (op === 1) { try { if (onMsg) onMsg(JSON.parse(pl.toString())); } catch (e) {} }
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 180000);
  });
}

async function evaluate(ws, expr) {
  const r = await rpc(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("JS: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitReady(ws, expr, secs) {
  const t0 = Date.now();
  for (let i = 0; i < (secs || 120) * 4; i++) {
    try { if (await evaluate(ws, expr)) return Math.round((Date.now() - t0) / 1000); } catch (e) {}
    await sleep(250);
  }
  return -1;
}

(async () => {
  let fails = 0;
  const check = (name, ok, extra) => {
    console.log((ok ? "  OK   " : "  FAIL ") + name + (extra ? "  " + extra : ""));
    if (!ok) fails++;
  };

  try {
    const list = await endpoint();
    const page = list.find(t => t.type === "page") || list[0];
    const ws = await wsConnect(page.webSocketDebuggerUrl);
    ws.onMessage(m => { if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
    await rpc(ws, "Runtime.enable");
    await sleep(400);

    // 1) a modul betöltődött és a függőségeit is behúzta
    const api = await evaluate(ws, "typeof DebianTerminal + '/' + (DebianTerminal && DebianTerminal.version)");
    check("DebianTerminal API", /^object\/\d/.test(api), api);

    const cssOk = await evaluate(ws, "!!document.querySelector('.dtx') && !!document.querySelector('.dtx-host') && !!document.querySelector('.dtx-cmdbar')");
    check("modul DOM felépült (dtx-* osztályok)", cssOk);

    const styled = await evaluate(ws, `(function(){
      var h = document.querySelector('.dtx .dtx-host');
      if (!h) return 'nincs host';
      return getComputedStyle(document.querySelector('.dtx')).display + '/' +
             (document.querySelector('.dtx').getBoundingClientRect().height > 100);
    })()`);
    check("stílus érvényesül (flex + magasság)", /^flex\/true$/.test(styled), styled);

    // 2) a vendég indulását megvárjuk, majd a függőségeket ellenőrizzük
    const readySecs = await waitReady(ws, "window.__t0 && window.__t0.isReady()", 150);
    check("vendég elindult", readySecs >= 0, readySecs >= 0 ? readySecs + " s" : "");

    const deps = await evaluate(ws, "typeof Terminal + '/' + typeof V86 + '/' + typeof LazyDisk + '/' + typeof FitAddon");
    check("függőségek magától betöltve", /^function\/function\/function\/object$/.test(deps), deps);

    // 3) run() API – a kimenet valódi
    const ls = await evaluate(ws, `window.__t0.run('echo MODUL-$$').then(function(r){ return r.out; })`);
    check("run() kimenete", /MODUL-/.test(String(ls)), JSON.stringify(String(ls).slice(0, 60)));

    const osr = await evaluate(ws, `window.__t0.run('cat /etc/os-release | head -2').then(function(r){ return r.out; })`);
    check("run() os-release", /Debian|bookworm/i.test(String(osr)), JSON.stringify(String(osr).slice(0, 70)));

    // 4) info()
    const info = await evaluate(ws, "JSON.stringify(window.__t0.info())");
    check("info() kitöltve", /debian-web/.test(String(info)), String(info).slice(0, 110));

    // 5) átméretezés: a konténer szűkítése után kevesebb oszlop kell
    const before = await evaluate(ws, "window.__t0.term.cols");
    await evaluate(ws, `(function(){
      var e = document.getElementById('term');
      e.style.flex = '0 0 auto';
      e.style.width = '520px';
      e.style.height = '420px';
      return e.getBoundingClientRect().width;
    })()`);
    await sleep(900);
    const after = await evaluate(ws, "window.__t0.term.cols");
    check("ResizeObserver átméretez", after !== before, before + " -> " + after + " oszlop");
    await evaluate(ws, `(function(){
      var e = document.getElementById('term');
      e.style.flex = ''; e.style.width = ''; e.style.height = '';
    })()`);
    await sleep(500);

    // 6) két példány egyszerre
    const two = await evaluate(ws, `(function(){
      var d = document.createElement('div');
      d.id = 'masodik';
      d.style.height = '260px';
      d.style.width = '500px';
      document.body.appendChild(d);
      window.__t1 = DebianTerminal.create(d);
      return 'letrehozva';
    })()`);
    const twoReady = await waitReady(ws, "window.__t1 && window.__t1.isReady()", 150);
    check("2. példány is elindul", twoReady >= 0, twoReady >= 0 ? twoReady + " s" : two);
    const twoRun = await evaluate(ws, `window.__t1.run('echo MASODIK-$$').then(function(r){ return r.out; })`);
    check("2. példány run()", /MASODIK-/.test(String(twoRun)), JSON.stringify(String(twoRun).slice(0, 50)));

    // 7) destroy()
    await evaluate(ws, "window.__t1.destroy(); 'kesz'");
    await sleep(600);
    const gone = await evaluate(ws, "document.getElementById('masodik').innerHTML.length === 0 && window.__t1.term === null");
    check("destroy() kitakarít", gone);

    // 8) az első példány még mindig él
    const stillOk = await evaluate(ws, `window.__t0.run('echo ELEK-$$').then(function(r){ return r.out; })`);
    check("destroy() nem rontja el a többit", /ELEK-/.test(String(stillOk)));

    // 9) restart()
    await evaluate(ws, "window.__t0.restart(); 'indul'");
    const reReady = await waitReady(ws, "window.__t0.isReady()", 150);
    check("restart() újraindul", reReady >= 0, reReady >= 0 ? reReady + " s" : "");

    console.log("  page errors: " + (errs.length ? errs.slice(0, 3).join(" | ") : "none"));
    console.log(fails === 0 ? "\nMINDEN OK" : "\n" + fails + " ELLENORZES BUKOTT");

    proc.kill();
    process.exit(fails === 0 ? 0 : 1);
  } catch (e) {
    console.log("ERROR: " + e.message);
    proc.kill();
    process.exit(1);
  }
})();
