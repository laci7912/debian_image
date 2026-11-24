/*
 * Tetszőleges shell-parancsokat futtat a vendégben és kiírja a nyers kimenetet.
 * Használat: node cdp-probe.js <url> "<cmd1>" "<cmd2>" ...
 * A parancsokat a page-en lévő window.__guestRun-nal hajtja végre.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const URL_ = process.argv[2];
const CMDS = process.argv.slice(3);
const PORT = 9339;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const exe = fs.existsSync(EDGE) ? EDGE : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = path.join(process.env.TEMP, "cdp-p-" + Date.now());

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
  ws.onMessage(txt => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  const send = (method, params) => new Promise(res => {
    const myId = ++id; pending.set(myId, res);
    ws.send({ id: myId, method, params: params || {} });
  });

  await send("Runtime.enable");
  const evalJS = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return "EVAL ERROR: " + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 1500));
    if (await evalJS(`window.__ready ? window.__ready() : (document.getElementById('status-text').textContent === 'Kész')`)) break;
  }
  console.log("boot:", Math.round((Date.now() - t0) / 1000) + "s");

  for (const c of CMDS) {
    const out = await evalJS(`(async () => { const r = await window.__guestRun(${JSON.stringify(c)}, 30000); return r.out; })()`);
    console.log("\n=== " + c);
    console.log(String(out));
  }

  ws.close(); proc.kill();
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error("FATAL", e); try { proc.kill(); } catch (x) {} process.exit(1); });
