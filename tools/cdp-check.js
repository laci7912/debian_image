/*
 * End-to-end check of a webterm page: boots the guest, runs commands through
 * the command bar, and verifies the output really came from the guest.
 *
 * Usage: node cdp-check.js <url> [outPng]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const URL_ = process.argv[2] || "http://localhost:8099/github-version/index.html";
const OUT_PNG = process.argv[3] || "";
const PORT = 9335;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;
const profile = path.join(process.env.TEMP, "cdp-" + Date.now());

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

  const termText = () => evalJS(`Array.from(document.querySelectorAll('#terminal-host .xterm-rows > div')).map(r=>r.textContent).join('\\n')`);
  const status = () => evalJS(`document.getElementById('status-text').textContent`);

  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 1500));
    if (await status() === "Kész") { ok = true; break; }
  }
  console.log("READY:", ok, "in", Math.round((Date.now() - t0) / 1000) + "s");
  if (!ok) {
    console.log("status:", await status());
    console.log(await termText());
    console.log("errors:", errors.join(" | "));
    process.exit(1);
  }

  const cases = [
    ["cat /etc/debian_version", /^12\.15$/m],
    ["hostname", /^debian-web$/m],
    ["uname -m", /^i686$/m],
    ["dpkg-query -W -f='${Package}\\n' | wc -l", /^16[0-9]$/m],
    ["cat /etc/fstab", /^LABEL=debian-root/m],
    ["test -x /usr/bin/bash && echo HAS_BASH", /^HAS_BASH$/m]
  ];

  let pass = 0;
  let n = 0;
  for (const [cmd, re] of cases) {
    n++;
    const mark = "__DONE_" + n + "__";
    await evalJS(`(() => { const i = document.getElementById('cmd'); i.value = ${JSON.stringify(cmd + "; echo " + mark)}; document.getElementById('run').click(); return 1; })()`);
    // The echoed command line also contains the marker (and gets wrapped), so
    // only a *row that is exactly the marker* proves the command finished.
    let txt = "", done = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400));
      txt = await termText();
      if (txt.split("\n").some(r => r.trim() === mark)) { done = true; break; }
    }
    const good = done && re.test(txt);
    if (good) pass++;
    console.log((good ? "  OK   " : "  FAIL ") + cmd);
    if (!good) {
      const tail = txt.split("\n").filter(l => l.trim()).slice(-8).join(" | ");
      console.log("        done=" + done + " got: " + tail.slice(0, 300));
    }
  }
  console.log("passed " + pass + "/" + cases.length);

  const stats = await evalJS(`window.__diskStats ? JSON.stringify(window.__diskStats) : "n/a"`);
  console.log("disk stats:", stats);
  console.log("panel:", await evalJS(`['k-name','k-ver','k-host','k-kernel','k-fs','k-dev','k-pkgs'].map(k=>{const e=document.getElementById(k);return e?e.textContent:'?'}).join(' / ')`));
  console.log("page errors:", errors.length ? errors.join(" | ") : "none");

  if (OUT_PNG) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT_PNG, Buffer.from(shot.result.data, "base64"));
      console.log("screenshot:", OUT_PNG);
    }
  }

  ws.close(); proc.kill();
  setTimeout(() => process.exit(pass === cases.length ? 0 : 2), 400);
})().catch(e => { console.error("FATAL", e); try { proc.kill(); } catch (x) {} process.exit(1); });
