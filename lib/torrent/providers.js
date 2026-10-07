'use strict';

/**
 * Where torrents come from. Nothing is hardcoded: the server owner points it at
 *  - Stremio stream addons (STREMIO_ADDONS) — the protocol Torrentio and similar
 *    addons speak: GET {addon}/stream/{movie|series}/{id}.json, where id is an
 *    IMDB id (tt123, tt123:season:episode) or a Kitsu id for anime (kitsu:42:5);
 *  - Torznab indexers (TORZNAB_URLS) such as Jackett or Prowlarr.
 * Every provider is queried in parallel and the results are merged by infoHash.
 */

const R = require('./release');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) SwiftWatchesMovies/1.0';
const TIMEOUT_MS = 15000;

// Split a list of URLs. Addon URLs can contain commas (Torrentio-style config),
// so only whitespace, or a comma directly before another URL, separates them.
function splitUrls(value) {
  return String(value || '')
    .split(/\s+|,(?=\s*(?:https?|stremio):\/\/)/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function addonBase(url) {
  let s = String(url || '').trim().replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(s)) return null;
  s = s.replace(/\/manifest\.json(?:\?.*)?$/i, '').replace(/\/+$/, '');
  return s;
}

// AbortSignal that fires on the caller's signal or after `ms`.
function withTimeout(signal, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), ms);
  const stop = () => { clearTimeout(timer); ac.abort(new Error('aborted')); };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  ac.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  }, { once: true });
  return ac.signal;
}

function sizeToBytes(num, unit) {
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || '').toUpperCase().replace('I', '');
  const mult = { B: 1, KB: 2 ** 10, MB: 2 ** 20, GB: 2 ** 30, TB: 2 ** 40 }[u];
  return mult ? Math.round(n * mult) : null;
}

const HEX40 = /^[a-f0-9]{40}$/i;

// ---------------------------------------------------------------------------
// Stremio addons
// ---------------------------------------------------------------------------
class StremioAddon {
  constructor(url) {
    this.base = addonBase(url);
    let host = 'addon';
    try { host = new URL(this.base).hostname; } catch (_) { /* keep default */ }
    this.name = host;
    this._named = false;
  }

