/*
 * Végigméri a feladat.html-t: elindítja a vendéget, majd minden feladatot
 * megold a hint parancsával, és ellenőrzi, hogy az "Ellenőrzés" PASS-t ad.
 *
 * Használat: node cdp-tasks.js <url> [outPng]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const URL_ = process.argv[2] || "http://localhost:8097/feladat.html";
const OUT_PNG = process.argv[3] || "";
const PORT = 9337;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
const profile = path.join(process.env.TEMP, "cdp-t-" + Date.now());

const proc = spawn(exe, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profile, "--remote-debugging-port=" + PORT,
  "--window-size=1400,900", URL_
], { stdio: ["ignore", "pipe", "pipe"] });

const getJSON = p => new Promise((res, rej) => {
  http.get("http://127.0.0.1:" + PORT + p, r => {
    let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

async function endpoint() {
  for (let i = 0; i < 160; i++) {
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
    let buf = Buffer.alloc(0), upgraded = false, handlers = [];
    let onData = () => {};
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const i = buf.indexOf("\r\n\r\n");
        if (i === -1) return;
        const head = buf.subarray(0, i).toString();
        if (!/101/.test(head)) return reject(new Error(head));
        buf = buf.subarray(i + 4); upgraded = true;
        resolve({
          onMessage(h) { handlers.push(h); },
          send(obj) {
            const data = Buffer.from(JSON.stringify(obj));
            const mask = crypto.randomBytes(4);
            let hdr;
            if (data.length < 126) hdr = Buffer.from([0x81, 0x80 | data.length]);
            else if (data.length < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(data.length, 2); }
            else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(data.length), 2); }
            const m = Buffer.alloc(data.length);
            for (let i2 = 0; i2 < data.length; i2++) m[i2] = data[i2] ^ mask[i2 % 4];
            sock.write(Buffer.concat([hdr, mask, m]));
          },
          close() { try { sock.destroy(); } catch (e) {} }
        });
      } else onData();
    });
    onData = () => {
      while (true) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1) handlers.forEach(h => h(payload.toString("utf8")));
      }
    };
  });
}

(async () => {
  const list = await endpoint();
  const page = list.find(t => t.type === "page") || list[0];
  const ws = await wsConnect(page.webSocketDebuggerUrl);

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onMessage(txt => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(
      m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ""));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")
      errors.push((m.params.args || []).map(a => a.value || a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error")
      errors.push(m.params.entry.text);
  });

  const send = (method, params) => new Promise(res => {
    const myId = ++id; pending.set(myId, res);
    ws.send({ id: myId, method, params: params || {} });
  });

  await send("Runtime.enable");
  await send("Log.enable");

  const evalJS = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return "EVAL ERROR: " + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const status = () => evalJS(`document.getElementById('status-text').textContent`);

  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 1500));
    if (await status() === "Kész") { ok = true; break; }
  }
  const bootSecs = Math.round((Date.now() - t0) / 1000);
  console.log("READY:", ok, "in", bootSecs + "s");
  if (!ok) {
    console.log("status:", await status());
    console.log("errors:", errors.join(" | "));
    process.exit(1);
  }

  const hints = await evalJS(`Array.from(document.querySelectorAll('.task')).map((c,i)=>i)`);
  const total = await evalJS(`window.__tasks().length`);
  console.log("tasks:", total);

  // 1) A "rossz" eset: mindent ellenőrzünk, mielőtt bármit megoldanánk.
  const before = await evalJS(`(async () => { await window.__checkOne(0); return window.__tasks(); })()`);
  console.log("uprightness check (task 1 before solving) ->", JSON.stringify(before[0]));

  // 2) Minden feladat megoldása a saját hint parancsával, majd ellenőrzés.
  let pass = 0;
  const hintsArr = await evalJS(`Array.from(document.querySelectorAll('.hint')).map(h=>h.textContent)`);

  for (let i = 0; i < total; i++) {
    const hint = hintsArr[i];
    const solved = await evalJS(`(async () => { const r = await window.__guestRun(${JSON.stringify(hint)}); return r.out; })()`);
    const res = await evalJS(`(async () => { await window.__checkOne(${i}); return window.__tasks(); })()`);
    const good = res[i] === true;
    if (good) pass++;
    console.log((good ? "  OK   " : "  FAIL ") + (i + 1) + "  " + hint);
    if (!good) console.log("        solve-out: " + JSON.stringify(String(solved).slice(-220)));
  }

  console.log("passed " + pass + "/" + total);

  // 3) A "Mind ellenőrzése" gomb is működjön (idempotens a kész feladatokra).
  const all = await evalJS(`(async () => {
    document.getElementById('check-all').click();
    const t = Date.now();
    while (document.getElementById('check-all').disabled && Date.now() - t < 120000) {
      await new Promise(r => setTimeout(r, 500));
    }
    return { tasks: window.__tasks(), progress: document.getElementById('progress-text').textContent };
  })()`);
  const allDone = all.tasks.every(v => v === true);
  console.log("check-all:", allDone ? "OK" : "FAIL", "| progress:", all.progress);

  // 4) Újrakezdés után minden eredmény null, a fájlok eltűntek.
  const reset = await evalJS(`(async () => {
    document.getElementById('reset').click();
    const t = Date.now();
    while (document.getElementById('reset').disabled && Date.now() - t < 60000) {
      await new Promise(r => setTimeout(r, 400));
    }
    const gone = await window.__guestRun('test -e /root/labor && echo STILL_THERE || echo GONE');
    return { tasks: window.__tasks(), gone: gone.out, progress: document.getElementById('progress-text').textContent };
  })()`);
  const resetOk = reset.tasks.every(v => v === null) && /GONE/.test(reset.gone);
  console.log("reset:", resetOk ? "OK" : "FAIL", "|", reset.progress.trim(), "|", reset.gone.trim().split("\n").pop());

  const stats = await evalJS(`window.__diskStats ? JSON.stringify(window.__diskStats) : "n/a"`);
  console.log("disk stats:", stats);
  console.log("page errors:", errors.length ? errors.join(" | ") : "none");

  if (OUT_PNG) {
    // A képhez állítsuk vissza a kész állapotot, hogy látszódjon a kész panel.
    await evalJS(`(async () => {
      await window.__guestRun('cd /root && echo "Debian 12" > verzio.txt');
      await window.__checkAll();
    })()`);
    await new Promise(r => setTimeout(r, 1200));
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT_PNG, Buffer.from(shot.result.data, "base64"));
      console.log("screenshot:", OUT_PNG);
    }
  }

  ws.close(); proc.kill();
  const success = pass === total && allDone && resetOk && before[0] !== true && errors.length === 0;
  setTimeout(() => process.exit(success ? 0 : 2), 400);
})().catch(e => { console.error("FATAL", e); try { proc.kill(); } catch (x) {} process.exit(1); });
