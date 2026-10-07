'use strict';

/**
 * Torrent engine: a WebTorrent client that downloads only what's being watched.
 *
 * - Torrents start with nothing selected; picking a file selects just that file
 *   (low priority, background) while playback reads mark the pieces right at the
 *   play head as critical, so streaming starts after a few MB.
 * - Pieces live in one append-only file per torrent (see piece-store.js).
 * - Idle torrents are destroyed (and their data deleted) after TORRENT_IDLE_MINUTES;
 *   the least recently used idle ones go first when the cache or the active-torrent
 *   limit is full.
 */

const fs = require('fs');
const path = require('path');
const { once } = require('events');
const PieceStore = require('./piece-store');
const R = require('./release');

class EngineError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

class TorrentEngine {
  constructor(cfg, log = console.log) {
    this.cfg = cfg;
    this.log = log;
    this.entries = new Map();          // infoHash -> entry
    this._pending = new Map();         // infoHash -> Promise<entry> while adding
    this._failed = new Map();          // infoHash -> when it failed
    this.client = null;
    this._clientPromise = null;
    this._warnedFull = false;
    this._sweeper = setInterval(() => this.sweep(), 15000);
    this._sweeper.unref();
  }

  /** Remove data left behind by a previous run. */
  init() {
    fs.mkdirSync(this.cfg.dir, { recursive: true });
    for (const f of fs.readdirSync(this.cfg.dir)) {
      if (f.endsWith('.pieces')) fs.rmSync(path.join(this.cfg.dir, f), { force: true });
    }
  }

  async _getClient() {
    if (this.client) return this.client;
    if (!this._clientPromise) {
      this._clientPromise = import('webtorrent').then(({ default: WebTorrent }) => {
        const c = new WebTorrent({
          torrentPort: this.cfg.torrentPort || 0,
          dhtPort: this.cfg.dhtPort || 0,
          maxConns: this.cfg.maxConns || 55,
          downloadLimit: this.cfg.downloadLimit > 0 ? this.cfg.downloadLimit : -1,
          uploadLimit: this.cfg.uploadLimit > 0 ? this.cfg.uploadLimit : -1,
          dht: this.cfg.dht !== false,
          lsd: false,          // no LAN peers on a server
          natUpnp: false,
          natPmp: false,
        });
        c.on('error', (err) => this.log(`[torrent] client error: ${err.message}`));
        this.client = c;
        return c;
      });
    }
    return this._clientPromise;
  }

  bytesUsed() {
    let n = 0;
    for (const e of this.entries.values()) n += (e.store && e.store.size) || 0;
    return n;
  }

  get(hash) {
    const e = this.entries.get(hash) || null;
    if (e) e.lastAccess = Date.now();
    return e;
  }

  /**
   * Start (or reuse) a torrent.
   * src: { infoHash?, trackers?, torrentFile? (Buffer), title?, verify? (titles to check the name against) }
   */
  async add(src) {
    const known = src.infoHash ? this.entries.get(src.infoHash) : null;
    if (known && !known.error) { known.lastAccess = Date.now(); return known; }
    // two viewers starting the same torrent at once share one add
    if (src.infoHash && this._pending.has(src.infoHash)) return this._pending.get(src.infoHash);
    const p = this._add(src, known);
    if (src.infoHash) {
      this._pending.set(src.infoHash, p);
      p.then(() => this._pending.delete(src.infoHash), () => this._pending.delete(src.infoHash));
    }
    return p;
  }