  async _loadName(signal) {
    if (this._named) return;
    this._named = true;
    try {
      const res = await fetch(`${this.base}/manifest.json`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: withTimeout(signal, 6000),
      });
      const m = await res.json();
      if (m && typeof m.name === 'string' && m.name.trim()) this.name = m.name.trim().slice(0, 40);
    } catch (_) {
      this._named = false;                 // try again next time
    }
  }

  async search(q, signal) {
    if (!q.stremioId) return [];
    this._loadName(signal).catch(() => {});
    const id = q.stremioId.split(':').map(encodeURIComponent).join(':');
    const res = await fetch(`${this.base}/stream/${q.stremioType}/${id}.json`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: withTimeout(signal, TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const out = [];
    for (const s of (json && Array.isArray(json.streams) ? json.streams : []).slice(0, 200)) {
      const st = this._normalize(s);
      if (st) out.push(st);
    }
    return out;
  }

  _normalize(s) {
    if (!s || typeof s !== 'object') return null;
    const infoHash = typeof s.infoHash === 'string' && HEX40.test(s.infoHash) ? s.infoHash.toLowerCase() : null;
    const url = !infoHash && typeof s.url === 'string' && /^https?:\/\//i.test(s.url) ? s.url : null;
    if (!infoHash && !url) return null;          // ytId / externalUrl etc. aren't playable here

    const nameLines = String(s.name || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const text = String(s.title || s.description || '');
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    const hints = s.behaviorHints && typeof s.behaviorHints === 'object' ? s.behaviorHints : {};
    const meta = /👤|💾|⚙️/;
    const releaseLines = lines.filter((l) => !meta.test(l));
    const title = (releaseLines[0] || nameLines.join(' ') || 'Unknown').slice(0, 300);
    let fileName = typeof hints.filename === 'string' ? hints.filename : null;
    if (!fileName && releaseLines[1] && R.isVideoName(releaseLines[1])) fileName = releaseLines[1];

    const seed = /👤\s*(\d+)/.exec(text);
    const size = /💾\s*([\d.]+)\s*([KMGT]i?B)/i.exec(text);
    const origin = /⚙️\s*([^\n👤💾]+)/.exec(text);
    const trackers = (Array.isArray(s.sources) ? s.sources : [])
      .filter((x) => typeof x === 'string' && x.startsWith('tracker:'))
      .map((x) => x.slice(8))
      .filter((x) => /^(udp|https?):\/\//i.test(x))
      .slice(0, 30);

    return {
      infoHash,
      url,
      fileIdx: Number.isInteger(s.fileIdx) && s.fileIdx >= 0 ? s.fileIdx : null,
      trackers,
      title,
      fileName: fileName ? fileName.slice(0, 300) : null,
      size: Number.isFinite(hints.videoSize) ? hints.videoSize : (size ? sizeToBytes(size[1], size[2]) : null),
      seeders: seed ? Number(seed[1]) : null,
      provider: this.name,
      origin: origin ? origin[1].trim().slice(0, 40) : null,
      bingeGroup: typeof hints.bingeGroup === 'string' ? hints.bingeGroup.slice(0, 120) : null,
      qualityHint: nameLines.slice(1).join(' '),
      exact: true,                       // the addon already matched the title/episode
    };
  }
}

// ---------------------------------------------------------------------------
// Torznab (Jackett / Prowlarr)
// ---------------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}
function xmlTag(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? decodeXml(m[1]).trim() : '';
}
function xmlAttr(tagText, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tagText);
  return m ? decodeXml(m[1]) : null;
}

function parseTorznab(xml) {
  const err = /<error\b[^>]*>/i.exec(xml);
  if (err && !/<item\b/i.test(xml)) {
    throw new Error(xmlAttr(err[0], 'description') || 'Torznab error');
  }
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const attrs = {};
    for (const a of block.matchAll(/<(?:torznab|newznab):attr\b([^>]*)\/?>/gi)) {
      const k = xmlAttr(a[1], 'name');
      if (k) attrs[k.toLowerCase()] = xmlAttr(a[1], 'value');
    }
    const enclosure = /<enclosure\b([^>]*)\/?>/i.exec(block);
    const indexer = /<(?:jackettindexer|prowlarrindexer)\b[^>]*>([\s\S]*?)<\//i.exec(block);
    items.push({
      title: xmlTag(block, 'title'),
      link: xmlTag(block, 'link') || (enclosure && xmlAttr(enclosure[1], 'url')) || '',
      size: Number(attrs.size || xmlTag(block, 'size')) || null,
      seeders: attrs.seeders != null ? Number(attrs.seeders) : null,
      infohash: attrs.infohash || null,
      magnet: attrs.magneturl || null,
      indexer: indexer ? decodeXml(indexer[1]).trim() : null,
    });
  }
  return items;
}

class TorznabIndexer {
  constructor(url, apiKey) {
    this.url = String(url).trim();
    this.apiKey = apiKey || '';
    let host = 'torznab';
    try {
      const u = new URL(this.url);
      host = u.hostname;
      const m = /\/indexers\/([^/]+)\//.exec(u.pathname);   // Jackett: .../indexers/<id>/results/torznab
      if (m && m[1] !== 'all') host = m[1];
    } catch (_) { /* keep default */ }
    this.name = host;
  }

  _endpoint(params) {
    const u = new URL(this.url);
    // Jackett/Prowlarr "feed" URLs omit the /api suffix (Sonarr/Radarr add it).
    if (!/\/api\/?$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, '/api');
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
    if (this.apiKey && !u.searchParams.has('apikey')) u.searchParams.set('apikey', this.apiKey);
    return u.toString();
  }

  async _query(params, signal) {
    const res = await fetch(this._endpoint(params), {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' },
      signal: withTimeout(signal, TIMEOUT_MS + 10000),       // indexers fan out, give them longer
    });
    const body = await res.text();
    if (!res.ok && !/<item\b/i.test(body)) throw new Error(`HTTP ${res.status}`);
    return parseTorznab(body);
  }

  async search(q, signal) {
    const imdbNum = q.imdb ? q.imdb.replace(/^tt/, '') : null;
    const name = q.titles[0] || '';
    const pad = (n) => String(n).padStart(2, '0');
    const queries = [];
    if (q.kind === 'movie') {
      if (imdbNum) queries.push({ byId: true, p: { t: 'movie', imdbid: imdbNum, limit: 100 } });
      if (name) queries.push({ p: { t: 'search', q: [name, q.year].filter(Boolean).join(' '), limit: 100 } });
    } else if (q.kind === 'tv') {
      if (imdbNum) queries.push({ byId: true, p: { t: 'tvsearch', imdbid: imdbNum, season: q.season, ep: q.episode, limit: 100 } });
      if (name) {
        queries.push({ p: { t: 'search', q: `${name} S${pad(q.season)}E${pad(q.episode)}`, limit: 100 } });
        queries.push({ p: { t: 'search', q: `${name} S${pad(q.season)}`, limit: 100 } });
      }
    } else {                                              // anime: titles + episode number
      for (const t of q.titles.slice(0, 2)) {
        queries.push({ p: { t: 'search', q: q.kind === 'anime-show' ? `${t} ${pad(q.episode)}` : t, limit: 100 } });
      }
      if (q.kind === 'anime-show' && q.titles[0]) queries.push({ p: { t: 'search', q: `${q.titles[0]} batch`, limit: 100 } });
    }

    const settled = await Promise.allSettled(queries.map((x) => this._query(x.p, signal).then((items) => ({ x, items }))));
    const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (!ok.length && settled.length) throw settled[0].reason;

    const out = [];
    for (const { x, items } of ok) {
      for (const it of items.slice(0, 150)) {
        const st = this._normalize(it, q, x.byId);
        if (st) out.push(st);
      }
    }
    return out;
  }

  _normalize(it, q, byId) {
    if (!it.title) return null;
    // Text searches return loose matches, and some indexers ignore an unsupported
    // imdbid and return their latest uploads: keep only this title (and episode).
    if (!R.titleMatch(it.title, q.titles)) return null;
    let pack = false;
    if (q.kind === 'movie') {
      const ep = R.parseEpisode(it.title);
      if (ep && ep.episode != null) return null;
      const p = R.parseRelease(it.title);
      if (q.year && p.year && Math.abs(p.year - q.year) > 1) return null;
    } else if (q.kind === 'tv') {
      const match = R.tvMatch(R.parseEpisode(it.title), q.season, q.episode);
      if (!match) return null;
      pack = match === 'pack';
    } else if (q.kind === 'anime-show') {
      const ep = R.animeEpisode(it.title);
      const batch = R.animeBatch(it.title);
      if (batch && (batch.batch || (q.episode >= batch.from && q.episode <= batch.to))) pack = true;
      else if (ep !== q.episode) return null;
    }

    let infoHash = it.infohash && HEX40.test(it.infohash) ? it.infohash.toLowerCase() : null;
    let trackers = [];
    let magnet = null;
    const mag = R.parseMagnet(it.magnet || (/^magnet:/i.test(it.link) ? it.link : ''));
    if (mag) {
      infoHash = infoHash || mag.infoHash;
      trackers = mag.trackers.slice(0, 30);
      magnet = null;                                      // hash + trackers is all we need
    }
    const link = !infoHash && /^https?:\/\//i.test(it.link) ? it.link : null;
    if (!infoHash && !link) return null;
    return {
      infoHash,
      url: null,
      link,                                               // .torrent download (resolved when played)
      magnet,
      fileIdx: null,
      trackers,
      title: it.title.slice(0, 300),
      fileName: null,
      size: it.size,
      seeders: Number.isFinite(it.seeders) ? it.seeders : null,
      provider: this.name,
      origin: it.indexer ? it.indexer.slice(0, 40) : null,
      bingeGroup: null,
      qualityHint: '',
      pack,
      exact: byId,
    };
  }
}

// ---------------------------------------------------------------------------
function createProviders({ addons = [], torznab = [], torznabKey = '' } = {}) {
  const list = [
    ...addons.map(addonBase).filter(Boolean).map((u) => new StremioAddon(u)),
    ...torznab.filter((u) => /^https?:\/\//i.test(u)).map((u) => new TorznabIndexer(u, torznabKey)),
  ];

  async function search(q, signal) {
    const started = Date.now();
    const settled = await Promise.allSettled(list.map((p) => p.search(q, signal)));
    const providers = [];
    const merged = new Map();             // infoHash | url | link -> stream
    settled.forEach((s, i) => {
      const p = list[i];
      if (s.status === 'rejected') {
        const msg = s.reason && s.reason.message === 'timeout' ? 'timed out' : String((s.reason && s.reason.message) || s.reason);
        providers.push({ name: p.name, ok: false, count: 0, error: msg.slice(0, 120) });
        return;
      }
      providers.push({ name: p.name, ok: true, count: s.value.length });
      for (const st of s.value) {
        const key = st.infoHash || st.url || st.link;
        const prev = merged.get(key);
        if (!prev) { merged.set(key, st); continue; }
        // same torrent from several sources: keep the richest info
        if (prev.fileIdx == null && st.fileIdx != null) prev.fileIdx = st.fileIdx;
        if (!prev.fileName && st.fileName) prev.fileName = st.fileName;
        if (st.seeders != null && (prev.seeders == null || st.seeders > prev.seeders)) prev.seeders = st.seeders;
        if (!prev.size && st.size) prev.size = st.size;
        prev.trackers = [...new Set([...prev.trackers, ...st.trackers])].slice(0, 40);
        prev.exact = prev.exact || st.exact;
      }
    });
    const streams = [...merged.values()].map((st) => ({
      ...st,
      parsed: R.parseRelease([st.title, st.fileName, st.qualityHint].filter(Boolean).join(' ')),
    }));
    // the file name (when known) has the real container
    for (const st of streams) {
      if (st.fileName) st.parsed.ext = R.extOf(st.fileName) || st.parsed.ext;
    }
    return { streams, providers, ms: Date.now() - started };
  }

  return { enabled: list.length > 0, count: list.length, names: () => list.map((p) => p.name), search };
}

module.exports = { createProviders, splitUrls, addonBase, parseTorznab, withTimeout };
