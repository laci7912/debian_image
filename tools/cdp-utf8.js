/*
 * Ellenőrzi, hogy az ÉKEZETES bevitel helyesen jut-e el a vendéghez.
 * A parancssávon (nem a __guestRun-on) keresztül küld, mert a tanuló is így
 * gépel – így a sendText() javítás valós útját méri.
 *
 * Használat: node cdp-utf8.js <url>
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const URL_ = process.argv[2] || "http://localhost:8097/index.html";
const PORT = 9343;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const exe = fs.existsSync(EDGE) ? EDGE : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = path.join(process.env.TEMP, "cdp-u-" + Date.now());

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
  let list;
  for (let i = 0; i < 160; i++) {
    try { list = await getJSON("/json/list"); if (list && list.length) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const page = list.find(t => t.type === "page") || list[0];
  const ws = await wsConnect(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const errors = [];
  ws.onMessage(txt => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text);
  });
  const send = (method, params) => new Promise(res => { const myId = ++id; pending.set(myId, res); ws.send({ id: myId, method, params: params || {} }); });
  await send("Runtime.enable");
  const evalJS = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return "EVAL ERROR: " + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 1500));
    if (await evalJS(`document.getElementById('status-text').textContent === 'Kész'`)) break;
  }
  console.log("boot:", Math.round((Date.now() - t0) / 1000) + "s");

  const termText = () => evalJS(`window.__termText()`);

  // Az ékezetes szöveget a parancssávon keresztül küldjük – ez a tanuló útja.
  const cases = [
    // A "é" UTF-8-ban c3 a9. Ha a régi hibás út menne, e9 lenne.
    ["printf 'B\\xc3\\xa9la' | od -An -tx1", "c3 a9"],
    ["echo árvíztűrő > /tmp/utf8.txt; od -An -tx1 /tmp/utf8.txt",
     "c3 a1 72 76 c3 ad 7a 74 c5 b1 72 c5 91 0a"],
    ["grep -c . /tmp/utf8.txt", null],
    ["wc -c < /tmp/utf8.txt", "14"],
    ["sed 's/ő/Ő/' /tmp/utf8.txt | od -An -tx1",
     "c3 a1 72 76 c3 ad 7a 74 c5 b1 72 c5 90 0a"]
  ];

  let pass = 0;
  for (let n = 0; n < cases.length; n++) {
    const cmd = cases[n][0];
    const want = cases[n][1];
    const mark = "__U" + (n + 1) + "__";
    await evalJS(`(() => { const i = document.getElementById('cmd'); i.value = ${JSON.stringify(cmd + "; echo " + mark)}; document.getElementById('run').click(); return 1; })()`);
    let txt = "", done = false;
    const dl = Date.now() + 60000;
    while (Date.now() < dl) {
      await new Promise(r => setTimeout(r, 400));
      txt = await termText();
      if (txt.split("\n").some(r => r.trim() === mark)) { done = true; break; }
    }
    const norm = s => s.replace(/\s+/g, " ");
    const good = done && (want === null || norm(txt).includes(norm(want)));
    if (good) pass++;
    console.log((good ? "  OK   " : "  FAIL ") + cmd);
    if (!good) {
      const tail = txt.split("\n").filter(l => l.trim()).slice(-6).join(" | ");
      console.log("        done=" + done + " want=" + want + " got: " + tail.slice(0, 260));
    }
  }
  console.log("passed " + pass + "/" + cases.length);
  console.log("page errors:", errors.length ? errors.join(" | ") : "none");

  ws.close(); proc.kill();
  setTimeout(() => process.exit(pass === cases.length && errors.length === 0 ? 0 : 2), 300);
})().catch(e => { console.error("FATAL", e); try { proc.kill(); } catch (x) {} process.exit(1); });