  async _add(src, known) {
    if (known) this._remove(known, 'retry');
    this._makeRoom();
    const client = await this._getClient();
    const announce = [...new Set([...(src.trackers || []), ...this.cfg.trackers])];
    const now = Date.now();
    const entry = {
      hash: src.infoHash || null,
      title: src.title || '',
      torrent: null,
      store: null,
      createdAt: now,
      lastAccess: now,
      active: 0,               // open byte-range reads + ffmpeg jobs
      error: null,
      errorAt: 0,
      selected: new Set(),
      probes: new Map(),       // fileIdx -> { promise, desc, error }
      metaTimer: null,
    };
    const opts = {
      announce,
      deselect: true,
      path: this.cfg.dir,
      store: PieceStore,
      storeOpts: { store: { dir: this.cfg.dir, onCreate: (s) => { entry.store = s; } } },
      destroyStoreOnDestroy: true,
      storeCacheSlots: 8,
      strategy: 'sequential',
      maxWebConns: 4,
    };
    const id = src.torrentFile ||
      `magnet:?xt=urn:btih:${src.infoHash}` + announce.slice(0, 20).map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    const torrent = client.add(id, opts);
    entry.torrent = torrent;
    torrent.on('error', (err) => this._fail(entry, err && err.message ? err.message : String(err)));
    torrent.on('warning', () => { /* tracker/peer hiccups are normal */ });

    if (!entry.hash) {                         // .torrent file: hash known once parsed
      if (!torrent.infoHash) {
        await Promise.race([
          once(torrent, 'infoHash'),
          new Promise((_, rej) => setTimeout(() => rej(new EngineError('Invalid torrent file.', 422)), 15000)),
        ]).catch((err) => { torrent.destroy(); throw err; });
      }
      entry.hash = torrent.infoHash;
      const dup = this.entries.get(entry.hash);
      if (dup && !dup.error) { torrent.destroy(); dup.lastAccess = Date.now(); return dup; }
      if (dup) this._remove(dup, 'retry');
    }

    this.entries.set(entry.hash, entry);
    entry.metaTimer = setTimeout(() => {
      if (!torrent.destroyed && !torrent.metadata) this._fail(entry, 'No peers found for this torrent.');
    }, this.cfg.metaTimeoutMs);
    torrent.once('metadata', () => {
      clearTimeout(entry.metaTimer);
      // Came from a list a browser sent: make sure it's at least the right title.
      if (src.verify && src.verify.length) {
        const text = [torrent.name, ...torrent.files.slice(0, 60).map((f) => f.path)].join(' ');
        if (!R.looseTitleMatch(text, src.verify)) this._fail(entry, 'This torrent doesn\'t look like the right title.');
      }
    });
    this.log(`[torrent] + ${entry.hash} ${entry.title ? `"${entry.title.slice(0, 70)}"` : ''}`);
    return entry;
  }

