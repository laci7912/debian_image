/*
 * Grows the "lite" chunk set until it is order-independent.
 *
 * Why this is needed: the first measurement recorded only the chunks the guest
 * actually asked the disk for. That set depends on command order, because the
 * guest kernel caches blocks: a command run later may never touch the disk for
 * data an earlier command had already loaded. Chunk 660 was invisible that way,
 * and /usr/bin/find came out as "Exec format error".
 *
 * This script closes the loop. It boots with the *current* lite set, and for
 * every chunk that is missing from it but non-zero in the image it records the
 * chunk and serves the real bytes anyway, so the command still succeeds. The
 * union over several shuffled passes is then safe for any order.
 *
 * Usage: node measure-union.js <inJson> <outJson> [passes] [imgPath]
 *
 *   inJson   a kiinduló darablista (pl. a jelenlegi disk/manifest.json)
 *   outJson  ide írja a bővített listát
 *   passes   hány kevert sorrendű menet fusson (alapból 2)
 *   imgPath  a debian_hda.img útja (alapból egy szinttel feljebb)
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..", "..");
// A saját mappa eszközeit használjuk, hogy ne függjön a webterm mappától.
const HERE = path.resolve(__dirname, "..");
const W = process.env.TEMP || "C:\\Temp";
const IMG = process.argv[5] || path.join(ROOT, "debian_hda.img");
const CHUNK = 512 * 1024;
const SIZE = fs.statSync(IMG).size;
const TOTAL = Math.ceil(SIZE / CHUNK);

const inJson = process.argv[2];
const outJson = process.argv[3];
const PASSES = Number(process.argv[4] || 2);

require(path.join(HERE, "js", "lazydisk.js"));
const LazyDisk = globalThis.LazyDisk;
const { V86 } = require(path.join(HERE, "v86", "libv86.js"));

const have = new Set(JSON.parse(fs.readFileSync(inJson, "utf8")).present);
const grown = new Set(have);
const served = new Set();      // chunks actually handed out (present or shadowed)
const shadowed = new Set();    // chunks NOT in `have` but needed

const chunkCache = new Map();
function readChunk(idx) {
  if (chunkCache.has(idx)) return chunkCache.get(idx);
  const off = idx * CHUNK;
  const len = Math.min(CHUNK, SIZE - off);
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(IMG, "r");
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, off + got);
    if (n <= 0) break;
    got += n;
  }
  fs.closeSync(fd);
  let zero = true;
  for (let i = 0; i < len; i++) if (buf[i]) { zero = false; break; }
  const out = zero ? null : zlib.gzipSync(buf, { level: 9 });
  chunkCache.set(idx, out);
  return out;
}

// No "present" list on purpose: the class must ask for every chunk, so the
// shim sees the real demand and can shadow-serve what the lite set lacks.
globalThis.fetch = async function (url) {
  const u = String(url);
  if (/manifest\.json$/.test(u)) {
    const b = Buffer.from(JSON.stringify({ size: SIZE, chunkSize: CHUNK, chunks: TOTAL }));
    return { status: 200, ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
  const idx = Number(/([0-9]{6})\.gz$/.exec(u)[1]);
  const gz = readChunk(idx);
  if (!gz) return { status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
  served.add(idx);
  if (!have.has(idx)) { shadowed.add(idx); grown.add(idx); }
  return { status: 200, ok: true, arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
};

const ab = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

// The two batteries, merged. Anything documented as working in the lite README
// must appear here, or the documentation is false.
const BATTERY = [
  // basics
  "hostname", "uname", "uname -a", "uname -r", "uname -m", "id", "whoami", "pwd", "date",
  "arch", "nproc", "tty", "echo hello", "seq 1 5", "true", "false",
  // directories
  "ls", "ls /", "ls -la /", "ls /etc", "ls -l /usr/bin/bash", "ls /boot", "ls /dev",
  "ls /tmp", "ls /root", "ls /home", "ls /var", "ls /var/log", "ls /var/lib/dpkg",
  "ls /usr", "ls /usr/bin", "ls /usr/sbin", "ls /usr/lib", "ls /usr/share", "ls /lib",
  "ls /sbin", "ls /bin", "ls /opt", "ls /srv", "ls /proc", "ls /sys", "ls /media", "ls /mnt",
  "ls /usr/bin | head -30", "ls /usr/bin | wc -l", "ls /etc | wc -l",
  // config files
  "cat /etc/hostname", "cat /etc/debian_version", "cat /etc/os-release", "cat /etc/passwd",
  "cat /etc/group", "cat /etc/shells", "cat /etc/issue", "cat /etc/motd", "cat /etc/fstab",
  "cat /etc/hosts", "cat /etc/resolv.conf", "cat /etc/apt/sources.list",
  "cat /etc/nsswitch.conf", "cat /etc/login.defs", "cat /etc/crontab",
  "cat /etc/profile", "cat /etc/bash.bashrc", "cat /etc/pam.d/login",
  "cat /etc/default/useradd",
  // proc
  "cat /proc/version", "cat /proc/cpuinfo", "cat /proc/meminfo", "cat /proc/mounts",
  "cat /proc/filesystems", "cat /proc/uptime", "cat /proc/loadavg",
  // text processing
  "head -3 /etc/passwd", "tail -3 /etc/passwd", "wc -l /etc/passwd", "wc -w /etc/passwd",
  "grep root /etc/passwd", "grep -c root /etc/passwd", "grep -v nologin /etc/passwd",
  "sort /etc/hostname", "uniq /etc/hostname", "cut -d: -f1 /etc/passwd",
  "sed -n 1p /etc/passwd", "awk -F: 'NR==1{print $1}' /etc/passwd",
  "tr a-z A-Z < /etc/hostname", "nl /etc/passwd", "tac /etc/passwd | head -2",
  // files
  "find /etc -maxdepth 1 -type f", "find /usr/bin -maxdepth 1 -name 'ba*'",
  "stat /etc/hostname", "stat /etc", "file /bin/ls", "file /etc/passwd",
  "md5sum /etc/hostname", "readlink /bin/sh", "realpath /etc/hostname",
  "du -sh /etc", "du -sh /usr", "du -sh /var", "du -sh /var/lib/dpkg",
  "which ls", "which bash", "which cat", "type ls", "dirname /a/b/c", "basename /a/b/c",
  "ln --version", "mkdir --version", "rm --version", "cp --version", "mv --version",
  "touch --version", "chmod --version", "chown --version", "umask", "ulimit -a",
  // system
  "df", "df -h", "df -h /", "free", "free -h", "mount", "ps", "ps aux", "uptime",
  "dmesg | tail -5", "lsmod", "lsblk", "blkid", "vmstat", "lsof | head -5",
  "getconf LONG_BIT", "locale", "groups", "users", "env", "printenv", "printenv PATH",
  "echo $PATH", "echo $HOME", "echo $SHELL", "echo $USER", "echo $TERM",
  // packages
  "dpkg -l", "dpkg -l bash", "dpkg -L bash", "dpkg -s bash", "dpkg-query -W",
  "dpkg-query -W -f='${Package}\\n'", "dpkg -S /bin/ls", "dpkg --print-architecture",
  "dpkg --version", "apt list --installed", "apt-cache policy bash", "apt-cache show bash",
  "apt-cache search editors",
  // manuals
  "man ls | head -20", "man -k passwd | head -5", "man 5 passwd | head -20",
  "whatis ls", "apropos useradd | head -5", "info ls | head -20",
  // archives
  "tar --version", "gzip --version", "bzip2 --version", "xz --version", "zip -v", "unzip -v",
  "tar -cf /tmp/t.tar /etc/hostname", "tar -tf /tmp/t.tar", "gzip -c /etc/hostname | wc -c",
  "file /tmp/t.tar", "base64 /etc/hostname", "od -c /etc/hostname | head -2",
  "hexdump -C /etc/hostname | head -2",
  // editors and interpreters
  "vim --version", "nano --version", "ed --version", "sed --version", "awk --version",
  "perl -v", "python3 --version", "bc --version", "expr 2 + 3",
  "gcc --version", "make --version", "strace -V",
  // users and permissions
  "useradd --help", "passwd --help", "chage -l root", "last -n 3", "who -a", "w",
  // misc
  "test -f /etc/passwd && echo YES", "cd /tmp && pwd", "ls -la /etc | head",
  "cat /etc/passwd | wc -l", "grep root /etc/passwd | wc -l",
  "ls /etc/init.d", "ls /etc/profile.d", "ls /etc/systemd",
  "ls /usr/share/doc | head", "ls /usr/share/man | head", "du -sh /usr/share/doc",
  "ls -d /usr/share/man/*", "dpkg -L bash | wc -l", "wc -l /etc/group"
];

const CHUNK_FAIL = /Exec format error|cannot execute binary|Segmentation fault|Bus error|Illegal instruction/;

function shuffle(arr, seed) {
  const a = arr.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function boot() {
  const disk = new LazyDisk({ baseUrl: "disk" });
  const emu = new V86({
    wasm_path: path.join(HERE, "v86", "v86.wasm"),
    bios: { buffer: ab(path.join(HERE, "v86", "seabios.bin")) },
    vga_bios: { buffer: ab(path.join(HERE, "v86", "vgabios.bin")) },
    bzimage: { buffer: ab(path.join(HERE, "boot", "bzimage")) },
    initrd: { buffer: ab(path.join(HERE, "boot", "initramfs.gz")) },
    cmdline: "console=ttyS0,115200 rdinit=/init loglevel=3 quiet",
    hda: disk, memory_size: 512 * 1024 * 1024, vga_memory_size: 4 * 1024 * 1024,
    autostart: true
  });
  const state = { emu, disk, serial: "" };
  let resolveReady;
  const readyPromise = new Promise(r => { resolveReady = r; });
  emu.add_listener("serial0-output-byte", (b) => {
    state.serial += String.fromCharCode(b);
    if (state.serial.length > 600000) state.serial = state.serial.slice(-300000);
    if (state.serial.indexOf("~~~READY~~~") !== -1) resolveReady();
  });
  return { state, readyPromise };
}

(async () => {
  console.log("starting set:", have.size, "chunks,", PASSES, "passes");

  for (let pass = 0; pass < PASSES; pass++) {
    const order = shuffle(BATTERY, 1234 + pass * 7919);
    const { state, readyPromise } = boot();
    await Promise.race([readyPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("boot timeout")), 180000))]);
    console.log("pass " + (pass + 1) + ": guest ready");
    state.emu.serial0_send("export PAGER=cat MANPAGER=cat SYSTEMD_PAGER=cat\r");
    await new Promise(r => setTimeout(r, 1200));

    let bad = 0;
    for (let n = 0; n < order.length; n++) {
      const cmd = order[n];
      const mark = "__U" + (n + 1) + "__";
      const at = state.serial.length;
      state.emu.serial0_send(cmd + " >/dev/null 2>&1; echo " + mark + "\r");
      let done = false;
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 90));
        if (state.serial.slice(at).split("\n").some(l => l.trim() === mark)) { done = true; break; }
      }
      if (!done) { bad++; console.log("  timeout: " + cmd); }
    }
    console.log("  done, timeouts:", bad, " new chunks found:", shadowed.size);

    // Stop the emulator so the next pass starts from a cold page cache.
    try { state.emu.stop(); } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }

  const union = Array.from(grown).sort((a, b) => a - b);
  const added = [...grown].filter(i => !have.has(i)).sort((a, b) => a - b);
  let gzTotal = 0;
  for (const i of union) { const g = readChunk(i); if (g) gzTotal += g.length; }

  console.log("\n=== RESULT ===");
  console.log("start set     :", have.size);
  console.log("added         :", added.length, added.length ? "-> " + added.join(" ") : "");
  console.log("final set     :", union.length, "chunks");
  console.log("gzip size     :", (gzTotal / 1048576).toFixed(1), "MiB");

  fs.writeFileSync(outJson, JSON.stringify({
    size: SIZE, chunkSize: CHUNK, present: union,
    note: "shadow-union measurement, " + PASSES + " shuffled passes over " + BATTERY.length + " commands"
  }, null, 1));
  console.log("written       :", outJson);
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
