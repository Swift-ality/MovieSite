'use strict';

/**
 * Helpers for torrent release names: quality/codec parsing, season/episode
 * matching, picking the right file inside a torrent, and ranking streams so the
 * best browser-playable one is tried first.
 */

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|ts|m2ts|mts|mpg|mpeg|flv|ogv)$/i;
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

const isVideoName = (n) => VIDEO_EXT.test(String(n || ''));
const isSubName = (n) => SUB_EXT.test(String(n || ''));

function extOf(name) {
  const m = /\.(mp4|m4v|mkv|webm|avi|mov|wmv|ts|m2ts|mts|mpg|mpeg|flv|ogv|srt|vtt|ass|ssa)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// Lowercase, extension stripped, separators turned into single spaces.
function norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(VIDEO_EXT, '')
    .replace(SUB_EXT, '')
    .replace(/[._\[\](){}+,~:;!?'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Loose title comparison key: accents/punctuation dropped.
function titleKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Quality / codec / source info from a release or file name. */
function parseRelease(raw) {
  const name = String(raw || '');
  const t = ' ' + norm(name).replace(/-/g, ' ') + ' ';
  const out = {
    res: null, hdr: false, dv: false, codec: null, tenBit: false,
    source: null, remux: false, cam: false, audio: [], channels: null,
    group: null, ext: extOf(name), year: null,
  };

  if (/\b(2160p|4k|uhd)\b/.test(t)) out.res = 2160;
  else if (/\b1080[pi]\b/.test(t)) out.res = 1080;
  else if (/\b720p\b/.test(t)) out.res = 720;
  else if (/\b576p\b/.test(t)) out.res = 576;
  else if (/\b(480p|360p|sd)\b/.test(t)) out.res = 480;

  out.hdr = /\b(hdr|hdr10|hdr10plus|hlg)\b/.test(t) || /hdr10\+/i.test(name);
  out.dv = /\b(dv|dovi|dolby vision)\b/.test(t);
  if (/\b(x265|h ?265|hevc)\b/.test(t)) out.codec = 'hevc';
  else if (/\b(x264|h ?264|avc)\b/.test(t)) out.codec = 'h264';
  else if (/\bav1\b/.test(t)) out.codec = 'av1';
  else if (/\bvp9\b/.test(t)) out.codec = 'vp9';
  else if (/\b(xvid|divx)\b/.test(t)) out.codec = 'xvid';
  out.tenBit = /\b(10 ?bits?|hi10p?)\b/.test(t);

  out.remux = /\bremux\b/.test(t);
  out.cam = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|dvdscr)\b/.test(t);
  if (out.cam) out.source = 'CAM';
  else if (out.remux) out.source = 'REMUX';
  else if (/\b(blu ?ray|bdrip|brrip|bd25|bd50|bdmv)\b/.test(t)) out.source = 'BluRay';
  else if (/\b(web ?dl|webdl)\b/.test(t)) out.source = 'WEB-DL';
  else if (/\b(web ?rip|webrip)\b/.test(t)) out.source = 'WEBRip';
  else if (/\bweb\b/.test(t)) out.source = 'WEB';
  else if (/\bhdtv\b/.test(t)) out.source = 'HDTV';
  else if (/\b(dvdrip|dvd ?rip|dvd)\b/.test(t)) { out.source = 'DVD'; if (!out.res) out.res = 480; }

  const audio = [];
  if (/\batmos\b/.test(t)) audio.push('Atmos');
  if (/\btruehd\b/.test(t)) audio.push('TrueHD');
  if (/\bdts\b/.test(t)) audio.push('DTS');
  if (/\b(ddp|dd\+|eac3|e ac3)/.test(t) || /dd\+|ddp/i.test(name)) audio.push('DD+');
  else if (/\b(ac3|dd5|dd 5)\b/.test(t)) audio.push('DD');
  if (/\baac/.test(t)) audio.push('AAC');
  if (/\bopus\b/.test(t)) audio.push('Opus');
  if (/\bflac\b/.test(t)) audio.push('FLAC');
  out.audio = audio;
  const ch = /\b([2578])[ .]1\b/.exec(name.replace(/[_]/g, ' '));
  if (ch) out.channels = `${ch[1]}.1`;

  const g = /-([A-Za-z0-9]{2,24})(?:\[[^\]]*\])?(?:\.[a-z0-9]{2,4})?$/.exec(name.trim()) ||
            /^\[([^\]]{2,30})\]/.exec(name.trim());
  if (g && !/^(dl|rip|\d+p)$/i.test(g[1])) out.group = g[1].toLowerCase();

  const y = /(?:^|\D)(19[2-9]\d|20[0-4]\d)(?:\D|$)/.exec(name.replace(/1080p|2160p|720p|480p/gi, ''));
  if (y) out.year = Number(y[1]);
  return out;
}