  /** Hashes that failed (e.g. no peers) in the last 30 minutes — ranked last in searches. */
  recentFailures() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [h, at] of this._failed) if (at < cutoff) this._failed.delete(h);
    return new Set(this._failed.keys());
  }

  _fail(entry, message) {
    if (entry.error) return;
    entry.error = message;
    entry.errorAt = Date.now();
    if (entry.hash) {
      this._failed.set(entry.hash, entry.errorAt);
      if (this._failed.size > 500) this._failed.delete(this._failed.keys().next().value);
    }
    clearTimeout(entry.metaTimer);
    this.log(`[torrent] ! ${entry.hash}: ${message}`);
    if (entry.torrent && !entry.torrent.destroyed) entry.torrent.destroy({ destroyStore: true });
  }

  _remove(entry, why) {
    clearTimeout(entry.metaTimer);
    if (this.entries.get(entry.hash) === entry) this.entries.delete(entry.hash);
    if (entry.torrent && !entry.torrent.destroyed) entry.torrent.destroy({ destroyStore: true });
    this.log(`[torrent] - ${entry.hash} (${why})`);
  }

  // Free a slot for a new torrent: drop the least recently used idle one.
  _makeRoom() {
    const live = [...this.entries.values()].filter((e) => !e.error);
    if (live.length < this.cfg.maxActive) return;
    const now = Date.now();
    const idle = live.filter((e) => e.active === 0 && now - e.lastAccess > 10000)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    if (!idle.length) {
      throw new EngineError('The server is already streaming the maximum number of torrents. Try again in a bit.', 503);
    }
    this._remove(idle[0], 'make room');
  }

  /** The viewer closed the player: keep it around a few minutes for a quick return. */
  release(entry) {
    const keepMs = Math.min(this.cfg.idleMs, 5 * 60 * 1000);
    entry.lastAccess = Math.min(entry.lastAccess, Date.now() - this.cfg.idleMs + keepMs);
  }

  sweep() {
    const now = Date.now();
    for (const e of [...this.entries.values()]) {
      if (e.error) { if (now - e.errorAt > 120000) this._remove(e, 'failed'); continue; }
      if (e.active === 0 && now - e.lastAccess > this.cfg.idleMs) this._remove(e, 'idle');
    }
    let used = this.bytesUsed();
    if (used <= this.cfg.cacheBytes) { this._warnedFull = false; return; }
    const idle = [...this.entries.values()]
      .filter((e) => e.active === 0 && now - e.lastAccess > 30000)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    for (const e of idle) {
      if (used <= this.cfg.cacheBytes) break;
      used -= (e.store && e.store.size) || 0;
      this._remove(e, 'cache full');
    }
    if (used > this.cfg.cacheBytes && !this._warnedFull) {
      this._warnedFull = true;
      this.log(`[torrent] cache over its ${(this.cfg.cacheBytes / 2 ** 30).toFixed(1)} GB limit and everything is in use`);
    }
  }

  files(entry) {
    const t = entry.torrent;
    if (!t || !t.files) return [];
    return t.files.map((f, i) => ({ i, name: f.name, path: f.path, size: f.length }));
  }

  /** Pick the file for the episode/movie (see release.chooseFile). */
  choose(entry, hints) {
    return R.chooseFile(entry.torrent.files.map((f) => ({ name: f.name, path: f.path, length: f.length })), hints);
  }

  /** Download this file in the background (and stop pre-downloading others). */
  activate(entry, idx) {
    const t = entry.torrent;
    if (!t || !t.ready || !t.files[idx]) return;
    for (const i of entry.selected) {
      if (i !== idx && t.files[i]) { t.files[i].deselect(); entry.selected.delete(i); }
    }
    if (!entry.selected.has(idx)) { t.files[idx].select(); entry.selected.add(idx); }
  }

  status(entry) {
    const t = entry.torrent;
    const state = entry.error ? 'error' : (t && t.ready ? 'ready' : (t && t.metadata ? 'verifying' : 'connecting'));
    return {
      hash: entry.hash,
      state,
      error: entry.error,
      name: (t && t.name) || entry.title || '',
      peers: t && !t.destroyed ? t.numPeers : 0,
      down: t && !t.destroyed ? Math.round(t.downloadSpeed) : 0,
      up: t && !t.destroyed ? Math.round(t.uploadSpeed) : 0,
    };
  }

  /** Per-file progress + a 0-9 map of which parts are downloaded (for the seek bar). */
  fileStatus(entry, idx, buckets = 80) {
    const t = entry.torrent;
    const f = t && t.files && t.files[idx];
    if (!f) return null;
    let map = '';
    if (t.bitfield && f.length > 0) {
      const start = f._startPiece;
      const end = f._endPiece;
      const n = end - start + 1;
      const per = Math.max(1, n / buckets);
      for (let b = 0; b < Math.min(buckets, n); b++) {
        const from = start + Math.floor(b * per);
        const to = Math.min(end, start + Math.floor((b + 1) * per) - 1);
        let have = 0;
        for (let p = from; p <= to; p++) if (t.bitfield.get(p)) have++;
        map += Math.round((have / (to - from + 1)) * 9);
      }
    }
    return { i: idx, name: f.name, size: f.length, done: f.downloaded, progress: f.progress, map };
  }

  /**
   * Stream bytes [start, end] of a file into an HTTP response, waiting for
   * pieces as they arrive. Counts as activity so the torrent isn't evicted.
   */
  async pipeRange(entry, idx, start, end, res) {
    const f = entry.torrent.files[idx];
    entry.active += 1;
    entry.lastAccess = Date.now();
    let finished = false;
    let it = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      entry.active -= 1;
      entry.lastAccess = Date.now();
      if (it && typeof it.return === 'function') Promise.resolve(it.return()).catch(() => {});
    };
    res.on('close', finish);
    try {
      it = f[Symbol.asyncIterator]({ start, end });
      let left = end - start + 1;
      while (left > 0 && !finished) {
        const { value, done } = await it.next();
        if (done || finished || !value) break;
        const chunk = value.length > left ? value.subarray(0, left) : value;
        left -= chunk.length;
        entry.lastAccess = Date.now();
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const go = () => { res.off('drain', go); res.off('close', go); resolve(); };
            res.on('drain', go);
            res.on('close', go);
          });
        }
      }
      if (!finished) res.end();
    } catch (err) {
      if (!finished) res.destroy(err);
    } finally {
      finish();
    }
  }

  /** Read a whole (small) file, e.g. a subtitle. */
  async readSmallFile(entry, idx, maxBytes = 5 * 2 ** 20, timeoutMs = 90000) {
    const f = entry.torrent.files[idx];
    if (!f || f.length > maxBytes) throw new EngineError('File too large', 413);
    entry.active += 1;
    const it = f[Symbol.asyncIterator]({ start: 0, end: f.length - 1 });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new EngineError('Timed out downloading the file.', 504)), timeoutMs);
    });
    try {
      const parts = [];
      let got = 0;
      while (got < f.length) {
        const { value, done } = await Promise.race([it.next(), timeout]);
        if (done || !value) break;
        parts.push(Buffer.from(value));
        got += value.length;
      }
      return Buffer.concat(parts).subarray(0, f.length);
    } finally {
      clearTimeout(timer);
      entry.active -= 1;
      entry.lastAccess = Date.now();
      if (typeof it.return === 'function') Promise.resolve(it.return()).catch(() => {});
    }
  }
}

module.exports = { TorrentEngine, EngineError };
