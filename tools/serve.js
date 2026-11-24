/*
 * Helyi statikus szerver ehhez a mappához.
 *
 * Csak akkor kell, ha helyben akarod kipróbálni: a böngésző a file:// címről
 * nem engedi a fetch-et, ezért HTTP-n keresztül kell megnyitni az oldalt.
 *
 *   node tools/serve.js [port]
 *
 * Ez a szerver pontosan ezt a mappát szolgálja ki, ugyanúgy, ahogy a GitHub
 * Pages teszi, ezért a kipróbálás hiteles.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// A szerver a mappa gyökere, amiben a tools/ van.
const root = path.resolve(__dirname, "..");
const port = Number(process.argv[2] || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bat": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function sendFile(res, file, st, type, start, end) {
  const headers = start === undefined
    ? {
        "Content-Type": type,
        "Content-Length": st.size,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*"
      }
    : {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": "bytes " + start + "-" + end + "/" + st.size,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*"
      };

  res.writeHead(start === undefined ? 200 : 206, headers);

  const stream = start === undefined
    ? fs.createReadStream(file)
    : fs.createReadStream(file, { start, end });

  // A vendég gyakran megszakítja a kéréseket (a v86 visszavonja őket), ilyenkor
  // a socket bezárul. Kezeletlen hiba nélkül ez leállítaná a szervert.
  stream.on("error", function () { try { res.destroy(); } catch (e) {} });
  res.on("error", function () { try { stream.destroy(); } catch (e) {} });
  res.on("close", function () { try { stream.destroy(); } catch (e) {} });

  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(url.parse(req.url).pathname); }
  catch (e) { res.writeHead(400); return res.end("bad request"); }

  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end("not found"); }

    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) { res.writeHead(416); return res.end(); }
      let start = m[1] === "" ? null : Number(m[1]);
      let end = m[2] === "" ? null : Number(m[2]);
      if (start === null) { start = Math.max(0, st.size - end); end = st.size - 1; }
      else if (end === null || end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416); return res.end(); }
      sendFile(res, file, st, type, start, end);
    } else {
      sendFile(res, file, st, type);
    }
  });
});

server.listen(port, () => {
  console.log("");
  console.log("  Debian 12 webterm");
  console.log("  mappa    : " + root);
  console.log("  cim      : http://localhost:" + port + "/index.html");
  console.log("");
  console.log("  Leallitas: Ctrl+C");
  console.log("");
});

// Egy elszabadult hiba ne állítsa le a szervert.
process.on("uncaughtException", (e) => console.error("figyelmeztetés:", e.message));
process.on("unhandledRejection", (e) => console.error("figyelmeztetés:", e));
