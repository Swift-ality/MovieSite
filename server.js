/**
 * Movie & TV Stream Search Site
 * -------------------------------------------------------------
 * - Serves a small web UI (public/) with a search bar.
 * - Proxies TheMovieDB (TMDB) so the API key stays server-side.
 * - The browser builds embed URLs like:
 *     https://111movies.net/movie/{id}
 *     https://111movies.net/tv/{id}/{season}/{episode}
 *
 * Configuration is done through environment variables (see .env.example).
 */

'use strict';

const path = require('path');
const express = require('express');

// dotenv is optional (local dev, or a .env next to server.js). Ignore if missing.
// Real environment/panel variables win, but a .env value also fills in any
// variable the panel passes as an empty string.
try {
  const parsed = require('dotenv').config().parsed || {};
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === '' && v !== '') process.env[k] = v;
  }
} catch (_) {
  /* no-op */
}
const { setupTorrents } = require('./lib/torrent');

const app = express();
app.disable('x-powered-by');

// --- Configuration ---------------------------------------------------------
// Pterodactyl injects SERVER_PORT. Fall back to PORT, then 3000 for local dev.
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
const TMDB_BASE = (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// Base URL for the 111Movies source (its domain changes now and then, so it
// stays overridable through PLAYER_BASE_URL). Strip any trailing slash.
const PLAYER_BASE_URL = (process.env.PLAYER_BASE_URL || 'https://111movies.net').replace(/\/+$/, '');

// Embed sources the viewer can switch between. Each has URL templates with
// {id}, {season} and {episode} placeholders the frontend fills in.
const SOURCES = [
  {
    id: '111movies',
    name: '111Movies',
    movie: `${PLAYER_BASE_URL}/movie/{id}`,
    tv: `${PLAYER_BASE_URL}/tv/{id}/{season}/{episode}`,
  },
  {
    id: 'vidfast',
    name: 'VidFast',
    movie: 'https://vidfast.vc/movie/{id}?autoPlay=true',
    tv: 'https://vidfast.vc/tv/{id}/{season}/{episode}?autoPlay=true&nextButton=true&autoNext=true',
    startParam: 'startAt', // documented: start time in seconds
  },
  {
    id: 'vidsrc',
    name: 'VidSrc',
    movie: 'https://vidsrc.sbs/embed/movie/{id}',
    tv: 'https://vidsrc.sbs/embed/tv/{id}/{season}/{episode}',
  },
  {
    id: 'cinesrc',
    name: 'CineSrc',
    movie: 'https://cinesrc.st/embed/movie/{id}',
    tv: 'https://cinesrc.st/embed/tv/{id}?s={season}&e={episode}',
    startParam: 't', // documented: start time in seconds (shows Continue/Restart prompt)
  },
  {
    id: 'videasy',
    name: 'VidEasy',
    movie: 'https://player.videasy.net/movie/{id}',
    tv: 'https://player.videasy.net/tv/{id}/{season}/{episode}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true',
    startParam: 'progress', // documented: start time in seconds
  },
];

// Which source is selected by default (must be one of the SOURCES ids).
const DEFAULT_SOURCE = SOURCES.some((s) => s.id === process.env.DEFAULT_SOURCE)
  ? process.env.DEFAULT_SOURCE
  : SOURCES[0].id;

// Anime sources the viewer can switch between. All take AniList IDs (which is
// what the AniList browse/search below returns). {id} = AniList id, {episode} =
// episode number (anime films use episode 1).
const ANIME_SOURCES = [
  {
    id: 'vidplus',
    name: 'VidPlus',
    movie: 'https://player.vidplus.to/embed/anime/{id}/1',
    show: 'https://player.vidplus.to/embed/anime/{id}/{episode}',
  },
  {
    id: 'videasy',
    name: 'VidEasy',
    movie: 'https://player.videasy.net/anime/{id}',
    show: 'https://player.videasy.net/anime/{id}/{episode}',
  },
  {
    id: 'megaplay',
    name: 'MegaPlay',
    movie: 'https://megaplay.buzz/stream/ani/{id}/1/sub',
    show: 'https://megaplay.buzz/stream/ani/{id}/{episode}/sub',
  },
];
const DEFAULT_ANIME_SOURCE = ANIME_SOURCES.some((s) => s.id === process.env.DEFAULT_ANIME_SOURCE)
  ? process.env.DEFAULT_ANIME_SOURCE
  : ANIME_SOURCES[0].id;

// Genres shown in the Anime sidebar (AniList genre names).
const ANIME_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror',
  'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance',
  'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
];

