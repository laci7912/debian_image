/*
 * LazyDisk – a v86 disk object that fetches the Debian image on demand.
 *
 * The image is stored in the repository as a series of gzip'd chunks
 * (disk/000000.gz, disk/000001.gz, ...). Only the chunks the guest actually
 * reads are downloaded, so a normal boot transfers a few MiB instead of the
 * whole 768 MiB image.
 *
 * v86 calls:
 *   disk.load()                      once, before boot (async, onload when done)
 *   disk.get(offset, len, cb)        for every IDE read
 *   disk.get_from_cache(offset, len) synchronously, for the partition table
 *   disk.set(offset, data, cb)       on writes (never happens: mounted ro)
 *
 * Both gzip'd and already-decompressed responses are accepted, so the same
 * code works on GitHub Pages, raw.githubusercontent.com and a local server.
 */
(function (global) {
  "use strict";

  var GZIP_MAGIC_0 = 0x1f;
  var GZIP_MAGIC_1 = 0x8b;

  function LazyDisk(opts) {
    this.baseUrl  = opts.baseUrl;             // e.g. "disk" or "/__disk/disk"
    this.chunkSize = opts.chunkSize || 524288;
    // Chunks are grouped into sub-folders, because a single directory with a
    // few thousand files is unpleasant on GitHub and slow in some browsers.
    this.shardSize = opts.shardSize || 256;
    this.byteLength = 0;
    this.onload = null;
    this.onprogress = null;
    this.onStats = opts.onStats || function () {};
    this.onMissing = opts.onMissing || function () {};

    this.chunks = new Map();                 // index -> Uint8Array | null (all zero)
    this.pending = new Map();                // index -> Promise
    this.present = null;                     // Set of chunk indices that exist

    this.stats = { chunkFetches: 0, bytesDownloaded: 0, cacheHits: 0, reads: 0, missing: 0 };
    // Which chunks were actually requested, in request order. Used by the
    // measurement tooling to decide what a "lite" edition must ship.
    this.requested = [];
    this._queue = [];
    this._active = 0;
    this._maxParallel = opts.maxParallel || 6;
  }

  /* ---- HTTP ---------------------------------------------------------- */

  LazyDisk.prototype._chunkUrl = function (idx) {
    var name = ("000000" + idx).slice(-6);
    var shard = ("000" + Math.floor(idx / this.shardSize)).slice(-3);
    return this.baseUrl + "/" + shard + "/" + name + ".gz";
  };

  LazyDisk.prototype._decompress = function (buf) {
    var bytes = new Uint8Array(buf);
    var isGzip = bytes.length > 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
    if (!isGzip) return Promise.resolve(bytes);            // server already decompressed
    if (typeof DecompressionStream === "function") {
      var ds = new DecompressionStream("gzip");
      var stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    return Promise.reject(new Error("A böngésző nem támogatja a DecompressionStream API-t."));
  };

  LazyDisk.prototype._fetchChunk = function (idx) {
    var self = this;
    if (this.chunks.has(idx)) { this.stats.cacheHits++; return Promise.resolve(this.chunks.get(idx)); }
    if (this.pending.has(idx)) return this.pending.get(idx);
    if (this.present && !this.present.has(idx)) { this.chunks.set(idx, null); return Promise.resolve(null); }

    this.requested.push(idx);

    var p = this._httpGet(this._chunkUrl(idx)).then(function (body) {
      if (body === null) {                    // 404: an all-zero region of the image
        self.chunks.set(idx, null);
        self.stats.missing++;
        // In the lite edition a missing chunk can also mean "this part of the
        // image was not shipped", which is worth telling the user about.
        if (self.present && !self.present.has(idx)) self.onMissing(idx);
        return null;
      }
      if (body.byteLength > 0) self.stats.bytesDownloaded += body.byteLength;
      return self._decompress(body).then(function (raw) {
        self.chunks.set(idx, raw);
        self.stats.chunkFetches++;
        self.onStats(self.stats);
        return raw;
      });
    }).then(function (v) {
      self.pending.delete(idx);
      return v;
    }, function (err) {
      self.pending.delete(idx);
      throw err;
    });

    this.pending.set(idx, p);
    return p;
  };

  LazyDisk.prototype._httpGet = function (url) {
    return fetch(url, { cache: "force-cache" }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status + " – " + url);
      return r.arrayBuffer();
    });
  };

  /* Keep at most this many parallel requests, rest are queued. */
  LazyDisk.prototype._schedule = function (job) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self._queue.push(function () {
        self._active++;
        job().then(resolve, reject).then(function () {
          self._active--;
          var next = self._queue.shift();
          if (next) next();
        });
      });
      if (self._active < self._maxParallel) self._queue.shift()();
    });
  };

  /* ---- v86 disk interface -------------------------------------------- */

  LazyDisk.prototype.load = function () {
    var self = this;
    return this._httpGet(this.baseUrl + "/manifest.json").then(function (buf) {
      if (!buf) throw new Error("Nem található a lemezleíró: " + self.baseUrl + "/manifest.json");
      var m = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
      self.byteLength = m.size;
      self.chunkSize = m.chunkSize || self.chunkSize;
      // Only trust "present" when the manifest really ships a chunk list;
      // an empty/absent list means "every chunk may exist" (404 = zero hole).
      self.present = Array.isArray(m.present) ? new Set(m.present) : null;
      // The partition table lives in chunk 0 and must be readable synchronously.
      return self._fetchChunk(0);
    }).then(function () {
      if (self.onload) self.onload({});
    });
  };

  LazyDisk.prototype.get = function (offset, len, cb, opts) {
    var self = this;
    this.stats.reads++;
    if (opts && opts.signal && opts.signal.aborted) return;

    var first = Math.floor(offset / this.chunkSize);
    var last  = Math.floor((offset + len - 1) / this.chunkSize);
    var want = [];
    for (var c = first; c <= last; c++) want.push(c);

    Promise.all(want.map(function (c) {
      return self.chunks.has(c) ? self.chunks.get(c) : self._schedule(function () { return self._fetchChunk(c); });
    })).then(function (list) {
      if (opts && opts.signal && opts.signal.aborted) return;
      var out = new Uint8Array(len);
      var at = 0;
      for (var i = 0; i < list.length; i++) {
        var chunk = list[i];
        if (!chunk) continue;                       // zero chunk: leave zeros
        var base = (first + i) * self.chunkSize;
        var from = Math.max(0, offset - base);
        var to = Math.min(chunk.length, offset + len - base);
        if (to > from) { out.set(chunk.subarray(from, to), at); at += to - from; }
      }
      cb(out);
    }).catch(function (err) {
      console.error("lemezolvasási hiba:", err);
      cb(new Uint8Array(len));
    });
  };

  LazyDisk.prototype.get_and_cache = function (offset, len, cb, opts) {
    this.get(offset, len, cb, opts);
  };

  /* Synchronous read, used by v86 for the MBR / geometry. */
  LazyDisk.prototype.get_from_cache = function (offset, len) {
    var first = Math.floor(offset / this.chunkSize);
    var last  = Math.floor((offset + len - 1) / this.chunkSize);
    for (var c = first; c <= last; c++) {
      if (!this.chunks.has(c) || (this.chunks.get(c) === null)) {
        if (this.chunks.get(c) === null) continue;   // zero-filled area
        return undefined;
      }
    }
    var out = new Uint8Array(len);
    var at = 0;
    for (var i = first; i <= last; i++) {
      var chunk = this.chunks.get(i);
      if (!chunk) { at += Math.min(len - at, this.chunkSize); continue; }
      var base = i * this.chunkSize;
      var from = Math.max(0, offset - base);
      var to = Math.min(chunk.length, offset + len - base);
      if (to > from) { out.set(chunk.subarray(from, to), at); at += to - from; }
    }
    return out;
  };

  LazyDisk.prototype.set = function (offset, data, cb) {
    // The image is mounted read-only in the guest; silently ignore writes.
    if (cb) cb();
  };

  LazyDisk.prototype.get_buffer = function (cb) { if (cb) cb(); };
  LazyDisk.prototype.get_state = function () { return []; };
  LazyDisk.prototype.set_state = function () {};

  global.LazyDisk = LazyDisk;
})(typeof window !== "undefined" ? window : globalThis);
