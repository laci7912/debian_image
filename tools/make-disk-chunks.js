/*
 * Turns debian_hda.img into the chunk set the web page fetches.
 *
 * Output (under <outDir>/):
 *   manifest.json            total size, chunk size, which chunks exist
 *   000/000000.gz ...        gzip'd 512 KiB chunks, grouped 256 per folder
 *
 * All-zero chunks are skipped entirely; the page treats a 404 as a hole.
 * A real boot reads about 7 MiB, so only a handful of chunks are ever fetched.
 *
 * Two modes:
 *   full     every non-zero chunk (the image is fully usable)
 *   minimal  only the chunks listed in a whitelist file (e.g. boot + demo
 *            commands), giving a very small repository
 *
 * Usage:
 *   node make-disk-chunks.js --full     [img] [out]
 *   node make-disk-chunks.js --minimal <listFile> [img] [out]
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const args = process.argv.slice(2);
let mode = "full";
let listFile = null;
let rest = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--full") mode = "full";
  else if (args[i] === "--minimal") { mode = "minimal"; listFile = args[++i]; }
  else rest.push(args[i]);
}

const imgPath = rest[0] || path.join(__dirname, "..", "..", "debian_hda.img");
const outDir  = rest[1] || path.join(__dirname, "..", "disk");
const CHUNK   = Number(rest[2] || 512 * 1024);
const SHARD   = 256;

const size = fs.statSync(imgPath).size;
if (size % 512 !== 0) {
  console.error("A kép mérete nem 512 bájt többszöröse, ezért nem lehet lemezként használni.");
  process.exit(1);
}

let wanted = null;
if (mode === "minimal") {
  if (!listFile) { console.error("--minimal módhoz kell a chunk-lista fájl."); process.exit(1); }
  const spec = JSON.parse(fs.readFileSync(listFile, "utf8"));
  wanted = new Set(spec.present);
  if (spec.chunkSize && spec.chunkSize !== CHUNK) {
    console.error("A lista chunk mérete (" + spec.chunkSize + ") eltér a kérttől (" + CHUNK + ").");
    process.exit(1);
  }
  console.log("minimal mód: " + wanted.size + " chunk a listából");
}

fs.mkdirSync(outDir, { recursive: true });
// clear previous chunk folders
for (const ent of fs.readdirSync(outDir)) {
  const p = path.join(outDir, ent);
  if (/^\d{3}$/.test(ent) && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
  else if (/\.gz$/.test(ent)) fs.unlinkSync(p);
}

const total = Math.ceil(size / CHUNK);
const fd = fs.openSync(imgPath, "r");
const present = [];
let gzBytes = 0, rawKept = 0, maxGz = 0, skippedZero = 0, skippedFilter = 0;
const t0 = Date.now();

for (let i = 0; i < total; i++) {
  const off = i * CHUNK;
  const len = Math.min(CHUNK, size - off);
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, off + got);
    if (n <= 0) throw new Error("rövid olvasás a " + off + " pozíciónál");
    got += n;
  }

  if (wanted && !wanted.has(i)) { skippedFilter++; continue; }

  let zero = true;
  for (let j = 0; j < len; j++) if (buf[j]) { zero = false; break; }
  if (zero) { skippedZero++; continue; }

  const gz = zlib.gzipSync(buf, { level: 9 });
  const useGz = gz.length < len;
  const payload = useGz ? gz : buf;

  const shard = ("000" + Math.floor(i / SHARD)).slice(-3);
  fs.mkdirSync(path.join(outDir, shard), { recursive: true });
  fs.writeFileSync(path.join(outDir, shard, ("000000" + i).slice(-6) + ".gz"), payload);

  present.push(i);
  rawKept += len;
  gzBytes += payload.length;
  if (payload.length > maxGz) maxGz = payload.length;

  if (i % 100 === 0) process.stdout.write("\r  " + i + "/" + total + ", " + (gzBytes / 1048576).toFixed(1) + " MiB   ");
}
fs.closeSync(fd);

fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
  size,
  chunkSize: CHUNK,
  shardSize: SHARD,
  chunks: total,
  present,
  mode,
  generated: new Date().toISOString()
}, null, 1));

const MB = 1048576;
console.log("\r" + "=".repeat(56));
console.log("mode           : " + mode);
console.log("image size     : " + (size / MB).toFixed(1) + " MiB");
console.log("chunk size     : " + (CHUNK / 1024).toFixed(0) + " KiB (" + total + " chunks)");
console.log("files written  : " + present.length);
if (skippedZero)   console.log("zero chunks    : " + skippedZero + " (skipped)");
if (skippedFilter) console.log("filtered out   : " + skippedFilter + " (not in whitelist)");
console.log("on disk        : " + (gzBytes / MB).toFixed(1) + " MiB");
console.log("largest chunk  : " + (maxGz / 1024).toFixed(0) + " KiB");
console.log("elapsed        : " + ((Date.now() - t0) / 1000).toFixed(0) + " s");
console.log("output         : " + outDir);
