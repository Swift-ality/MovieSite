'use strict';

/**
 * Swift Servers — torrent streaming with our own player, in the spirit of
 * Stremio + Torrentio: find torrents for the title being opened, let the viewer
 * pick one to watch (or download), fetch it on this server and stream it to the
 * browser while it downloads.
 *
 * Routes:
 *   GET  /api/torrents/search?kind=&id=&s=&e=   ranked streams for a title/episode
 *   POST /api/torrent/start   { t }              start (or reuse) a torrent
 *   GET  /api/torrent/:hash/status               progress, file choice, how to play
 *   GET  /api/torrent/:hash/:idx/raw             byte-range stream (direct play / ffmpeg input; ?dl=1 downloads)
 *   GET  /api/torrent/:hash/:idx/play            ffmpeg remux/transcode -> fragmented MP4
 *   GET  /api/torrent/:hash/:idx/sub/:sid        embedded text subtitle -> WebVTT
 *   GET  /api/torrent/:hash/:idx/subfile         subtitle file in the torrent -> WebVTT
 *   POST /api/torrent/:hash/release              viewer left (frees it sooner)
 *
 * Stream lists hand the browser signed tokens, so visitors can only start
 * torrents this server found itself — not arbitrary ones.
 */

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { TorrentEngine } = require('./engine');
const media = require('./media');
const { createProviders, splitUrls, withTimeout } = require('./providers');
const R = require('./release');

// Public trackers added to every torrent (helps infoHash-only links find peers fast).
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://nyaa.tracker.wf:7777/announce',
];

const HASH_RE = /^[a-f0-9]{40}$/;
const KINDS = new Set(['movie', 'tv', 'anime-movie', 'anime-show']);
const CAPS = new Set(['hevc', 'av1', 'vp9', 'ac3', 'eac3', 'opus', 'flac']);
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t',
};
const LANGS = {
  en: /\b(english|eng|en)\b/, nl: /\b(dutch|nederlands|dut|nld|nl)\b/, de: /\b(german|deutsch|ger|deu|de)\b/,
  fr: /\b(french|francais|fre|fra|fr)\b/, es: /\b(spanish|espanol|spa|es|latino)\b/, it: /\b(italian|ita|it)\b/,
  pt: /\b(portuguese|brazilian|por|pt|ptbr|pt br)\b/, ru: /\b(russian|rus|ru)\b/, ja: /\b(japanese|jpn|ja|jp)\b/,
  ar: /\b(arabic|ara|ar)\b/, pl: /\b(polish|pol|pl)\b/, tr: /\b(turkish|tur|tr)\b/, sv: /\b(swedish|swe|sv)\b/,
  zh: /\b(chinese|chi|zho|chs|cht|zh)\b/, ko: /\b(korean|kor|ko)\b/,
};