if (!TMDB_API_KEY) {
  console.warn('[WARN] TMDB_API_KEY is not set — search will not work until you configure it.');
}

// --- TMDB helper -----------------------------------------------------------
// Supports both a v3 API key (query param) and a v4 read access token (Bearer).
// `signal` (optional) aborts the upstream call when the browser gives up.
async function tmdb(endpoint, params = {}, signal) {
  const url = new URL(TMDB_BASE + endpoint);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const headers = { accept: 'application/json' };
  if (TMDB_API_KEY.includes('.')) {
    // v4 read access tokens are JWTs (contain dots).
    headers.Authorization = `Bearer ${TMDB_API_KEY}`;
  } else {
    url.searchParams.set('api_key', TMDB_API_KEY);
  }

  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`TMDB request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

function requireApiKey(res) {
  if (!TMDB_API_KEY) {
    res.status(503).json({ error: 'Server is missing TMDB_API_KEY. Set it in the panel and restart.' });
    return false;
  }
  return true;
}

// An AbortSignal that fires if the browser drops this request before we answer
// (e.g. the frontend cancelled a stale search because the user kept typing).
// Uses res 'close' + writableFinished; req 'close' fires too early on modern Node.
function clientAbortSignal(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
}

// --- Static frontend -------------------------------------------------------
// The page references its scripts/styles as /app.js?v=<content hash>. Proxies
// like Cloudflare tell browsers to cache .js/.css for hours (Browser Cache TTL),
// so without a changing URL visitors keep running old code after an update.
const PUBLIC_DIR = path.join(__dirname, 'public');
const indexHtml = (() => {
  const fs = require('fs');
  const crypto = require('crypto');
  return fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace(/(src|href)="\/([\w.-]+\.(?:js|css))"/g, (m, attr, file) => {
      try {
        const v = crypto.createHash('md5').update(fs.readFileSync(path.join(PUBLIC_DIR, file))).digest('hex').slice(0, 10);
        return `${attr}="/${file}?v=${v}"`;
      } catch (_) {
        return m;
      }
    });
})();
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(indexHtml);
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// --- API -------------------------------------------------------------------

// Torrent streaming (lib/torrent) — set up further down, before listen().
let torrents = { enabled: false };

// Small config payload the frontend needs (never exposes the API key itself).
app.get('/api/config', (_req, res) => {
  const sources = torrents.enabled ? SOURCES.concat(torrents.source) : SOURCES;
  const animeSources = torrents.enabled ? ANIME_SOURCES.concat(torrents.source) : ANIME_SOURCES;
  const pick = (list, wanted, fallback) => (list.some((s) => s.id === wanted) ? wanted : fallback);
  // Swift Servers are the default whenever they're enabled (SWIFT_DEFAULT=0 opts out).
  const swiftFirst = torrents.enabled && String(process.env.SWIFT_DEFAULT ?? '1').trim() !== '0';
  res.json({
    sources,
    defaultSource: swiftFirst ? 'swift' : pick(sources, process.env.DEFAULT_SOURCE, DEFAULT_SOURCE),
    animeSources,
    defaultAnimeSource: swiftFirst ? 'swift' : pick(animeSources, process.env.DEFAULT_ANIME_SOURCE, DEFAULT_ANIME_SOURCE),
    hasApiKey: Boolean(TMDB_API_KEY),
    torrent: torrents.enabled ? torrents.info : null,
  });
});

// Clamp an incoming page query param to a sane range (TMDB caps at 500).
function clampPage(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 500);
}

// Shape a raw TMDB movie/tv record into the compact form the frontend uses.
function mapMedia(r) {
  return {
    id: r.id,
    mediaType: r.media_type,
    title: r.title || r.name || 'Untitled',
    year: String(r.release_date || r.first_air_date || '').slice(0, 4),
    poster: r.poster_path ? `${IMAGE_BASE}/w342${r.poster_path}` : null,
    overview: r.overview || '',
    rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
  };
}

// --- AniList (anime) -------------------------------------------------------
const ANILIST_URL = 'https://graphql.anilist.co';

async function anilist(query, variables, signal) {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const err = new Error(json.errors ? json.errors[0].message : `AniList error ${res.status}`);
    err.status = res.status === 200 ? 502 : res.status;
    throw err;
  }
  return json.data;
}

// Shape an AniList media record for the frontend.
function mapAnime(m) {
  const title = (m.title && (m.title.english || m.title.romaji)) || 'Untitled';
  return {
    id: m.id,
    mediaType: 'anime',
    title,
    year: m.seasonYear ? String(m.seasonYear) : '',
    poster: (m.coverImage && (m.coverImage.large || m.coverImage.medium)) || null,
    rating: typeof m.averageScore === 'number' ? Math.round(m.averageScore) / 10 : null,
    format: m.format || 'TV',              // MOVIE, TV, OVA, ONA, SPECIAL, MUSIC
    episodes: m.episodes || null,
  };
}

const ANIME_PAGE_QUERY = `
query ($page: Int, $genre: String, $search: String, $sort: [MediaSort], $season: MediaSeason,
       $seasonYear: Int, $status: MediaStatus, $format: MediaFormat) {
  Page(page: $page, perPage: 24) {
    pageInfo { currentPage lastPage hasNextPage }
    media(type: ANIME, genre: $genre, search: $search, sort: $sort, season: $season,
          seasonYear: $seasonYear, status: $status, format: $format, isAdult: false) {
      id
      title { english romaji }
      coverImage { large medium }
      seasonYear
      format
      episodes
      averageScore
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run one AniList page query and normalize it.
async function animePage(vars, signal) {
  const data = await anilist(ANIME_PAGE_QUERY, vars, signal);
  const p = (data && data.Page) || {};
  return {
    results: (p.media || []).filter((m) => m.coverImage).map(mapAnime),
    page: (p.pageInfo && p.pageInfo.currentPage) || vars.page,
    totalPages: (p.pageInfo && p.pageInfo.lastPage) || vars.page,
  };
}

// --- tiny in-memory response cache -----------------------------------------
// Cuts repeat upstream calls (e.g. "trending page 1") and keeps us well under
// AniList's rate limit, which otherwise returns empty pages under load.
const _cache = new Map(); // key -> { exp, data }
function cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  if (hit) _cache.delete(key);
  return null;
}
function cacheSet(key, data, ttlMs) {
  _cache.set(key, { exp: Date.now() + ttlMs, data });
  if (_cache.size > 600) _cache.delete(_cache.keys().next().value);
}

// Multi search (movies + TV shows), paginated.
app.get('/api/search', async (req, res) => {
  if (!requireApiKey(res)) return;

  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], page: 1, totalPages: 0 });
  const page = clampPage(req.query.page);
  const key = `search:${q.toLowerCase()}:${page}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  const signal = clientAbortSignal(res);
  try {
    const data = await tmdb('/search/multi', { query: q, include_adult: 'false', page: String(page) }, signal);
    const results = (data.results || [])
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .map(mapMedia);

    const payload = { results, page: data.page || page, totalPages: Math.min(data.total_pages || page, 500) };
    cacheSet(key, payload, 5 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    if (signal.aborted) return;             // browser cancelled this (stale) search
    console.error('search error:', err.message);
    res.status(err.status || 500).json({ error: 'Search failed.', detail: err.message });
  }
});

// Look a title up by IMDB id (tt1234567) — search accepts IMDB ids and links.
app.get('/api/find', async (req, res) => {
  if (!requireApiKey(res)) return;
  const m = /\b(tt\d{5,10})\b/i.exec(String(req.query.imdb || ''));
  if (!m) return res.status(400).json({ error: 'Not an IMDB id (expected tt1234567).' });
  const id = m[1].toLowerCase();
  const key = `find:${id}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);
  try {
    const data = await tmdb(`/find/${id}`, { external_source: 'imdb_id' }, clientAbortSignal(res));
    const results = [
      ...(data.movie_results || []).map((r) => mapMedia({ ...r, media_type: 'movie' })),
      ...(data.tv_results || []).map((r) => mapMedia({ ...r, media_type: 'tv' })),
    ];
    const payload = { results, page: 1, totalPages: 1, imdb: id };
    cacheSet(key, payload, 60 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    console.error('find error:', err.message);
    res.status(err.status || 500).json({ error: 'IMDB lookup failed.', detail: err.message });
  }
});

