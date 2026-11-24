/*
 * A VALÓDI tanulói út: a terminálba gépelés (nem parancssáv, nem __guestRun).
 *
 * A CDP Input.insertText / Input.dispatchKeyEvent az xterm.js rejtett
 * textarea-jába ír, onnan megy term.onData -> sendText -> v86 soros port.
 * Ez pontosan az, amit a tanuló csinál a billentyűzetével.
 *
 * Használat: node cdp-typing.js <url> [outPng]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");

const URL_ = process.argv[2] || "http://localhost:8097/feladat.html";
const OUT_PNG = process.argv[3] || "";
const PORT = 9347;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const exe = fs.existsSync(EDGE) ? EDGE : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = path.join(process.env.TEMP, "cdp-k-" + Date.now());

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
  let id = 0; const pending = new Map(); const errors = [];
  ws.onMessage(txt => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.text);
  });
  const send = (method, params) => new Promise(res => { const myId = ++id; pending.set(myId, res); ws.send({ id: myId, method, params: params || {} }); });
  await send("Runtime.enable");
  await send("Input.enable").catch(() => {});
  const evalJS = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return "EVAL ERROR: " + JSON.stringify(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const status = () => evalJS(`document.getElementById('status-text').textContent`);
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await new Promise(r => setTimeout(r, 1500));
    if (await status() === "Kész") break;
  }
  console.log("boot:", Math.round((Date.now() - t0) / 1000) + "s");

  const termText = () => evalJS(`window.__termText()`);

  // A terminál fókusza: a tanuló is oda kattint (az oldal amúgy is fókuszál).
  async function focusTerm() {
    await evalJS(`(() => { const el = document.querySelector('#terminal-host textarea'); if (el) el.focus(); return !!el; })()`);
  }

  // Betűnként gépelünk, hogy a valódi billentyűzet-utat használjuk.
  async function typeText(s) {
    for (const ch of s) {
      await send("Input.insertText", { text: ch });
      await new Promise(r => setTimeout(r, 12));
    }
  }

  async function pressEnter() {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter", code: "Enter" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
  }

  await focusTerm();

  // 1) Alap gépelés: látszik-e a beírt szöveg és a kimenet?
  await typeText("echo KEZELES_MUKODIK");
  await pressEnter();
  await new Promise(r => setTimeout(r, 2000));
  let txt = await termText();
  const typedOnce = txt.includes("KEZELES_MUKODIK");
  console.log("typing reaches guest:", typedOnce ? "OK" : "FAIL");

  // 2) Ékezetes gépelés a terminálból
  await focusTerm();
  await typeText("echo árvíztűrő");
  await pressEnter();
  await new Promise(r => setTimeout(r, 2000));
  txt = await termText();
  const accentsOk = txt.includes("árvíztűrő") && !txt.includes("Ã");
  console.log("accents from terminal:", accentsOk ? "OK" : "FAIL");

  // 3) A 10 feladat: a hint parancsokat BEGÉPELJÜK, majd Ellenőrzés gomb.
  const hints = await evalJS(`Array.from(document.querySelectorAll('.hint')).map(h=>h.textContent)`);
  let pass = 0;
  for (let i = 0; i < hints.length; i++) {
    await focusTerm();
    await typeText(hints[i]);
    await pressEnter();
    await new Promise(r => setTimeout(r, 1800));
    await evalJS(`(async () => { await window.__checkOne(${i}); return 1; })()`);
    const res = await evalJS(`window.__tasks()`);
    if (res[i] === true) pass++;
    console.log((res[i] === true ? "  OK   " : "  FAIL ") + (i + 1) + "  " + hints[i]);
  }
  console.log("typed student flow:", pass + "/" + hints.length);

  // 4) Ellenőrzés után a gépelés továbbra is működik?
  await focusTerm();
  await typeText("echo UTANA_IS_MUKODIK");
  await pressEnter();
  await new Promise(r => setTimeout(r, 2000));
  txt = await termText();
  const afterOk = (txt.match(/UTANA_IS_MUKODIK/g) || []).length >= 2;
  console.log("typing after check:", afterOk ? "OK" : "FAIL");

  if (OUT_PNG) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(OUT_PNG, Buffer.from(shot.result.data, "base64"));
      console.log("screenshot:", OUT_PNG);
    }
  }

  console.log("page errors:", errors.length ? errors.join(" | ") : "none");
  ws.close(); proc.kill();
  const ok = typedOnce && accentsOk && pass === hints.length && afterOk && errors.length === 0;
  setTimeout(() => process.exit(ok ? 0 : 2), 400);
})().catch(e => { console.error("FATAL", e); try { proc.kill(); } catch (x) {} process.exit(1); });
