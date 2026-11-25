/*
 * Előállítja a tanulónak kiosztandó EGYETLEN HTML fájlt.
 *
 * A tanuló ezt a fájlt megkapja, duplán kattint rá, és a böngészőjében elindul
 * egy valódi Debian 12 terminál. A lemez, a kernel és az emulátor a GitHub
 * repóból töltődik le, ezért a tanulónak nem kell semmit telepítenie.
 *
 * Használat:
 *   node make-student-file.js <mappa> <repo-url> [kimenet]
 *
 * Példa:
 *   node make-student-file.js . https://felhasznalo.github.io/debian-webterm/
 *   node make-student-file.js . https://raw.githubusercontent.com/felhasznalo/debian-webterm/main/
 *
 * A második paraméter a repó "gyökere", ahol az index.html, a disk/ és a boot/
 * mappa van. A végén lévő perjel kötelező.
 *
 * Minden hivatkozás ABSZOLÚT lesz, ezért a fájl file:// címről is működik:
 * a böngésző a repóból tölti le a szükséges darabokat.
 */
const fs = require("fs");
const path = require("path");

const edition = process.argv[2] || ".";
const base = process.argv[3];
const out = process.argv[4] || "debian-webterm.html";
const pageName = process.argv[5] || "index.html";

if (!base) {
  console.error("Használat: node make-student-file.js <mappa> <repo-url> [kimenet] [oldal]");
  console.error("");
  console.error("  <mappa>    az a mappa, ahol az index.html és a disk/ van (pl. .)");
  console.error("  <repo-url> a repó gyökere, perjellel a végén");
  console.error("             pl. https://felhasznalo.github.io/debian-webterm/");
  console.error("  [kimenet]  a létrehozandó fájl (alapból debian-webterm.html)");
  console.error("  [oldal]    melyik HTML-ből készüljön (alapból index.html)");
  console.error("             pl. feladat.html – a gyakorló feladatos változat");
  process.exit(1);
}

const root = path.resolve(edition);
const indexPath = path.join(root, pageName);

if (!fs.existsSync(indexPath)) {
  console.error("Nem találom: " + indexPath);
  process.exit(1);
}
if (!/\/$/.test(base)) {
  console.error("A repó URL végén perjel kell lennie: " + base + "/");
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "disk", "manifest.json"))) {
  console.error("Nem találom a disk/manifest.json fájlt. Ez nem egy kiadás mappája?");
  process.exit(1);
}

let html = fs.readFileSync(indexPath, "utf8");

// A relatív hivatkozásokat abszolútra cseréljük. Minden ilyen hely egy helyen
// van, hogy a csere egyértelmű legyen (és ne nyúljon a magyar szöveghez).
// Kétféle oldalt ismer: a régi, közvetlenül v86-ot használó oldalt (index.html,
// feladat.html) és az új, beépíthető modulra épülőt (feladat-terminal.html).
const replacements = [
  // — beépíthető modul (feladat-terminal.html) —
  ['src="js/debian-terminal.js"',    'src="' + base + 'js/debian-terminal.js"'],
  ['baseUrl: "."',                   'baseUrl: "' + base + '"'],

  // — közvetlen v86 (index.html, feladat.html) —
  ['href="vendor/xterm.css"',        'href="' + base + 'vendor/xterm.css"'],
  ['src="vendor/xterm.js"',          'src="' + base + 'vendor/xterm.js"'],
  ['src="vendor/addon-fit.js"',      'src="' + base + 'vendor/addon-fit.js"'],
  ['src="v86/libv86.js"',            'src="' + base + 'v86/libv86.js"'],
  ['src="js/lazydisk.js"',           'src="' + base + 'js/lazydisk.js"'],
  ['var DISK_DIR     = "disk";',     'var DISK_DIR     = "' + base + 'disk";'],
  ['var BZIMAGE_URL  = "boot/bzimage";',      'var BZIMAGE_URL  = "' + base + 'boot/bzimage";'],
  ['var INITRD_URL   = "boot/initramfs.gz";', 'var INITRD_URL   = "' + base + 'boot/initramfs.gz";'],
  ['var V86_DIR      = "v86/";',     'var V86_DIR      = "' + base + 'v86/";']
];

// Csak azokat a helyeket cseréljük, amelyek tényleg benne vannak: a két oldal-
// típus mást tartalmaz, és nem hiba, ha a másik típus részei hiányoznak –
// de legalább egy cserének meg kell történnie.
let done = 0;
for (const [from, to] of replacements) {
  if (!html.includes(from)) continue;
  html = html.split(from).join(to);
  done++;
}

if (done === 0) {
  console.error("HIBA: egyetlen hivatkozást sem találtam a(z) " + pageName + " fájlban.");
  console.error("Megváltozott a HTML? Frissítsd ezt a szkriptet is.");
  process.exit(1);
}

// A modul a saját <script> címéből is meg tudja állapítani a repót, de a
// baseUrl opciót kifejezetten felülírjuk, hogy file:// alól is biztos legyen.
if (!html.includes('src="' + base + 'js/debian-terminal.js"')) {
  console.error("HIBA: a terminál modul hivatkozása nem lett abszolút.");
  process.exit(1);
}

// Egy rövid fejléc, hogy a tanuló lássa, honnan jön a tartalom.
const banner =
  "<!--\n" +
  "  Debian 12 webterm – tanulói fájl\n" +
  "  Forrás: " + base + "\n" +
  "\n" +
  "  Ez a fájl önmagában is működik: dupla kattintás, és elindul a terminál.\n" +
  "  A Debian rendszer és az emulátor a fenti címről töltődik le.\n" +
  "  Internetkapcsolat kell hozzá.\n" +
  "-->\n";
html = banner + html;

fs.writeFileSync(out, html, "utf8");

const kb = Math.round(Buffer.byteLength(html, "utf8") / 1024);
console.log("");
console.log("  Elkészült: " + path.resolve(out));
console.log("  Méret    : " + kb + " KiB");
console.log("  Forrás   : " + base);
console.log("  Oldal    : " + pageName);
console.log("  Cserélt  : " + done + " hivatkozás");
console.log("");
console.log("  A tanuló ezt a fájlt kapja. Dupla kattintásra elindul,");
console.log("  de internet kell hozzá (a lemez a repóból töltődik).");
console.log("");