// Trending this week (front page), paginated for infinite scroll.
app.get('/api/trending', async (req, res) => {
  if (!requireApiKey(res)) return;

  const page = clampPage(req.query.page);
  const key = `trending:${page}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const data = await tmdb('/trending/all/week', { page: String(page) });
    const results = (data.results || [])
      .filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path)
      .map(mapMedia);

    const payload = { results, page: data.page || page, totalPages: Math.min(data.total_pages || page, 500) };
    cacheSet(key, payload, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('trending error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load trending.', detail: err.message });
  }
});

// Browse lists for the sidebar — each pages through TMDB's full catalog.
const TMDB_LISTS = {
  popular: { path: '/movie/popular', type: 'movie' },
  top_rated: { path: '/movie/top_rated', type: 'movie' },
  now_playing: { path: '/movie/now_playing', type: 'movie' },
  upcoming: { path: '/movie/upcoming', type: 'movie' },
  tv_popular: { path: '/tv/popular', type: 'tv' },
  tv_top_rated: { path: '/tv/top_rated', type: 'tv' },
  tv_on_air: { path: '/tv/on_the_air', type: 'tv' },
};
app.get('/api/list/:list', async (req, res) => {
  if (!requireApiKey(res)) return;
  const list = TMDB_LISTS[req.params.list];
  if (!list) return res.status(404).json({ error: 'Unknown list.' });
  const page = clampPage(req.query.page);
  const key = `list:${req.params.list}:${page}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);
  try {
    const data = await tmdb(list.path, { page: String(page) });
    const results = (data.results || [])
      .filter((r) => r.poster_path)
      .map((r) => mapMedia({ ...r, media_type: list.type }));
    const payload = { results, page: data.page || page, totalPages: Math.min(data.total_pages || page, 500) };
    cacheSet(key, payload, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('list error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load list.', detail: err.message });
  }
});

