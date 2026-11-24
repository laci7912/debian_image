/*
 * Prints the chunks the "lite" edition must ship, given a measurement run.
 *
 * Usage: node build-lite.js <measurement.json> [imgPath] [outDir]
 *
 * The measurement file is what cdp-measure.js records; this script simply
 * feeds its list to make-disk-chunks.js in --minimal mode.
 */
const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");

const measure = process.argv[2];
if (!measure || !fs.existsSync(measure)) {
  console.error("Használat: node build-lite.js <meres.json> [kep] [kimenet]");
  console.error("A meres.json a cdp-measure.js kimenete (present lista).");
  process.exit(1);
}

const img = process.argv[3] || path.join(__dirname, "..", "..", "debian_hda.img");
const out = process.argv[4] || path.join(__dirname, "..", "disk");

const spec = JSON.parse(fs.readFileSync(measure, "utf8"));
if (!Array.isArray(spec.present) || !spec.present.length) {
  console.error("A mérési fájlban nincs 'present' lista – nem a cdp-measure.js kimenete?");
  process.exit(1);
}

const r = spawnSync(process.execPath, [
  path.join(__dirname, "make-disk-chunks.js"),
  "--minimal", measure, img, out
], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