function num(v, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function intParam(v) {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isInteger(n) ? n : null;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const uniq = (arr) => [...new Set(arr)];
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function readConfig(env, appDir) {
  const cacheGb = Math.max(1, num(env.TORRENT_CACHE_GB, 20));
  const preset = String(env.TORRENT_TRANSCODE_PRESET || '');
  return {
    addons: splitUrls(env.STREMIO_ADDONS),
    torznab: splitUrls(env.TORZNAB_URLS),
    torznabKey: String(env.TORZNAB_APIKEY || '').trim(),
    maxRes: num(env.TORRENT_MAX_RES, 1080),
    maxFileBytes: Math.min(num(env.TORRENT_MAX_FILE_GB, 15), cacheGb * 0.9) * 2 ** 30,
    transcode: String(env.TORRENT_TRANSCODE ?? '1').trim() !== '0',
    transcodeHeight: clamp(num(env.TORRENT_TRANSCODE_HEIGHT, 720), 240, 2160),
    transcodePreset: /^(ultrafast|superfast|veryfast|faster|fast|medium)$/.test(preset) ? preset : 'veryfast',
    maxTranscodes: Math.max(0, num(env.TORRENT_MAX_TRANSCODES, 1)),
    engine: {
      dir: path.resolve(appDir, env.TORRENT_DIR || 'torrent-cache'),
      maxActive: Math.max(1, num(env.TORRENT_MAX_ACTIVE, 3)),
      cacheBytes: cacheGb * 2 ** 30,
      idleMs: Math.max(1, num(env.TORRENT_IDLE_MINUTES, 20)) * 60000,
      metaTimeoutMs: Math.max(10, num(env.TORRENT_CONNECT_TIMEOUT, 60)) * 1000,
      trackers: uniq([
        ...(String(env.TORRENT_PUBLIC_TRACKERS ?? '1').trim() === '0' ? [] : DEFAULT_TRACKERS),
        ...String(env.TORRENT_TRACKERS || '').split(/[\s,]+/).filter((t) => /^(udp|https?):\/\//i.test(t)),
      ]),
      dht: String(env.TORRENT_DHT ?? '1').trim() !== '0',
      torrentPort: num(env.TORRENT_PORT, 0),
      dhtPort: num(env.TORRENT_DHT_PORT, 0),
      downloadLimit: num(env.TORRENT_DOWNLOAD_KBPS, 0) * 1024,
      uploadLimit: num(env.TORRENT_UPLOAD_KBPS, 0) * 1024,
      maxConns: Math.max(10, num(env.TORRENT_MAX_CONNS, 55)),
    },
  };
}

function parseCaps(v) {
  return new Set(String(v || '').toLowerCase().split(',').filter((x) => CAPS.has(x)));
}
function guessLang(name) {
  const t = ` ${R.norm(name).replace(/-/g, ' ')} `;
  for (const [code, re] of Object.entries(LANGS)) if (re.test(t)) return code;
  return '';
}

function setupTorrents(app, deps) {
  const cfg = readConfig(process.env, deps.appDir);
  const providers = createProviders(cfg);
  if (!providers.enabled) {
    console.log('[torrent] off: set STREMIO_ADDONS and/or TORZNAB_URLS to enable torrent streaming.');
    return { enabled: false };
  }

  const engine = new TorrentEngine(cfg.engine);
  engine.init();
  const bins = media.detect();
  console.log(`[torrent] on: ${providers.count} source(s) (${providers.names().join(', ')}); ` +
    `ffmpeg ${bins.ffmpeg ? 'yes' : 'NO'}, ffprobe ${bins.ffprobe ? 'yes' : 'NO'}; ` +
    `cache ${(cfg.engine.cacheBytes / 2 ** 30).toFixed(0)} GB in ${cfg.engine.dir}`);

  const secret = process.env.TORRENT_SECRET ? Buffer.from(process.env.TORRENT_SECRET) : crypto.randomBytes(32);
  const rawUrl = (hash, idx) => `http://127.0.0.1:${deps.port}/api/torrent/${hash}/${idx}/raw`;
  let transcodes = 0;

  // --- signed stream tokens --------------------------------------------------
  function sign(payload) {
    const body = Buffer.from(JSON.stringify({ ...payload, x: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32);
    return `${body}.${mac}`;
  }
  function verify(token) {
    if (typeof token !== 'string' || token.length > 12000) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const body = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1));
    const want = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32));
    if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return p && p.x > Date.now() ? p : null;
    } catch (_) {
      return null;
    }
  }

  // --- title -> ids/names ----------------------------------------------------
  async function kitsuId(anilistId, malId, signal) {
    const lookups = [['anilist/anime', anilistId], ['myanimelist/anime', malId]];
    for (const [site, ext] of lookups) {
      if (!ext) continue;
      for (const host of ['https://kitsu.app', 'https://kitsu.io']) {
        try {
          const u = `${host}/api/edge/mappings?filter[externalSite]=${encodeURIComponent(site)}` +
            `&filter[externalId]=${encodeURIComponent(ext)}&include=item`;
          const res = await fetch(u, {
            headers: { accept: 'application/vnd.api+json' },
            signal: withTimeout(signal, 8000),
          });
          if (!res.ok) continue;
          const json = await res.json();
          const item = (json.included || []).find((x) => x && x.type === 'anime' && /^\d+$/.test(String(x.id)));
          if (item) return String(item.id);
          break;                             // the host answered: no mapping for this id
        } catch (_) {
          if (signal && signal.aborted) throw _;
        }
      }
    }
    return null;
  }

  async function resolveMeta(kind, id, signal) {
    const key = `tmeta:${kind}:${id}`;
    const hit = deps.cacheGet(key);
    if (hit) return hit;
    let meta;
    if (kind === 'movie' || kind === 'tv') {
      if (!deps.hasTmdb) throw httpError(503, 'Server is missing TMDB_API_KEY.');
      const d = await deps.tmdb(`/${kind}/${id}`, { append_to_response: 'external_ids' }, signal);
      const imdb = String(d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || '').trim();
      meta = {
        imdb: /^tt\d+$/.test(imdb) ? imdb : null,
        kitsu: null,
        titles: uniq([d.title || d.name, d.original_title || d.original_name].filter(Boolean)),
        year: Number(String(d.release_date || d.first_air_date || '').slice(0, 4)) || null,
      };
    } else {
      const data = await deps.anilist(
        'query ($id: Int) { Media(id: $id, type: ANIME) { id idMal format seasonYear title { romaji english } synonyms } }',
        { id: Number(id) }, signal);
      const m = data && data.Media;
      if (!m) throw httpError(404, 'Anime not found.');
      const ascii = (s) => typeof s === 'string' && /^[\x20-\x7e]+$/.test(s);
      meta = {
        imdb: null,
        kitsu: await kitsuId(m.id, m.idMal, signal),
        titles: uniq([m.title && m.title.romaji, m.title && m.title.english, ...(m.synonyms || []).filter(ascii).slice(0, 2)].filter(Boolean)),
        year: m.seasonYear || null,
      };
    }
    deps.cacheSet(key, meta, 24 * 3600 * 1000);
    return meta;
  }

  function buildQuery(kind, meta, s, e) {
    const q = { kind, titles: meta.titles, year: meta.year, imdb: meta.imdb, season: s, episode: e, stremioType: null, stremioId: null };
    if (kind === 'movie' && meta.imdb) { q.stremioType = 'movie'; q.stremioId = meta.imdb; }
    if (kind === 'tv' && meta.imdb) { q.stremioType = 'series'; q.stremioId = `${meta.imdb}:${s}:${e}`; }
    if (kind === 'anime-show' && meta.kitsu) { q.stremioType = 'series'; q.stremioId = `kitsu:${meta.kitsu}:${e}`; }
    if (kind === 'anime-movie' && meta.kitsu) { q.stremioType = 'movie'; q.stremioId = `kitsu:${meta.kitsu}`; }
    return q;
  }

  // --- search ------------------------------------------------------------------
  app.get('/api/torrents/search', async (req, res) => {
    const kind = String(req.query.kind || '');
    const id = String(req.query.id || '');
    const s = intParam(req.query.s);
    const e = intParam(req.query.e);
    if (!KINDS.has(kind) || !/^\d{1,10}$/.test(id)) return res.status(400).json({ error: 'Bad request.' });
    if (kind === 'tv' && !(s >= 0 && e >= 1)) return res.status(400).json({ error: 'Season and episode required.' });
    if (kind === 'anime-show' && !(e >= 1)) return res.status(400).json({ error: 'Episode required.' });

    const signal = deps.clientAbortSignal(res);
    try {
      const key = `tsearch:${kind}:${id}:${s}:${e}`;
      let found = deps.cacheGet(key);
      if (!found) {
        const meta = await resolveMeta(kind, id, signal);
        const q = buildQuery(kind, meta, s, e);
        found = await providers.search(q, signal);
        if (signal.aborted) return;
        found.lookup = { imdb: meta.imdb, kitsu: meta.kitsu };
        const allOk = found.providers.every((p) => p.ok);
        deps.cacheSet(key, found, found.streams.length && allOk ? 20 * 60 * 1000 : 60 * 1000);
      }
      const ph = String(req.query.ph || '').toLowerCase();
      const ranked = R.rankStreams(found.streams, {
        kind,
        caps: parseCaps(req.query.caps),
        maxRes: cfg.maxRes,
        maxFileBytes: cfg.maxFileBytes,
        dead: engine.recentFailures(),
        prefer: {
          hash: HASH_RE.test(ph) ? ph : null,
          group: String(req.query.pg || '').toLowerCase().slice(0, 40) || null,
          res: intParam(req.query.pr),
        },
      });
      const streams = ranked.streams.slice(0, 40).map((st) => {
        const ep = kind === 'tv' ? R.parseEpisode(st.title) : null;
        const batch = kind === 'anime-show' ? R.animeBatch(st.title) : null;
        return {
          t: st.url ? null : sign({ h: st.infoHash, f: st.fileIdx, tr: st.trackers.slice(0, 25), l: st.link || null, n: st.title.slice(0, 120) }),
          url: st.url || null,
          hash: st.infoHash || null,
          title: st.title,
          file: st.fileName || null,
          provider: st.provider,
          origin: st.origin || null,
          quality: R.qualityLabel(st.parsed),
          res: st.parsed.res,
          tags: R.tagList(st.parsed),
          size: st.size || null,
          seeders: st.seeders,
          pack: Boolean(st.pack || (ep && ep.pack) || batch),
          group: st.parsed.group,
          score: st.score,
        };
      });
      res.json({ streams, hidden: ranked.hidden, providers: found.providers, lookup: found.lookup });
    } catch (err) {
      if (signal.aborted) return;
      console.error('[torrent] search error:', err.message);
      res.status(err.status || 502).json({ error: err.message || 'Search failed.' });
    }
  });

  // --- start -----------------------------------------------------------------
  async function fetchTorrentLink(link) {
    let url = link;
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(url, { redirect: 'manual', signal: withTimeout(null, 20000) });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location') || '';
        if (/^magnet:/i.test(loc)) {
          const m = R.parseMagnet(loc);
          if (!m) throw httpError(422, 'The indexer returned a bad magnet link.');
          return { infoHash: m.infoHash, trackers: m.trackers };
        }
        url = new URL(loc, url).toString();
        continue;
      }
      if (!r.ok) throw httpError(502, `The indexer answered HTTP ${r.status} for the torrent file.`);
      if (Number(r.headers.get('content-length') || 0) > 8 * 2 ** 20) throw httpError(422, 'Torrent file too large.');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 8 * 2 ** 20 || buf[0] !== 0x64) throw httpError(422, 'The indexer did not return a torrent file.');
      return { torrentFile: buf };
    }
    throw httpError(502, 'Too many redirects fetching the torrent file.');
  }

  app.post('/api/torrent/start', express.json({ limit: '32kb' }), async (req, res) => {
    const p = verify(req.body && req.body.t);
    if (!p) return res.status(403).json({ error: 'This stream link expired.', expired: true });
    if (!p.h && !p.l) return res.status(400).json({ error: 'Not a torrent stream.' });
    try {
      const src = { infoHash: p.h || null, trackers: Array.isArray(p.tr) ? p.tr.slice(0, 40) : [], title: p.n || '' };
      if (!src.infoHash) Object.assign(src, await fetchTorrentLink(p.l));
      const entry = await engine.add(src);
      res.json({ hash: entry.hash, fileIdx: Number.isInteger(p.f) ? p.f : null });
    } catch (err) {
      console.error('[torrent] start failed:', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // --- status (+ choosing the file, probing it, deciding how to play) ---------
  function probeFor(entry, idx) {
    let pr = entry.probes.get(idx);
    if (pr) return pr;
    pr = { desc: null, error: null, heuristic: !bins.ffprobe };
    entry.probes.set(idx, pr);
    if (bins.ffprobe) {
      const ext = R.extOf(entry.torrent.files[idx].name);
      media.probe(bins.ffprobe, rawUrl(entry.hash, idx)).then(
        (info) => { pr.desc = media.describe(info, ext); },
        (err) => {
          pr.error = err.message;
          setTimeout(() => { if (entry.probes.get(idx) === pr) entry.probes.delete(idx); }, 30000);  // allow a retry later
        });
    }
    return pr;
  }

  function externalSubs(entry, idx) {
    const files = entry.torrent.files;
    const video = files[idx];
    const vPath = video.path.replace(/\\/g, '/');
    const vDir = path.posix.dirname(vPath);
    const vBase = video.name.replace(/\.[^.]+$/, '').toLowerCase();
    const vEp = R.parseEpisode(video.name);
    const out = [];
    files.forEach((f, i) => {
      if (!R.isSubName(f.name) || f.length > 5 * 2 ** 20) return;
      const p = f.path.replace(/\\/g, '/');
      const dir = path.posix.dirname(p);
      const related = f.name.toLowerCase().startsWith(vBase) || dir === vDir ||
        dir.startsWith(`${vDir}/`) || /(^|\/)(subs?|subtitles?)(\/|$)/i.test(dir);
      if (!related) return;
      if (vEp && vEp.episode != null) {              // season packs: only this episode's files
        const se = R.parseEpisode(p);
        if (se && se.episode != null && (se.season !== vEp.season || se.episode !== vEp.episode)) return;
      }
      out.push({
        id: `f${i}`, kind: 'file', lang: guessLang(p), title: f.name.slice(0, 80),
        forced: /forced/i.test(f.name), default: false,
        url: `/api/torrent/${entry.hash}/${i}/subfile`,
      });
    });
    return out.slice(0, 40);
  }

  function playbackFor(entry, idx, pr, caps, audioIndex) {
    const base = `/api/torrent/${entry.hash}/${idx}`;
    const f = entry.torrent.files[idx];
    if (pr.error) return { mode: 'error', reason: pr.error };
    if (pr.heuristic) {
      const ext = R.extOf(f.name);
      if (['mp4', 'm4v', 'webm'].includes(ext)) {
        return { mode: 'direct', url: `${base}/raw`, duration: null, audio: [], audioIndex: null, subs: externalSubs(entry, idx) };
      }
      return { mode: 'unsupported', reason: `.${ext || '?'} files need ffmpeg on the server.` };
    }
    const d = pr.desc;
    const pl = media.plan(d, caps, {
      audioIndex,
      transcode: cfg.transcode && cfg.maxTranscodes > 0,
      haveFfmpeg: Boolean(bins.ffmpeg),
    });
    const subs = bins.ffmpeg
      ? d.subs.filter((s) => s.text).map((s) => ({
        id: `e${s.index}`, kind: 'embedded', lang: s.lang, title: s.title, forced: s.forced, default: s.default,
        url: `${base}/sub/${s.index}`,
      }))
      : [];
    return {
      mode: pl.mode,
      reason: pl.reason || null,
      duration: d.duration,
      url: pl.mode === 'direct' ? `${base}/raw`
        : (pl.mode === 'remux' || pl.mode === 'transcode') ? `${base}/play?m=${pl.mode}` : null,
      audioIndex: pl.audio,
      audio: d.audio.map((a) => ({ index: a.index, codec: a.codec, channels: a.channels, lang: a.lang, title: a.title, default: a.default })),
      subs: subs.concat(externalSubs(entry, idx)),
      video: d.video ? { codec: d.video.codec, width: d.video.width, height: d.video.height } : null,
    };
  }

  function lookupEntry(req, res) {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!HASH_RE.test(hash)) { res.status(400).json({ error: 'Bad torrent id.' }); return null; }
    const entry = engine.get(hash);
    if (!entry) { res.status(404).json({ error: 'This torrent is no longer active.', gone: true }); return null; }
    return entry;
  }

  app.get('/api/torrent/:hash/status', (req, res) => {
    const entry = lookupEntry(req, res);
    if (!entry) return;
    const st = engine.status(entry);
    if (st.state === 'ready') {
      let idx = intParam(req.query.file);
      if (idx === null || !entry.torrent.files[idx]) {
        const choice = engine.choose(entry, {
          fileIdx: intParam(req.query.fi),
          kind: String(req.query.kind || ''),
          season: intParam(req.query.s),
          episode: intParam(req.query.e),
        });
        idx = choice.idx >= 0 ? choice.idx : null;
        if (idx === null) {
          st.choice = choice.reason;
          st.files = engine.files(entry).filter((f) => R.isVideoName(f.name)).slice(0, 300)
            .map((f) => ({ i: f.i, name: f.path.replace(/\\/g, '/'), size: f.size }));
        }
      }
      if (idx !== null) {
        engine.activate(entry, idx);
        st.file = engine.fileStatus(entry, idx);
        if (req.query.noprobe) return res.json(st);       // downloads don't need playback info
        const pr = probeFor(entry, idx);
        if (pr.desc || pr.error || pr.heuristic) {
          st.playback = playbackFor(entry, idx, pr, parseCaps(req.query.caps), intParam(req.query.a));
        } else {
          st.probing = true;
        }
      }
    }
    res.json(st);
  });

  // --- file data -------------------------------------------------------------
  function fileCtx(req, res) {
    const entry = lookupEntry(req, res);
    if (!entry) return null;
    if (entry.error) { res.status(410).json({ error: entry.error }); return null; }
    if (!entry.torrent || !entry.torrent.ready) { res.status(409).json({ error: 'Torrent is still connecting.' }); return null; }
    const idx = intParam(req.params.idx);
    if (idx === null || idx < 0 || idx >= entry.torrent.files.length) { res.status(404).json({ error: 'No such file.' }); return null; }
    return { entry, idx, file: entry.torrent.files[idx] };
  }

  app.get('/api/torrent/:hash/:idx/raw', (req, res) => {
    const ctx = fileCtx(req, res);
    if (!ctx) return;
    const size = ctx.file.length;
    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = req.headers.range;
    if (range && size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && (m[1] || m[2])) {
        if (m[1] === '') {
          start = Math.max(0, size - Number(m[2]));
        } else {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), size - 1);
        }
        if (start > end || start >= size) {
          res.status(416).set('Content-Range', `bytes */${size}`).end();
          return;
        }
        partial = true;
      }
    }
    res.status(partial ? 206 : 200);
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Type': MIME[R.extOf(ctx.file.name)] || 'application/octet-stream',
      'Content-Length': String(size === 0 ? 0 : end - start + 1),
      'Cache-Control': 'no-store',
    });
    if (partial) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    if (req.query.dl) {                     // "⬇ Download": save the file instead of playing it
      const name = ctx.file.name;
      const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    if (req.method === 'HEAD' || size === 0) { res.end(); return; }
    engine.pipeRange(ctx.entry, ctx.idx, start, end, res);
  });

  // Run an ffmpeg job whose stdout is the response; ends it when the viewer leaves.
  function pipeJob(ctx, res, child, contentType, onDone) {
    const { entry } = ctx;
    entry.active += 1;
    let done = false;
    let stderr = '';
    const finish = () => {
      if (done) return;
      done = true;
      entry.active -= 1;
      entry.lastAccess = Date.now();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (onDone) onDone();
    };
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-3000); });
    child.on('error', (err) => {
      console.error('[torrent] ffmpeg failed to start:', err.message);
      finish();
      if (!res.headersSent) res.status(500).json({ error: 'ffmpeg failed to start.' });
      else res.destroy();
    });
    child.on('close', (code) => {
      if (code && !done) console.error(`[torrent] ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
      finish();
      if (!res.writableEnded) res.end();
    });
    res.on('close', finish);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    child.stdout.pipe(res);
  }

  app.get('/api/torrent/:hash/:idx/play', (req, res) => {
    const ctx = fileCtx(req, res);
    if (!ctx) return;
    const pr = ctx.entry.probes.get(ctx.idx);
    if (!pr || !pr.desc) return res.status(409).json({ error: 'The file hasn\'t been analysed yet.' });
    if (!bins.ffmpeg) return res.status(501).json({ error: 'ffmpeg is not installed on the server.' });
    const d = pr.desc;
    if (!d.video) return res.status(415).json({ error: 'No video stream.' });
    const caps = parseCaps(req.query.caps);
    const audio = d.audio.find((a) => a.index === intParam(req.query.a)) || media.defaultAudio(d);
    const transcode = req.query.m === 'transcode';
    if (transcode) {
      if (!cfg.transcode || cfg.maxTranscodes <= 0) return res.status(403).json({ error: 'Transcoding is turned off on this server.' });
      if (transcodes >= cfg.maxTranscodes) {
        return res.status(503).json({ error: 'The server is already converting another video. Pick an x264 stream, or try again shortly.' });
      }
      transcodes += 1;
    }
    const t = clamp(num(req.query.t, 0), 0, Math.max(0, (d.duration || 0) - 1));
    const child = media.spawnPlay(bins.ffmpeg, rawUrl(ctx.entry.hash, ctx.idx), {
      t,
      videoIndex: d.video.index,
      videoCodec: d.video.codec,
      videoCopy: !transcode,
      audioIndex: audio ? audio.index : null,
      audioCopy: audio ? (transcode ? ['aac', 'mp3'].includes(audio.codec) : media.audioCopyable(audio.codec, caps)) : false,
      height: cfg.transcodeHeight,
      preset: cfg.transcodePreset,
    });
    pipeJob(ctx, res, child, 'video/mp4', transcode ? () => { transcodes -= 1; } : null);
  });

  // Where a remux started at ~t will really begin (the keyframe at/near t).
  app.get('/api/torrent/:hash/:idx/keyframe', async (req, res) => {
    const ctx = fileCtx(req, res);
    if (!ctx) return;
    const pr = ctx.entry.probes.get(ctx.idx);
    if (!pr || !pr.desc) return res.status(409).json({ error: 'The file hasn\'t been analysed yet.' });
    const t = clamp(num(req.query.t, 0), 0, Math.max(0, (pr.desc.duration || 0) - 1));
    if (t <= 0 || !bins.ffprobe) return res.json({ t });
    ctx.entry.active += 1;
    try {
      const k = await media.keyframeAt(bins.ffprobe, rawUrl(ctx.entry.hash, ctx.idx), t);
      // keyframes are seconds apart at most; anything else means the lookup misfired
      res.json({ t: k !== null && Math.abs(k - t) < 30 ? k : t, exact: k !== null });
    } finally {
      ctx.entry.active -= 1;
      ctx.entry.lastAccess = Date.now();
    }
  });

  app.get('/api/torrent/:hash/:idx/sub/:sid', (req, res) => {
    const ctx = fileCtx(req, res);
    if (!ctx) return;
    const pr = ctx.entry.probes.get(ctx.idx);
    const sid = intParam(req.params.sid);
    const sub = pr && pr.desc && pr.desc.subs.find((s) => s.index === sid && s.text);
    if (!sub) return res.status(404).json({ error: 'No such subtitle track.' });
    if (!bins.ffmpeg) return res.status(501).json({ error: 'ffmpeg is not installed on the server.' });
    const t = clamp(num(req.query.t, 0), 0, Math.max(0, (pr.desc.duration || 0) - 1));
    const child = media.spawnSubs(bins.ffmpeg, rawUrl(ctx.entry.hash, ctx.idx), { t, streamIndex: sid });
    pipeJob(ctx, res, child, 'text/vtt; charset=utf-8');
  });

  app.get('/api/torrent/:hash/:idx/subfile', async (req, res) => {
    const ctx = fileCtx(req, res);
    if (!ctx) return;
    const ext = R.extOf(ctx.file.name);
    if (!R.isSubName(ctx.file.name)) return res.status(404).json({ error: 'Not a subtitle file.' });
    try {
      if (ext === 'srt' || ext === 'vtt') {
        const buf = await engine.readSmallFile(ctx.entry, ctx.idx);
        const vtt = ext === 'vtt' ? buf.toString('utf8') : media.srtToVtt(buf);
        res.set('Cache-Control', 'no-store').type('text/vtt; charset=utf-8').send(vtt);
        return;
      }
      if (!bins.ffmpeg) return res.status(501).json({ error: 'ffmpeg is needed for .ass subtitles.' });
      pipeJob(ctx, res, media.spawnSubFile(bins.ffmpeg, rawUrl(ctx.entry.hash, ctx.idx)), 'text/vtt; charset=utf-8');
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/torrent/:hash/release', (req, res) => {
    const hash = String(req.params.hash || '').toLowerCase();
    const entry = HASH_RE.test(hash) ? engine.entries.get(hash) : null;
    if (entry) engine.release(entry);
    res.status(204).end();
  });

  return {
    enabled: true,
    // "Swift Servers": its own group in the player's Server menu, played by our own player
    source: { id: 'swift', name: '⚡ Swift Server', group: 'Swift Servers', torrent: true },
    info: { transcode: cfg.transcode && cfg.maxTranscodes > 0 && Boolean(bins.ffmpeg), ffmpeg: Boolean(bins.ffmpeg) },
  };
}

module.exports = { setupTorrents, readConfig };