// Movie genre list for the sidebar.
app.get('/api/genres/movie', async (_req, res) => {
  if (!requireApiKey(res)) return;
  const hit = cacheGet('genres:movie');
  if (hit) return res.json(hit);
  try {
    const data = await tmdb('/genre/movie/list');
    const payload = { genres: (data.genres || []).map((g) => ({ id: g.id, name: g.name })) };
    cacheSet('genres:movie', payload, 6 * 60 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('genres error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load genres.', detail: err.message });
  }
});

// Discover movies by genre, paginated.
app.get('/api/discover', async (req, res) => {
  if (!requireApiKey(res)) return;
  const page = clampPage(req.query.page);
  const genre = String(req.query.genre || '').replace(/[^0-9,]/g, '');
  const key = `discover:${genre}:${page}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);
  try {
    const data = await tmdb('/discover/movie', {
      with_genres: genre,
      sort_by: 'popularity.desc',
      include_adult: 'false',
      'vote_count.gte': '50',
      page: String(page),
    });
    const results = (data.results || [])
      .filter((r) => r.poster_path)
      .map((r) => mapMedia({ ...r, media_type: 'movie' }));
    const payload = { results, page: data.page || page, totalPages: Math.min(data.total_pages || page, 500) };
    cacheSet(key, payload, 10 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('discover error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load genre.', detail: err.message });
  }
});

// Anime genre list for the sidebar.
app.get('/api/anime/genres', (_req, res) => {
  res.json({ genres: ANIME_GENRES.map((name) => ({ id: name, name })) });
});

// Anime browse lists (sidebar): sort / season / format presets for AniList.
function currentAnimeSeason() {
  const d = new Date();
  const m = d.getUTCMonth();
  return { season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'][Math.floor(m / 3)], seasonYear: d.getUTCFullYear() };
}
const ANIME_LISTS = {
  popular: () => ({ sort: ['POPULARITY_DESC'] }),
  top_rated: () => ({ sort: ['SCORE_DESC', 'POPULARITY_DESC'] }),
  season: () => ({ sort: ['POPULARITY_DESC'], ...currentAnimeSeason() }),
  upcoming: () => ({ sort: ['POPULARITY_DESC'], status: 'NOT_YET_RELEASED' }),
  movies: () => ({ sort: ['POPULARITY_DESC'], format: 'MOVIE' }),
};

// Browse anime (trending by default, a list preset, or a genre), paginated.
app.get('/api/anime/browse', async (req, res) => {
  const page = clampPage(req.query.page);
  const genre = String(req.query.genre || '').trim();
  const listId = ANIME_LISTS[req.query.list] ? String(req.query.list) : '';
  const key = `anime:browse:${genre}:${listId}:${page}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  const sort = genre ? ['POPULARITY_DESC'] : ['TRENDING_DESC', 'POPULARITY_DESC'];
  const vars = { page, sort, genre: genre || undefined, ...(listId ? ANIME_LISTS[listId]() : {}) };
  try {
    let payload = await animePage(vars);
    if (!payload.results.length) {          // AniList sometimes flakes -> retry once
      await sleep(600);
      payload = await animePage(vars);
    }
    if (payload.results.length) cacheSet(key, payload, 5 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('anime browse error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load anime.', detail: err.message });
  }
});

