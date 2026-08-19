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

// dotenv is optional (only useful for local dev). Ignore if missing.
try {
  require('dotenv').config();
} catch (_) {
  /* no-op */
}

const app = express();
app.disable('x-powered-by');

// --- Configuration ---------------------------------------------------------
// Pterodactyl injects SERVER_PORT. Fall back to PORT, then 3000 for local dev.
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
const TMDB_BASE = 'https://api.themoviedb.org/3';
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
    tv: 'https://vidfast.vc/tv/{id}/{season}/{episode}?autoPlay=true',
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
  },
  {
    id: 'videasy',
    name: 'VidEasy',
    movie: 'https://player.videasy.net/movie/{id}',
    tv: 'https://player.videasy.net/tv/{id}/{season}/{episode}',
  },
];

// Which source is selected by default (must be one of the SOURCES ids).
const DEFAULT_SOURCE = SOURCES.some((s) => s.id === process.env.DEFAULT_SOURCE)
  ? process.env.DEFAULT_SOURCE
  : SOURCES[0].id;

if (!TMDB_API_KEY) {
  console.warn('[WARN] TMDB_API_KEY is not set — search will not work until you configure it.');
}

// --- TMDB helper -----------------------------------------------------------
// Supports both a v3 API key (query param) and a v4 read access token (Bearer).
async function tmdb(endpoint, params = {}) {
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

  const res = await fetch(url, { headers });
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

// --- Static frontend -------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// --- API -------------------------------------------------------------------

// Small config payload the frontend needs (never exposes the API key itself).
app.get('/api/config', (_req, res) => {
  res.json({
    sources: SOURCES,
    defaultSource: DEFAULT_SOURCE,
    hasApiKey: Boolean(TMDB_API_KEY),
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

// Multi search (movies + TV shows), paginated.
app.get('/api/search', async (req, res) => {
  if (!requireApiKey(res)) return;

  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [], page: 1, totalPages: 0 });
  const page = clampPage(req.query.page);

  try {
    const data = await tmdb('/search/multi', { query: q, include_adult: 'false', page: String(page) });
    const results = (data.results || [])
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .map(mapMedia);

    res.json({ results, page: data.page || page, totalPages: Math.min(data.total_pages || page, 500) });
  } catch (err) {
    console.error('search error:', err.message);
    res.status(err.status || 500).json({ error: 'Search failed.', detail: err.message });
  }
});

// Trending this week (front page), paginated for infinite scroll.
app.get('/api/trending', async (req, res) => {
  if (!requireApiKey(res)) return;

  const page = clampPage(req.query.page);

  try {
    const data = await tmdb('/trending/all/week', { page: String(page) });
    const results = (data.results || [])
      .filter((r) => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path)
      .map(mapMedia);

    res.json({ results, page: data.page || page, totalPages: Math.min(data.total_pages || page, 500) });
  } catch (err) {
    console.error('trending error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load trending.', detail: err.message });
  }
});

// TV show details -> list of seasons.
app.get('/api/tv/:id', async (req, res) => {
  if (!requireApiKey(res)) return;

  try {
    const data = await tmdb(`/tv/${encodeURIComponent(req.params.id)}`);
    const seasons = (data.seasons || [])
      .filter((s) => typeof s.season_number === 'number')
      .map((s) => ({
        seasonNumber: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episodeCount: s.episode_count || 0,
      }));

    res.json({ id: data.id, title: data.name, seasons });
  } catch (err) {
    console.error('tv error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load show.', detail: err.message });
  }
});

// Episodes for a given season.
app.get('/api/tv/:id/season/:season', async (req, res) => {
  if (!requireApiKey(res)) return;

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

    res.json({ episodes });
  } catch (err) {
    console.error('season error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to load season.', detail: err.message });
  }
});

// Health check (handy for uptime monitors).
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- Start -----------------------------------------------------------------
app.listen(PORT, HOST, () => {
  console.log(`Movie site listening on http://${HOST}:${PORT}`);
  console.log(`Embed player base: ${PLAYER_BASE_URL}`);
});
