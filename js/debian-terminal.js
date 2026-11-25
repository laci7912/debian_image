/*
 * debian-terminal.js – beépíthető Debian 12 terminál modul
 * =======================================================
 *
 * Egyetlen <script> behúzása után bármelyik HTML oldalba beilleszthető egy
 * valódi Debian 12 terminál, ami a debian_hda.img képből fut (v86 emulátor).
 *
 *   <div id="term" style="height:600px"></div>
 *   <script src="https://laci7912.github.io/debian_image/js/debian-terminal.js"></script>
 *   <script>
 *     var t = DebianTerminal.create(document.getElementById("term"));
 *   </script>
 *
 * A modul mindent maga tölt be (xterm.js, v86, lemezkezelő, stíluslap), a
 * repó helyét pedig a saját <script src="..."> címéből számolja ki, ezért
 * nincs szükség semmilyen beállításra. Ha mégis más helyről kellene tölteni:
 *
 *   DebianTerminal.create(el, { baseUrl: "https://pelda.hu/gep/" });
 *
 * Publikus API (a létrehozott példányon):
 *   run(parancs)      -> Promise<{ ok: true, out: "..." }>  (a kimenet szövege)
 *   send(szoveg)      -> nyers szöveg a vendégnek (billentyűzetként)
 *   focus()           -> fókusz a terminálra
 *   restart()         -> újraindítás tiszta lappal
 *   destroy()         -> az emulátor és a DOM eldobása
 *   isReady()         -> fut-e már a vendég
 *   info()            -> a vendég adatai (név, verzió, mag, ...)
 *   el                -> a konténer elem
 *
 * Események (opciók):
 *   onStatus(allapot, szoveg)  allapot: "booting" | "ready" | "error"
 *   onInfo(adatok)             a vendég ~~~INFO~~~ sora feldolgozva
 *   onMissing(tombIndex)       a lite kiadásból hiányzó lemeztömb
 *   onReady()                  a vendég kész
 *
 * A modul nem nyúl a host oldal globális neveihez, minden stílus `dtx-`
 * előtagú, és minden példány a saját konténerében él – akár több is
 * futhat egyszerre ugyanazon az oldalon.
 */