/**
 * Season/episode info from a TV release or file name.
 * -> { season, episode, episodeEnd } | { pack: true, season | seasonFrom/seasonTo | complete } | null
 */
function parseEpisode(raw) {
  const t = ' ' + norm(raw) + ' ';
  let m = /\bs(\d{1,2}) ?e(\d{1,4})(?: ?(?:-|to)? ?e(\d{1,4}))?\b/.exec(t);
  if (m) {
    const ep = Number(m[2]);
    let end = m[3] ? Number(m[3]) : null;
    if (!end) {                                   // S01E01-02 (second number without the E)
      const r = new RegExp(`\\bs${m[1]} ?e${m[2]} ?- ?(\\d{1,3})\\b`).exec(t);
      if (r && Number(r[1]) > ep && Number(r[1]) < ep + 50) end = Number(r[1]);
    }
    return { season: Number(m[1]), episode: ep, episodeEnd: end && end > ep ? end : null };
  }
  m = /(?:^|[^\d])(\d{1,2})x(\d{2,3})\b/.exec(t);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), episodeEnd: null };

  m = /\bs(\d{1,2}) ?(?:-|to) ?s?(\d{1,2})\b/.exec(t) ||
      /\bseasons? ?(\d{1,2}) ?(?:-|to) ?(\d{1,2})\b/.exec(t);
  if (m && Number(m[2]) > Number(m[1])) return { pack: true, seasonFrom: Number(m[1]), seasonTo: Number(m[2]) };
  m = /\bs(\d{1,2})\b/.exec(t) || /\bseason ?(\d{1,2})\b/.exec(t);
  if (m) return { pack: true, season: Number(m[1]) };
  if (/\b(complete|integral|collection|all seasons)\b/.test(t)) return { pack: true, complete: true };
  return null;
}

/** Does a parsed TV name cover S{season}E{episode}? 'episode' | 'pack' | false */
function tvMatch(info, season, episode) {
  if (!info) return false;
  if (info.episode != null) {
    if (info.season !== season) return false;
    if (info.episode === episode) return 'episode';
    return info.episodeEnd && episode >= info.episode && episode <= info.episodeEnd ? 'episode' : false;
  }
  if (info.complete) return 'pack';
  if (info.season != null) return info.season === season ? 'pack' : false;
  if (info.seasonFrom != null) return season >= info.seasonFrom && season <= info.seasonTo ? 'pack' : false;
  return false;
}

const RES_NUMBERS = new Set([360, 480, 540, 576, 720, 1080, 2160]);