// Search anime by title, paginated.
app.get('/api/anime/search', async (req, res) => {
  const page = clampPage(req.query.page);
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], page: 1, totalPages: 0 });
  const key = `anime:search:${q.toLowerCase()}:${page}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  const signal = clientAbortSignal(res);
  try {
    const payload = await animePage({ page, search: q, sort: ['SEARCH_MATCH'] }, signal);
    if (payload.results.length) cacheSet(key, payload, 5 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    if (signal.aborted) return;             // browser cancelled this (stale) search
    console.error('anime search error:', err.message);
    res.status(err.status || 500).json({ error: 'Anime search failed.', detail: err.message });
  }
});

// TV show details -> list of seasons.
app.get('/api/tv/:id', async (req, res) => {
  if (!requireApiKey(res)) return;
  const key = `tv:${req.params.id}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const data = await tmdb(`/tv/${encodeURIComponent(req.params.id)}`);
    const seasons = (data.seasons || [])
      .filter((s) => typeof s.season_number === 'number')
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episodeCount: s.episode_count || 0,
      }));

    const payload = { id: data.id, title: data.name, seasons };
    cacheSet(key, payload, 30 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('tv error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load show.', detail: err.message });
  }
});

// Episodes for a given season.
app.get('/api/tv/:id/season/:season', async (req, res) => {
  if (!requireApiKey(res)) return;
  const key = `tv:${req.params.id}:s:${req.params.season}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);

  try {
    const data = await tmdb(
      `/tv/${encodeURIComponent(req.params.id)}/season/${encodeURIComponent(req.params.season)}`
    );
    const episodes = (data.episodes || []).map((e) => ({
      episodeNumber: e.episode_number,
      name: e.name || `Episode ${e.episode_number}`,
      overview: e.overview || '',
      still: e.still_path ? `${IMAGE_BASE}/w300${e.still_path}` : null,
    }));

    const payload = { episodes };
    cacheSet(key, payload, 30 * 60 * 1000);
    res.json(payload);
  } catch (err) {
    console.error('season error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load season.', detail: err.message });
  }
});

// Torrent streaming: finds torrents for a title (Stremio addons / Torznab),
// downloads the chosen one here and streams it while it downloads.
try {
  torrents = setupTorrents(app, {
    appDir: __dirname,
    port: PORT,
    tmdb,
    anilist,
    cacheGet,
    cacheSet,
    clientAbortSignal,
    hasTmdb: Boolean(TMDB_API_KEY),
  });
} catch (err) {
  console.error('[torrent] disabled, setup failed:', err.message);
  torrents = { enabled: false };
}

// Health check (handy for uptime monitors).
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- Start -----------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log(`Movie site listening on http://${HOST}:${PORT}`);
  console.log(`Embed player base: ${PLAYER_BASE_URL}`);
});