(function (global) {
  "use strict";

  var CSS_ID = "debian-terminal-css";

  /* ------------------------------------------------------------------ */
  /* a repó helye a saját <script> címéből                              */
  /* ------------------------------------------------------------------ */
  function detectBase() {
    var s = document.currentScript;
    if (!s || !s.src) {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if (/debian-terminal(\.min)?\.js(\?|$)/.test(all[i].src || "")) { s = all[i]; break; }
      }
    }
    if (!s || !s.src) return null;
    // .../js/debian-terminal.js  ->  .../
    return s.src.replace(/js\/debian-terminal(\.min)?\.js(\?.*)?$/, "");
  }

  var SELF_BASE = detectBase();

  /* ------------------------------------------------------------------ */
  /* stíluslap                                                          */
  /* ------------------------------------------------------------------ */
  var CSS =
    '.dtx{position:relative;display:flex;flex-direction:column;background:#000;' +
      'height:100%;min-height:220px;border-radius:8px;overflow:hidden;' +
      'border:1px solid #2d333b;font-family:-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.dtx-host{flex:1 1 auto;min-height:0;padding:7px 4px 3px 9px;overflow:hidden;background:#000}' +
    '.dtx-host .xterm{height:100%}' +
    '.dtx-host .xterm-viewport{background:#000 !important}' +
    '.dtx-overlay{position:absolute;inset:0;z-index:20;background:rgba(8,11,16,.95);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:12px;text-align:center;padding:20px}' +
    '.dtx-overlay.dtx-hidden{display:none}' +
    '.dtx-spinner{width:32px;height:32px;border-radius:50%;border:3px solid #21262d;' +
      'border-top-color:#d70a53;animation:dtx-spin .85s linear infinite}' +
    '@keyframes dtx-spin{to{transform:rotate(360deg)}}' +
    '.dtx-title{color:#e6edf3;font-size:14px;font-weight:600;margin:0}' +
    '.dtx-step{color:#8b949e;font-size:12.5px;font-family:Consolas,monospace;max-width:440px}' +
    '.dtx-hint{color:#6e7681;font-size:11.5px;max-width:440px;line-height:1.55}' +
    '.dtx-cmdbar{display:flex;align-items:center;gap:0;flex:0 0 auto;' +
      'background:#161b22;border-top:1px solid #2d333b;padding:7px 9px}' +
    '.dtx-prompt{font-family:Consolas,monospace;font-size:13px;color:#3fb950;' +
      'white-space:nowrap;padding:0 7px 0 3px}' +
    '.dtx-input{flex:1 1 auto;min-width:0;font-family:Consolas,monospace;font-size:13.5px;' +
      'color:#e6edf3;background:#0d1117;border:1px solid #2d333b;border-radius:6px;' +
      'padding:8px 11px;outline:none}' +
    '.dtx-input:focus{border-color:#58a6ff;box-shadow:0 0 0 2px rgba(88,166,255,.18)}' +
    '.dtx-input::placeholder{color:#545d68}' +
    '.dtx-input:disabled{opacity:.55}' +
    '.dtx-run{flex:0 0 auto;margin-left:7px;padding:8px 15px;border-radius:6px;' +
      'font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;' +
      'background:#d70a53;border:1px solid #d70a53;color:#fff}' +
    '.dtx-run:hover:not(:disabled){background:#e8185f}' +
    '.dtx-run:disabled{opacity:.45;cursor:not-allowed}' +
    '@media (max-width:520px){.dtx-prompt{display:none}}';

  // A stílus beépítve is megvan (egy kéréssel kevesebb, és nem függ attól,
  // hogy a CSS-fájl elérhető-e). Ha viszont a host oldal külön behúzta a
  // debian-terminal.css-t, azt használjuk, hogy a testreszabás érvényesüljön.
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var linked = document.querySelector('link[href*="debian-terminal.css"]');
    if (linked) return;
    var st = document.createElement("style");
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ */
  /* függőségek betöltése (egyszer, megosztva a példányok között)       */
  /* ------------------------------------------------------------------ */
  var depCache = {};

  function loadScript(src) {
    if (depCache[src]) return depCache[src];
    depCache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Nem tölthető be: " + src)); };
      document.head.appendChild(s);
    });
    return depCache[src];
  }

  function loadLink(href) {
    if (depCache[href]) return depCache[href];
    depCache[href] = new Promise(function (resolve) {
      if (document.querySelector('link[href="' + href + '"]')) return resolve();
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = function () { resolve(); };
      l.onerror = function () { resolve(); };   // hiányzó CSS ne akassza meg
      document.head.appendChild(l);
    });
    return depCache[href];
  }

  function loadDeps(base) {
    // Sorrendben: az addon-fit a Terminal osztályra épül.
    return loadLink(base + "vendor/xterm.css")
      .then(function () { return loadScript(base + "vendor/xterm.js"); })
      .then(function () { return loadScript(base + "vendor/addon-fit.js"); })
      .then(function () { return loadScript(base + "v86/libv86.js"); })
      .then(function () { return loadScript(base + "js/lazydisk.js"); });
  }

  /* ------------------------------------------------------------------ */
  /* segédfüggvények                                                    */
  /* ------------------------------------------------------------------ */
  function stripAnsi(s) {
    return s
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\x1b[()][A-Za-z0-9]/g, "")
      .replace(/\r/g, "");
  }

  function hasMarker(buf, mark) {
    return stripAnsi(buf).split("\n").some(function (l) { return l.trim() === mark; });
  }

  function lastPrompt(raw) {
    var lines = stripAnsi(raw).split("\n");
    for (var i = lines.length - 1; i >= 0; i--) {
      var l = lines[i].trim();
      if (/^root@debian-web:[^#]*#\s*$/.test(l)) return l + " ";
    }
    return "";
  }

  function cleanOutput(raw, id) {
    var lines = stripAnsi(raw).split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.indexOf('echo "__""CK' + id + '__"') !== -1) continue;
      if (l.trim() === "__CK" + id + "__") continue;
      if (/^root@debian-web:.*#\s*$/.test(l.trim())) continue;
      out.push(l);
    }
    return out.join("\n").trim();
  }

  /* ------------------------------------------------------------------ */
  /* a példány                                                          */
  /* ------------------------------------------------------------------ */
  function DebianTerminal(container, options) {
    if (!container) throw new Error("DebianTerminal: hiányzó konténer elem.");

    var o = this.opts = options || {};
    this.base = (o.baseUrl || SELF_BASE || "").replace(/\/?$/, "/");
    if (!this.base) {
      throw new Error("DebianTerminal: nem állapítható meg a repó címe. " +
        "Add meg az baseUrl opciót.");
    }
    if (!/^https?:|^file:/.test(this.base) && this.base !== "/") {
      // relatív cím: az oldalhoz képest oldjuk fel
      var a = document.createElement("a");
      a.href = this.base;
      this.base = a.href.replace(/\/?$/, "/");
    }

    this.cmdbar   = o.cmdbar !== false;
    this.prompt   = o.prompt || "root@debian-web:~#";
    this.fontSize = o.fontSize || 14;

    this.el = container;
    this.term = null;
    this.fitAddon = null;
    this.emulator = null;
    this.disk = null;
    this.ready = false;
    this.busy = false;
    this.suppress = false;
    this.supBytes = [];
    this.runSeq = 0;
    this.atReady = false;
    this.bootBuffer = "";
    this.nulRun = 0;
    this.lastCommand = "";
    this.lastInfo = null;
    this._chain = Promise.resolve();
    this._destroyed = false;
    this._observer = null;

    injectCss();
    this._buildDom();
    this._boot();
  }

  /* ---- DOM ---------------------------------------------------------- */
  DebianTerminal.prototype._buildDom = function () {
    var self = this;
    var o = this.opts;

    this.el.classList.add("dtx");

    this.host = document.createElement("div");
    this.host.className = "dtx-host";

    this.overlay = document.createElement("div");
    this.overlay.className = "dtx-overlay";
    this.overlay.innerHTML =
      '<div class="dtx-spinner"></div>' +
      '<p class="dtx-title">' + (o.bootTitle || "Debian 12 indítása") + "</p>" +
      '<div class="dtx-step"></div>' +
      '<div class="dtx-hint">' +
        (o.bootHint ||
         "A vendégrendszer a <code>debian_hda.img</code> képből fut, " +
         "v86 emulátorban. Az első indítás néhány másodpercig tart.") +
      "</div>";
    this.stepEl = this.overlay.querySelector(".dtx-step");

    this.el.appendChild(this.host);
    this.el.appendChild(this.overlay);

    if (this.cmdbar) {
      this.bar = document.createElement("div");
      this.bar.className = "dtx-cmdbar";

      this.promptEl = document.createElement("span");
      this.promptEl.className = "dtx-prompt";
      this.promptEl.textContent = this.prompt;

      this.input = document.createElement("input");
      this.input.className = "dtx-input";
      this.input.type = "text";
      this.input.autocomplete = "off";
      this.input.spellcheck = false;
      this.input.disabled = true;
      this.input.placeholder = o.placeholder || "Írj be egy parancsot, például: ls -la /root  (Enter = futtatás)";

      this.runBtn = document.createElement("button");
      this.runBtn.className = "dtx-run";
      this.runBtn.type = "button";
      this.runBtn.textContent = o.runLabel || "Futtatás";
      this.runBtn.disabled = true;

      this.bar.appendChild(this.promptEl);
      this.bar.appendChild(this.input);
      this.bar.appendChild(this.runBtn);
      this.el.appendChild(this.bar);

      this.runBtn.addEventListener("click", function () { self.sendCommand(self.input.value); });
      this.input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          self.sendCommand(self.input.value);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (self.lastCommand) self.input.value = self.lastCommand;
        }
      });
    }
  };

  /* ---- terminál ------------------------------------------------------ */
  DebianTerminal.prototype._initTerminal = function () {
    var self = this;

    this.term = new global.Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
      fontSize: this.fontSize,
      lineHeight: 1.15,
      scrollback: 8000,
      allowProposedApi: true,
      theme: {
        background: "#000000", foreground: "#d4d4d4", cursor: "#d70a53",
        black: "#1e1e1e", red: "#f85149", green: "#3fb950", yellow: "#d29922",
        blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#d4d4d4",
        brightBlack: "#6e7681", brightRed: "#ff7b72", brightGreen: "#56d364",
        brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd", brightWhite: "#ffffff"
      }
    });

    this.fitAddon = new global.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.host);
    this._fit();

    // A konténer méretváltozására igazítunk (nem csak az ablakéra), mert a
    // modul egy oldal egy részében él, ami maga is átméreteződhet.
    if (typeof ResizeObserver === "function") {
      this._observer = new ResizeObserver(function () { self._fit(); });
      this._observer.observe(this.el);
    } else {
      global.addEventListener("resize", this._onResize = function () { self._fit(); });
    }

    // Közvetlen gépelés a terminálba (mint egy igazi konzolban).
    this.term.onData(function (data) {
      if (!self.ready || !self.emulator || self.busy || self.suppress) return;
      self.send(data);
    });

    // UTF-8: a v86 serial0_send() karakterenként egy bájtot küldene, ezért
    // minden ékezet hibásan jutna el. Bájtokban küldünk.
    this.textEncoder = new global.TextEncoder();
    this.utf8Decoder = new global.TextDecoder("utf-8");
    this.outBytes = [];
    this.flushTimer = null;
  };

  DebianTerminal.prototype._fit = function () {
    try { if (this.fitAddon) this.fitAddon.fit(); } catch (e) {}
  };

  DebianTerminal.prototype._termSize = function () {
    var cols = 80, rows = 24;
    if (this.term) { cols = this.term.cols || 80; rows = this.term.rows || 24; }
    return { cols: cols, rows: rows };
  };

  /* ---- kimenet ------------------------------------------------------- */
  DebianTerminal.prototype._queueByte = function (b) {
    var self = this;
    this.outBytes.push(b);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(function () { self._flushOut(); }, 8);
    }
  };

  DebianTerminal.prototype._flushOut = function () {
    this.flushTimer = null;
    if (!this.outBytes.length || !this.term) return;
    var bytes = new Uint8Array(this.outBytes);
    this.outBytes = [];
    // stream:true – a félbeérkezett többbájtos karakter a következő körre marad
    this.term.write(this.utf8Decoder.decode(bytes, { stream: true }));
  };

  DebianTerminal.prototype._writeNow = function (text) {
    this._flushOut();
    if (this.term) this.term.write(text);
  };

  DebianTerminal.prototype._handleByte = function (b) {
    var self = this;
    if (!this.term) return;

    if (this.suppress) { this.supBytes.push(b); return; }

    if (!this.atReady) {
      this.bootBuffer += String.fromCharCode(b);
      if (this.bootBuffer.length > 4096) this.bootBuffer = this.bootBuffer.slice(-4096);

      var infoIdx = this.bootBuffer.indexOf("~~~INFO~~~");
      if (infoIdx !== -1) {
        var nl = this.bootBuffer.indexOf("\n", infoIdx);
        if (nl !== -1) {
          this._parseInfo(this.bootBuffer.slice(infoIdx + 10, nl).trim());
          this.bootBuffer = this.bootBuffer.slice(nl + 1);
        }
      }

      if (this.bootBuffer.indexOf("~~~READY~~~") !== -1) {
        this.atReady = true;
        this.bootBuffer = "";
        this._onGuestReady();
      }
      return;
    }

    // A kimaradt lemeztömb nulla bájtokat ad; ezek láthatatlanok, de ezres
    // nagyságrendben jöhetnek, ezért egyszer jelezzük őket.
    if (b === 0) {
      this.nulRun++;
      if (this.nulRun === 64) {
        var note = this.textEncoder.encode("\x1b[38;5;214m[hiányzó lemeztömb – ez a " +
          "kisebb (lite) kiadás, néhány ritka fájl nem olvasható]\x1b[0m\r\n");
        for (var k = 0; k < note.length; k++) this._queueByte(note[k]);
      }
      return;
    }
    this.nulRun = 0;
    this._queueByte(b);
  };

  DebianTerminal.prototype._parseInfo = function (payload) {
    var data = {};
    payload.split("|").forEach(function (p) {
      var i = p.indexOf("=");
      if (i > 0) data[p.slice(0, i)] = p.slice(i + 1);
    });
    this.lastInfo = data;
    if (this.opts.onInfo) {
      try { this.opts.onInfo(data); } catch (e) { console.error(e); }
    }
  };

  /* ---- küldés -------------------------------------------------------- */
  DebianTerminal.prototype.send = function (text) {
    if (!this.emulator) return;
    var bytes = this.textEncoder.encode(String(text));
    if (this.emulator.serial_send_bytes) {
      this.emulator.serial_send_bytes(0, bytes);
    } else {
      this.emulator.serial0_send(String(text));
    }
  };

  DebianTerminal.prototype.sendCommand = function (text) {
    if (!this.ready || !this.emulator || this.busy) return;
    text = String(text || "").trim();
    if (!text) return;
    this.lastCommand = text;
    this.send(text + "\r");
    if (this.input) this.input.value = "";
    if (this.term) this.term.scrollToBottom();
  };

  /* ---- parancs futtatása, kimenet elkapása --------------------------- */
  DebianTerminal.prototype.run = function (cmd, timeoutMs) {
    var self = this;
    // Egyszerre csak egy ellenőrzés futhat; a hívások sorba állnak.
    var p = this._chain.then(function () { return self._run(cmd, timeoutMs); });
    this._chain = p.catch(function () {});
    return p;
  };

  DebianTerminal.prototype._supText = function () {
    if (!this.supBytes.length) return "";
    try {
      return new global.TextDecoder("utf-8").decode(new Uint8Array(this.supBytes));
    } catch (e) {
      return String.fromCharCode.apply(null, this.supBytes);
    }
  };

  DebianTerminal.prototype._setInputEnabled = function (on) {
    if (this.input) this.input.disabled = !on;
    if (this.runBtn) this.runBtn.disabled = !on;
  };

  DebianTerminal.prototype._run = function (cmd, timeoutMs) {
    var self = this;
    return new Promise(function (resolve) {
      if (!self.ready || !self.emulator) return resolve({ ok: false, out: "" });

      self.runSeq++;
      var id = self.runSeq;
      var mark = "__CK" + id + "__";
      var limit = timeoutMs || 20000;

      self.suppress = true;
      self.supBytes = [];
      self.busy = true;
      self._setInputEnabled(false);

      // Előbb megszakítjuk a futó parancsot, hogy tiszta promptról induljunk.
      self.send("\x03");

      setTimeout(function () {
        // Az "echo" elé egy üres echo kerül: így akkor is külön sorba kerül a
        // jelölő, ha a vizsgált parancs kimenete nem végződik újsorral. A
        // jelölőt a shell összefűzéssel állítja elő, ezért a visszhangzott
        // parancssorban nem szerepel egyben.
        self.send(cmd + '; echo; echo "__""CK' + id + '__"\r');

        var started = Date.now();
        (function poll() {
          if (!self.suppress) return;
          if (hasMarker(self._supText(), mark)) return finish();
          if (Date.now() - started > limit) return finish();
          setTimeout(poll, 90);
        })();

        function finish() {
          var raw = self._supText();
          self.suppress = false;
          self.busy = false;
          self.supBytes = [];
          self._setInputEnabled(self.ready);
          // A valódi promptot visszaírjuk (nem küldünk Entert, mert az minden
          // ellenőrzésnél plusz sorokat gyűjtene a terminálba).
          var prompt = lastPrompt(raw);
          self._writeNow("\r\n" + (prompt || self.prompt + " "));
          resolve({ ok: true, out: cleanOutput(raw, id) });
        }
      }, 420);
    });
  };

  /* ---- indítás ------------------------------------------------------- */
  DebianTerminal.prototype._status = function (kind, text) {
    if (this.opts.onStatus) {
      try { this.opts.onStatus(kind, text); } catch (e) { console.error(e); }
    }
  };

  DebianTerminal.prototype._loadArrayBuffer = function (url, label) {
    var self = this;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(label + ": HTTP " + r.status);
      var total = Number(r.headers.get("content-length") || 0);
      if (!r.body || !total) return r.arrayBuffer();
      var reader = r.body.getReader();
      var chunks = [];
      var received = 0;
      return (function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var out = new Uint8Array(received);
            var at = 0;
            for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
            return out.buffer;
          }
          chunks.push(res.value);
          received += res.value.length;
          var pct = Math.min(100, Math.round(received / total * 100));
          if (self.stepEl) self.stepEl.textContent = label + " letöltése… " + pct + "%";
          return pump();
        });
      })();
    });
  };

  DebianTerminal.prototype._boot = function () {
    var self = this;
    var base = this.base;

    this._status("booting", "Indítás…");
    if (this.overlay) this.overlay.classList.remove("dtx-hidden");
    if (this.stepEl) this.stepEl.textContent = "v86 emulátor betöltése…";

    this.atReady = false;
    this.ready = false;
    this.bootBuffer = "";
    this._setInputEnabled(false);

    loadDeps(base).then(function () {
      if (self._destroyed) return;
      self._initTerminal();

      self.term.reset();
      self.term.writeln("\x1b[38;5;240m─────────────────────────────────────────────────────────\x1b[0m");
      self.term.writeln("\x1b[1;38;5;203m Debian 12 (bookworm) – debian_hda.img \x1b[0m");
      self.term.writeln("\x1b[38;5;240m─────────────────────────────────────────────────────────\x1b[0m");
      self.term.writeln("");

      return Promise.all([
        self._loadArrayBuffer(base + "boot/bzimage", "Kernel"),
        self._loadArrayBuffer(base + "boot/initramfs.gz", "Initramfs")
      ]);
    }).then(function (bufs) {
      if (self._destroyed) return;
      var bzimage = bufs[0];
      var initrd = bufs[1];
      if (self.stepEl) self.stepEl.textContent = "Vendégrendszer indítása…";

      // A lemez nem egyetlen nagy fájl: gzip-elt 512 KiB-os tömbök + leíró.
      // Csak azok a tömbök jönnek le, amiket a vendég ténylegesen olvas.
      self.disk = new global.LazyDisk({
        baseUrl: base + "disk",
        onStats: function (s) {
          if (!self.ready && self.stepEl) {
            self.stepEl.textContent = "Lemeztömbök betöltése… " +
              (s.bytesDownloaded / 1048576).toFixed(1) + " MiB (" + s.chunkFetches + " tömb)";
          }
          if (self.opts.onDiskStats) {
            try { self.opts.onDiskStats(s); } catch (e) {}
          }
        },
        onMissing: function (idx) {
          if (self.opts.onMissing) {
            try { self.opts.onMissing(idx); } catch (e) {}
          }
        }
      });

      var size = self._termSize();
      self.emulator = new global.V86({
        wasm_path: base + "v86/v86.wasm",
        bios: { url: base + "v86/seabios.bin" },
        vga_bios: { url: base + "v86/vgabios.bin" },
        bzimage: { buffer: bzimage },
        initrd: { buffer: initrd },
        hda: self.disk,
        cmdline: "console=ttyS0,115200 rdinit=/init loglevel=3 quiet" +
                 " wterm_cols=" + size.cols + " wterm_rows=" + size.rows,
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 4 * 1024 * 1024,
        disable_speaker: true,
        autostart: true
      });

      self.emulator.add_listener("serial0-output-byte", function (b) { self._handleByte(b); });
      self.emulator.add_listener("emulator-ready", function () {
        if (self.stepEl) self.stepEl.textContent = "Kernel indítása…";
      });

      setTimeout(function () {
        if (!self.ready && self.stepEl) {
          self.stepEl.textContent = "A vendég lassabban indul a vártnál…";
        }
      }, 45000);

    }).catch(function (err) {
      if (self._destroyed) return;
      console.error(err);
      self._status("error", "Hiba");
      if (self.stepEl) self.stepEl.textContent = "Hiba: " + err.message;
      if (self.overlay) self.overlay.classList.remove("dtx-hidden");
      if (self.term) {
        self.term.writeln("\x1b[31mHiba: " + err.message + "\x1b[0m");
        self.term.writeln("");
        self.term.writeln("Ellenőrizd, hogy a modul a repóból töltődik-e, és van-e internet.");
      }
    });
  };

  DebianTerminal.prototype._onGuestReady = function () {
    if (this.ready) return;
    this.ready = true;
    this._status("ready", "Kész");
    if (this.overlay) this.overlay.classList.add("dtx-hidden");
    this._setInputEnabled(true);
    this._fit();
    if (this.term) this.term.focus();
    if (this.input && this.opts.autofocus !== false) this.input.focus();
    if (this.opts.onReady) {
      try { this.opts.onReady(this); } catch (e) { console.error(e); }
    }
  };

  /* ---- nyilvános műveletek ------------------------------------------- */
  DebianTerminal.prototype.isReady = function () { return this.ready; };
  DebianTerminal.prototype.info = function () { return this.lastInfo; };

  // Szöveg írása a terminálra (a vendég kimenetétől függetlenül).
  DebianTerminal.prototype.write = function (text) {
    this._writeNow(String(text));
  };

  // A terminál újraméretezése (pl. egy fül megjelenítése után).
  DebianTerminal.prototype.fit = function () {
    this._fit();
  };

  DebianTerminal.prototype.focus = function () {
    if (this.term) this.term.focus();
    if (this.input && this.cmdbar) this.input.focus();
  };

  DebianTerminal.prototype.restart = function () {
    if (this.emulator && this.emulator.destroy) this.emulator.destroy();
    this.emulator = null;
    this.ready = false;
    this._destroyed = false;
    this._setInputEnabled(false);
    this._status("booting", "Indítás…");
    var self = this;
    setTimeout(function () { if (!self._destroyed) self._boot(); }, 250);
  };

  DebianTerminal.prototype.destroy = function () {
    this._destroyed = true;
    if (this._observer) { try { this._observer.disconnect(); } catch (e) {} this._observer = null; }
    if (this._onResize) { global.removeEventListener("resize", this._onResize); this._onResize = null; }
    if (this.emulator && this.emulator.destroy) { try { this.emulator.destroy(); } catch (e) {} }
    this.emulator = null;
    this.disk = null;
    if (this.term && this.term.dispose) { try { this.term.dispose(); } catch (e) {} }
    this.term = null;
    if (this.el) this.el.innerHTML = "";
  };

  /* ---- gyár és globális név ------------------------------------------ */
  var DebianTerminalApi = {
    create: function (container, options) { return new DebianTerminal(container, options); },
    version: "1.0.0",
    base: SELF_BASE
  };

  global.DebianTerminal = DebianTerminalApi;

  if (typeof module === "object" && module.exports) module.exports = DebianTerminalApi;
})(typeof window !== "undefined" ? window : globalThis);
