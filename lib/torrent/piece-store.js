'use strict';

/**
 * Chunk store for WebTorrent (abstract-chunk-store API).
 *
 * Verified pieces are appended to a single `<infoHash>.pieces` file with an
 * in-memory index (piece -> position). Compared with the default per-file
 * store this means:
 *  - disk usage == bytes actually downloaded. The default store writes into
 *    full-size sparse files, which panel disk quotas may count in full (a 40 GB
 *    season pack would "use" 40 GB after streaming one episode);
 *  - names/paths from the torrent never touch the filesystem.
 * The data is only meant to be read back through WebTorrent, so the pieces
 * don't need to be laid out as playable files.
 */

const fs = require('fs');
const path = require('path');

const noop = () => {};

class PieceStore {
  constructor(chunkLength, opts = {}) {
    this.chunkLength = Number(chunkLength);
    if (!this.chunkLength) throw new Error('First argument must be a chunk length');

    const store = opts.store || {};
    const infoHash = opts.torrent && opts.torrent.infoHash;
    if (!store.dir || !/^[a-f0-9]{40}$/.test(String(infoHash))) {
      throw new Error('PieceStore needs storeOpts.store.dir and a torrent infoHash');
    }
    this.file = path.join(store.dir, `${infoHash}.pieces`);
    this.length = Number(opts.length) || Infinity;
    this.lastChunkIndex = Number.isFinite(this.length) ? Math.ceil(this.length / this.chunkLength) - 1 : Infinity;
    this.lastChunkLength = Number.isFinite(this.length)
      ? (this.length % this.chunkLength) || this.chunkLength
      : this.chunkLength;

    this.index = new Map();   // piece -> { pos, len }
    this.size = 0;            // bytes appended so far (= size on disk)
    this.closed = false;
    this._fd = null;
    this._opening = null;     // pending open callbacks
    if (typeof store.onCreate === 'function') store.onCreate(this);
  }

  _open(cb) {
    if (this._fd !== null) return cb(null, this._fd);
    if (this._opening) { this._opening.push(cb); return; }
    this._opening = [cb];
    const done = (err, fd) => {
      const waiting = this._opening;
      this._opening = null;
      if (!err && this.closed) {           // closed while opening: don't leak the fd
        fs.close(fd, noop);
        err = new Error('Storage is closed');
      }
      if (!err) this._fd = fd;
      for (const fn of waiting) fn(err, fd);
    };
    fs.mkdir(path.dirname(this.file), { recursive: true }, (err) => {
      if (err) return done(err);
      if (this.closed) return done(new Error('Storage is closed'));
      fs.open(this.file, 'w+', done);
    });
  }

  put(index, buf, cb = noop) {
    if (this.closed) return process.nextTick(cb, new Error('Storage is closed'));
    const expected = index === this.lastChunkIndex ? this.lastChunkLength : this.chunkLength;
    if (!buf || buf.length !== expected) {
      return process.nextTick(cb, new Error(`Chunk length must be ${expected}`));
    }
    this._open((err, fd) => {
      if (err) return cb(err);
      if (this.closed) return cb(new Error('Storage is closed'));
      const pos = this.size;          // reserve the slot now so concurrent puts never overlap
      this.size += buf.length;
      fs.write(fd, buf, 0, buf.length, pos, (werr) => {
        if (werr) return cb(werr);
        this.index.set(index, { pos, len: buf.length });
        cb(null);
      });
    });
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = null; }
    cb = cb || noop;
    if (this.closed) return process.nextTick(cb, new Error('Storage is closed'));
    const hit = this.index.get(index);
    if (!hit) return process.nextTick(cb, new Error('Chunk not found'));
    const offset = (opts && opts.offset) || 0;
    const len = opts && opts.length != null ? opts.length : hit.len - offset;
    if (offset < 0 || len < 0 || offset + len > hit.len) {
      return process.nextTick(cb, new Error('Read outside of chunk'));
    }
    if (len === 0) return process.nextTick(cb, null, Buffer.alloc(0));
    const out = Buffer.allocUnsafe(len);
    fs.read(this._fd, out, 0, len, hit.pos + offset, (err, n) => {
      if (err) return cb(err);
      cb(null, n === len ? out : out.subarray(0, n));
    });
  }

  close(cb = noop) {
    if (this.closed) return process.nextTick(cb, null);
    this.closed = true;
    const fd = this._fd;
    this._fd = null;
    if (fd === null) return process.nextTick(cb, null);
    fs.close(fd, () => cb(null));
  }

  destroy(cb = noop) {
    this.close(() => {
      this.index.clear();
      fs.rm(this.file, { force: true }, () => cb(null));
    });
  }
}

module.exports = PieceStore;