/** Episode number in an anime release/file name ("[Group] Title - 05 (1080p) [ABCD1234].mkv"). */
function animeEpisode(raw) {
  let s = String(raw || '')
    .replace(VIDEO_EXT, '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
    .replace(/[._]/g, ' ');
  s = ` ${s} `;
  const sxe = /\bS\d{1,2}E(\d{1,4})\b/i.exec(s);
  if (sxe) return Number(sxe[1]);
  // drop codec/audio/quality tokens so their digits aren't mistaken for the episode
  s = s.replace(/\b(?:[hx] ?26[45]|hevc|av1|e?ac3|aac ?\d?(?: \d)?|dd(?:p|\+)? ?\d?(?: \d)?|flac ?\d?(?: \d)?|opus ?\d?(?: \d)?|\d{1,2} ?bits?|\d{3,4}p|\d\.\d)\b/gi, ' ');
  let m = /\s-\s(\d{1,4})(?:v\d)?(?=\s|$)/.exec(s) ||
          /\b(?:ep|episode|e)\s?(\d{1,4})(?:v\d)?\b/i.exec(s) ||
          /#(\d{1,4})\b/.exec(s);
  if (m) return Number(m[1]);
  const nums = [...s.matchAll(/\s(\d{1,4})(?:v\d)?(?=\s)/g)]
    .map((x) => Number(x[1]))
    .filter((n) => !(n >= 1900 && n <= 2100) && !RES_NUMBERS.has(n));
  return nums.length ? nums[nums.length - 1] : null;
}

/** Episode range of an anime batch ("01-28", "Batch"). -> { from, to } | { batch: true } | null */
function animeBatch(raw) {
  const s = String(raw || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  const m = /(?:^|\D)(\d{1,4})\s?(?:-|~|to)\s?(\d{1,4})(?!\d)/.exec(s);
  if (m && Number(m[2]) > Number(m[1]) && !RES_NUMBERS.has(Number(m[2]))) {
    return { from: Number(m[1]), to: Number(m[2]) };
  }
  if (/\b(batch|complete)\b/i.test(raw)) return { batch: true };
  return null;
}

/** Do all words of one of the titles appear in the release name? */
function titleMatch(releaseName, titles) {
  const r = ` ${titleKey(releaseName)} `;
  return titles.some((title) => {
    const words = titleKey(title).split(' ').filter((w) => w.length > 1 || /\d/.test(w));
    return words.length > 0 && words.every((w) => r.includes(` ${w} `));
  });
}

/**
 * Pick the file to play inside a torrent.
 * files: [{ name, path, length }]; hints: { fileIdx, kind, season, episode }
 * -> { idx, reason? }  (idx -1 when nothing fits)
 */
function chooseFile(files, hints = {}) {
  const list = files.map((f, i) => ({ i, name: f.name, path: f.path || f.name, size: f.length }));
  const videos = list.filter((f) => isVideoName(f.name));
  if (!videos.length) return { idx: -1, reason: 'This torrent has no video files.' };

  const hinted = Number.isInteger(hints.fileIdx) ? list[hints.fileIdx] : null;
  if (hinted && isVideoName(hinted.name)) return { idx: hinted.i };

  const extras = /\b(sample|trailer|featurettes?|extras?|behind the scenes|deleted scenes|bonus)\b/i;
  let pool = videos.filter((f) => !(extras.test(norm(f.path)) && f.size < 1.5 * 2 ** 30));
  if (!pool.length) pool = videos;
  const largest = (arr) => arr.reduce((a, b) => (b.size > a.size ? b : a));

  if (hints.kind === 'tv') {
    const hits = pool.filter((f) => tvMatch(parseEpisode(f.name), hints.season, hints.episode) === 'episode' ||
      tvMatch(parseEpisode(f.path), hints.season, hints.episode) === 'episode');
    if (hits.length) return { idx: largest(hits).i };
    if (pool.length === 1) return { idx: pool[0].i };
    return { idx: -1, reason: `S${hints.season}E${hints.episode} isn't in this torrent.` };
  }
  if (hints.kind === 'anime-show') {
    const hits = pool.filter((f) => animeEpisode(f.name) === hints.episode);
    if (hits.length) return { idx: largest(hits).i };
    if (pool.length === 1) return { idx: pool[0].i };
    return { idx: -1, reason: `Episode ${hints.episode} isn't in this torrent.` };
  }
  return { idx: largest(pool).i };
}

/** Rank streams: browser-friendly, healthy, sensible size first. */
function scoreStream(s, ctx) {
  const r = s.parsed;
  let score = 0;
  const res = r.res || 0;
  if (r.cam) score -= 400;
  if (!res) score += 30;
  else if (res > ctx.maxRes) score += res >= 2160 ? 5 : 35;
  else score += ({ 2160: 100, 1080: 100, 720: 80, 576: 55, 480: 50 })[res] || 40;
  if (res && res === ctx.maxRes) score += 10;

  switch (r.codec) {
    case 'h264': score += r.tenBit ? -25 : 30; break;
    case 'hevc': score += ctx.caps.has('hevc') ? 8 : -30; break;
    case 'av1': score += ctx.caps.has('av1') ? 0 : -40; break;
    case 'vp9': score += ctx.caps.has('vp9') ? 0 : -30; break;
    case 'xvid': score -= 30; break;
    default: break;
  }
  if (r.ext === 'mp4' || r.ext === 'm4v') score += 10;
  if (r.remux) score -= 35;

  if (s.seeders === 0) score -= 80;
  else if (s.seeders != null) score += Math.min(60, Math.log2(1 + s.seeders) * 9);
  else score += 12;

  if (s.size) {
    const gb = s.size / 2 ** 30;
    if (gb > 20) score -= 40;
    else if (gb > 10) score -= 20;
    else if (gb > 6) score -= 8;
    if (ctx.kind === 'movie' && gb < 0.25) score -= 30;   // suspiciously tiny for a film
  }
  if (s.url) score -= 5;                                   // direct links skip the server; can't remux them
  if (ctx.dead && s.infoHash && ctx.dead.has(s.infoHash)) score -= 300;   // failed here recently

  const p = ctx.prefer || {};
  if (p.hash && s.infoHash === p.hash) score += 120;       // same season pack: already connected
  else if (p.group && r.group && r.group === p.group) score += 25;
  if (p.res && res === p.res) score += 10;
  return Math.round(score);
}

function rankStreams(streams, ctx) {
  const ok = [];
  let hidden = 0;
  for (const s of streams) {
    if (s.size && s.size > ctx.maxFileBytes) { hidden += 1; continue; }
    ok.push({ ...s, score: scoreStream(s, ctx) });
  }
  ok.sort((a, b) => b.score - a.score || (b.seeders || 0) - (a.seeders || 0));
  return { streams: ok, hidden };
}

/** Short labels for the stream list. */
function qualityLabel(p) {
  if (p.cam) return 'CAM';
  if (p.res === 2160) return '4K';
  return p.res ? `${p.res}p` : '?';
}
function tagList(p) {
  const tags = [];
  if (p.source && p.source !== 'CAM') tags.push(p.source);
  if (p.codec) tags.push({ h264: 'x264', hevc: 'x265', av1: 'AV1', vp9: 'VP9', xvid: 'XviD' }[p.codec]);
  if (p.tenBit) tags.push('10bit');
  if (p.dv) tags.push('DV');
  if (p.hdr) tags.push('HDR');
  for (const a of p.audio.slice(0, 2)) tags.push(a);
  if (p.channels && p.channels !== '2.1') tags.push(p.channels);
  return tags;
}

/** infoHash (hex) + trackers out of a magnet link. Base32 hashes are converted. */
function parseMagnet(uri) {
  const s = String(uri || '');
  if (!/^magnet:\?/i.test(s)) return null;
  let params;
  try { params = new URLSearchParams(s.slice(s.indexOf('?') + 1)); } catch (_) { return null; }
  let hash = null;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
    if (!m) continue;
    if (/^[a-f0-9]{40}$/i.test(m[1])) hash = m[1].toLowerCase();
    else if (/^[a-z2-7]{32}$/i.test(m[1])) hash = base32ToHex(m[1]);
  }
  if (!hash) return null;
  return { infoHash: hash, trackers: params.getAll('tr').filter((t) => /^(udp|https?):\/\//i.test(t)) };
}
function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

module.exports = {
  VIDEO_EXT, SUB_EXT, isVideoName, isSubName, extOf, norm, titleKey,
  parseRelease, parseEpisode, tvMatch, animeEpisode, animeBatch, titleMatch,
  chooseFile, scoreStream, rankStreams, qualityLabel, tagList, parseMagnet,
};
