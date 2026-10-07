/* SwiftWatchesMovies frontend */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const searchInput = $('#search');
  const suggestionsEl = $('#suggestions');
  const resultsEl = $('#results');
  const statusEl = $('#status');
  const sectionTitle = $('#section-title');
  const crossHint = $('#cross-hint');
  const feedEnd = $('#feed-end');
  const modeTabs = $('#mode-tabs');
  const genreList = $('#genre-list');
  const continueEl = $('#continue');
  const continueRow = $('#continue-row');
  const continueClear = $('#continue-clear');

  const modal = $('#player-modal');
  const modalTitle = $('#modal-title');
  const playerFrame = $('#player-frame');
  const tvControls = $('#tv-controls');
  const seasonWrap = $('#season-wrap');
  const episodeWrap = $('#episode-wrap');
  const seasonSelect = $('#season-select');
  const episodeSelect = $('#episode-select');
  const playEpisodeBtn = $('#play-episode');
  const sourcePicker = $('#source-picker');
  const sourceSelect = $('#source-select');
  const fullscreenBtn = $('#fullscreen-btn');
  const closeBtn = $('#close-modal');
  const iframe = $('#player');
  const playerLoading = $('#player-loading');
  const toastEl = $('#player-toast');

  // Torrent player for the "⚡ Torrent" server (public/torrent.js).
  let torrentInfo = null;    // from /api/config when the server has torrent sources
  const torrentPlayer = window.SwiftTorrent ? window.SwiftTorrent.create(playerFrame, {
    toast: (msg) => toast(msg),
    onProgress: (position, duration) => {
      if (currentMedia && currentItem) applyProgress({ position, duration });
    },
    onEnded: () => onTorrentEnded(),
    toggleFullscreen: () => fullscreenBtn.click(),
    canTranscode: () => Boolean(torrentInfo && torrentInfo.transcode),
  }) : null;

  // Streaming sources per content group, from /api/config.
  const SRC = {
    movies: { list: [], byId: {}, current: null },
    anime: { list: [], byId: {}, current: null },
  };

  // What's open in the player.
  let currentItem = null;    // the card / search item that was opened
  let currentMedia = null;   // { id, kind, season, episode }  kind: movie | tv | anime-movie | anime-show
  let currentTvId = null;
  let currentSeasons = [];   // TMDB season list of the open show
  let pendingResume = null;  // { type: 'continue' | 'next' | 'restart' } shown by the next playCurrent()
  let openToken = 0;         // bumped on open/close; stale async season/episode loads are dropped

  // Feed state.
  let contentType = 'movies';   // 'movies' | 'anime'
  let feedKind = 'default';     // 'default' | 'genre' | 'search'
  let browseKind = 'default';   // remembered browse state to restore when search clears
  let browseGenre = null;       // { id, name }
  let browseList = null;        // { id, name } — Popular, Top Rated, …
  let query = '';
  let page = 0;
  let totalPages = 1;
  let loading = false;
  let done = false;
  let feedToken = 0;         // bumped on every resetFeed; stale loads are ignored
  const seen = new Set();
  const genresCache = { movies: null, anime: null };

  // Parallel search state.
  let psearch = null;        // { q, ctrl, promises: {movies, anime}, results: {movies, anime} }
  let dropdownOpen = false;
  let dropdownItems = [];    // items in the dropdown, in display order
  let activeSuggestion = -1;

  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513">
         <rect width="100%" height="100%" fill="#1e2432"/>
         <text x="50%" y="50%" font-size="64" text-anchor="middle" dominant-baseline="middle" fill="#3a4356">🎬</text>
       </svg>`
    );

  // --- helpers -------------------------------------------------------------
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function setStatus(html, warn = false) {
    statusEl.innerHTML = html;
    statusEl.classList.toggle('warn', warn);
  }
  function showFeedEnd(state) {
    if (state === 'loading') { feedEnd.textContent = 'Loading more…'; feedEnd.classList.remove('hidden'); }
    else if (state === 'end') { feedEnd.textContent = "You've reached the end."; feedEnd.classList.remove('hidden'); }
    else { feedEnd.classList.add('hidden'); }
  }
  async function getJson(url, signal) {
    const res = await fetch(url, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function buildUrl(tpl, vars) {
    return tpl.replace(/\{(id|season|episode)\}/g, (_, k) =>
      (vars[k] != null ? encodeURIComponent(vars[k]) : ''));
  }
  function withParam(url, name, value) {
    return url + (url.includes('?') ? '&' : '?') + encodeURIComponent(name) + '=' + encodeURIComponent(value);
  }
  function typeLabel(mt) {
    if (mt === 'tv') return 'TV';
    if (mt === 'anime') return 'Anime';
    return 'Movie';
  }
  const keyOf = (it) => `${it.mediaType}:${it.id}`;
  const groupOf = (kind) => (String(kind || '').startsWith('anime') ? 'anime' : 'movies');
  const groupOfType = (mediaType) => (mediaType === 'anime' ? 'anime' : 'movies');
  function fmtTime(sec) {
    const t = Math.max(0, Math.floor(sec));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function safePoster(p) {
    return typeof p === 'string' && /^https:\/\//.test(p) ? p : null;
  }
  // "tt0111161" or an IMDB link -> "tt0111161"
  function imdbIdOf(q) {
    const m = /(?:^|imdb\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/|\s)(tt\d{5,10})(?:\b|$)/i.exec(String(q || '').trim());
    return m ? m[1].toLowerCase() : null;
  }

  // --- watch history ("Continue Watching") ---------------------------------
  // Stored per browser in localStorage. One entry per title, most recent first.
  const HISTORY_KEY = 'sw_history_v1';
  const HISTORY_MAX = 60;
  let history = loadHistory();
  let saveTimer = null;

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(raw)
        ? raw.filter((e) => e && typeof e.key === 'string' && typeof e.title === 'string' &&
            ['movie', 'tv', 'anime'].includes(e.mediaType))
        : [];
    } catch (_) {
      return [];
    }
  }
  function saveHistoryNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_MAX))); } catch (_) { /* ignore */ }
  }
  function saveHistorySoon() {
    if (!saveTimer) saveTimer = setTimeout(saveHistoryNow, 2000);
  }
  const getEntry = (key) => history.find((e) => e.key === key) || null;
  window.addEventListener('pagehide', saveHistoryNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveHistoryNow();
  });
  window.addEventListener('storage', (ev) => {       // another tab updated it
    if (ev.key !== HISTORY_KEY) return;
    history = loadHistory();
    if (modal.classList.contains('hidden')) renderContinue();
  });

  // Save/refresh the entry for whatever is playing right now.
  function recordWatch() {
    if (!currentItem || !currentMedia) return;
    const key = keyOf(currentItem);
    const prev = getEntry(key);
    const { kind, season, episode } = currentMedia;
    const sameEp = Boolean(prev) && prev.season === season && prev.episode === episode;
    const keep = sameEp && !prev.completed;       // replaying a finished episode starts fresh
    const entry = {
      key,
      id: currentItem.id,
      mediaType: currentItem.mediaType,
      kind,
      title: String(currentItem.title || 'Untitled'),
      year: currentItem.year ? String(currentItem.year) : '',
      poster: safePoster(currentItem.poster),
      format: currentItem.format || null,
      episodes: currentItem.episodes || (prev && prev.episodes) || null,
      season,
      episode,
      seasonEpisodes: null,
      nextSeason: null,
      sourceId: SRC[groupOf(kind)].current,
      position: keep ? prev.position : 0,
      duration: keep ? prev.duration : 0,
      completed: false,
      // once a title has earned a spot in the row, later episodes keep it there
      engaged: Boolean(prev && (prev.engaged || prev.completed || prev.position > 30)),
      updatedAt: Date.now(),
    };
    if (kind === 'tv') {
      const cur = currentSeasons.find((s) => s.seasonNumber === season);
      const next = currentSeasons.find((s) => s.seasonNumber > season && s.seasonNumber >= 1);
      entry.seasonEpisodes = cur ? cur.episodeCount : null;
      entry.nextSeason = next ? next.seasonNumber : null;
    }
    history = [entry].concat(history.filter((e) => e.key !== key)).slice(0, HISTORY_MAX);
    saveHistorySoon();
  }

  // Titles only land in the row once you've actually watched a bit (60s open,
  // or the player reported 30s+ of progress) — not on every accidental click.
  let engageTimer = null;
  function armEngagement() {
    clearTimeout(engageTimer);
    const key = currentItem && keyOf(currentItem);
    engageTimer = setTimeout(() => {
      const e = key && getEntry(key);
      if (e && !e.engaged) { e.engaged = true; saveHistorySoon(); }
    }, 60 * 1000);
  }

  // For a finished episode, what comes next? -> { season, episode } | null
  function nextUp(e) {
    if (!e.completed) return null;
    if (e.mediaType === 'tv') {
      if (e.seasonEpisodes && e.episode < e.seasonEpisodes) return { season: e.season, episode: e.episode + 1 };
      if (e.nextSeason) return { season: e.nextSeason, episode: 1 };
      return null;
    }
    if (e.kind === 'anime-show' && (!e.episodes || e.episode < e.episodes)) {
      return { season: null, episode: e.episode + 1 };
    }
    return null;
  }
  function inRow(e) {
    if (e.completed && !nextUp(e)) return false;   // finished movie, or finished the whole series
    return e.engaged || e.position > 30 || e.completed;
  }
  function cwLabel(e) {
    const nu = nextUp(e);
    if (nu) {
      return { next: true, text: e.mediaType === 'tv' ? `Next: S${nu.season} · E${nu.episode}` : `Next: Episode ${nu.episode}` };
    }
    const left = e.duration > 0 && e.position > 0 ? e.duration - e.position : 0;
    const leftTxt = left >= 60 ? `${Math.round(left / 60)} min left` : '';
    if (e.mediaType === 'tv') return { text: [`S${e.season} · E${e.episode}`, leftTxt].filter(Boolean).join(' · ') };
    if (e.kind === 'anime-show') return { text: [`Episode ${e.episode}`, leftTxt].filter(Boolean).join(' · ') };
    return { text: leftTxt || 'Resume' };
  }
  function cwCard(e) {
    const pct = !nextUp(e) && e.duration > 0 ? Math.min(100, Math.round((e.position / e.duration) * 100)) : 0;
    const lbl = cwLabel(e);
    const t = escapeHtml(e.title);
    return `
      <article class="cw-card" tabindex="0" role="button" data-key="${escapeHtml(e.key)}" aria-label="Continue ${t}">
        <div class="cw-poster">
          <img loading="lazy" src="${escapeHtml(e.poster || PLACEHOLDER)}" alt="" onerror="this.src='${PLACEHOLDER}'">
          <button class="cw-remove" type="button" data-remove="${escapeHtml(e.key)}" title="Remove"
                  aria-label="Remove ${t} from Continue Watching">✕</button>
          ${pct > 0 ? `<div class="cw-progress"><span style="width:${pct}%"></span></div>` : ''}
        </div>
        <div class="cw-meta">
          <div class="cw-title">${t}</div>
          <div class="cw-sub${lbl.next ? ' next' : ''}">${escapeHtml(lbl.text)}</div>
        </div>
      </article>`;
  }
  // The row shows on the home (Trending) view of the current section.
  function renderContinue() {
    const items = feedKind === 'default'
      ? history.filter((e) => groupOfType(e.mediaType) === contentType && inRow(e)).slice(0, 20)
      : [];
    continueEl.classList.toggle('hidden', !items.length);
    continueRow.innerHTML = items.map(cwCard).join('');
  }
  function resumeEntry(key) {
    const e = getEntry(key);
    if (!e) return;
    const grp = groupOfType(e.mediaType);
    if (e.sourceId && SRC[grp].byId[e.sourceId]) SRC[grp].current = e.sourceId;   // the server you used
    openItem({
      id: e.id, mediaType: e.mediaType, title: e.title, year: e.year,
      poster: e.poster, format: e.format, episodes: e.episodes,
    });
  }
  function removeEntry(key) {
    history = history.filter((e) => e.key !== key);
    saveHistoryNow();
    renderContinue();
  }
  continueRow.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-remove]');
    if (rm) { ev.stopPropagation(); removeEntry(rm.dataset.remove); return; }
    const card = ev.target.closest('.cw-card');
    if (card) resumeEntry(card.dataset.key);
  });
  continueRow.addEventListener('keydown', (ev) => {
    const card = ev.target.closest('.cw-card');
    if (!card || ev.target !== card) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); resumeEntry(card.dataset.key); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeEntry(card.dataset.key); }
  });
  continueClear.addEventListener('click', () => {
    const what = contentType === 'anime' ? 'anime' : 'movies & TV';
    if (!window.confirm(`Clear your Continue Watching list for ${what}?`)) return;
    history = history.filter((e) => groupOfType(e.mediaType) !== contentType);
    saveHistoryNow();
    renderContinue();
  });

  // --- config + init -------------------------------------------------------
  async function init() {
    try {
      const cfg = await getJson('/api/config');
      SRC.movies.list = cfg.sources || [];
      SRC.movies.list.forEach((s) => { SRC.movies.byId[s.id] = s; });
      SRC.anime.list = cfg.animeSources || [];
      SRC.anime.list.forEach((s) => { SRC.anime.byId[s.id] = s; });
      torrentInfo = cfg.torrent || null;
      if (!torrentPlayer) {          // player script missing: hide the torrent server
        for (const g of ['movies', 'anime']) {
          SRC[g].list = SRC[g].list.filter((s) => !s.torrent);
          delete SRC[g].byId.torrent;
        }
      }

      let savedMovieSrc = null, savedAnimeSrc = null, savedMode = null;
      try {
        savedMovieSrc = localStorage.getItem('ss_source');
        savedAnimeSrc = localStorage.getItem('ss_anime_source');
        savedMode = localStorage.getItem('ss_mode');
      } catch (_) { /* ignore */ }
      // When the site's default server changes, everyone moves to it once
      // (a server picked afterwards is remembered again as usual).
      try {
        const seen = localStorage.getItem('ss_default_seen');
        const now = `${cfg.defaultSource}|${cfg.defaultAnimeSource}`;
        if (seen !== now) {
          localStorage.setItem('ss_default_seen', now);
          if (seen !== null || savedMovieSrc || savedAnimeSrc) { savedMovieSrc = null; savedAnimeSrc = null; }
        }
      } catch (_) { /* ignore */ }
      SRC.movies.current = (savedMovieSrc && SRC.movies.byId[savedMovieSrc]) ? savedMovieSrc
        : (SRC.movies.byId[cfg.defaultSource] ? cfg.defaultSource : (SRC.movies.list[0] && SRC.movies.list[0].id));
      SRC.anime.current = (savedAnimeSrc && SRC.anime.byId[savedAnimeSrc]) ? savedAnimeSrc
        : (SRC.anime.byId[cfg.defaultAnimeSource] ? cfg.defaultAnimeSource : (SRC.anime.list[0] && SRC.anime.list[0].id));

      if (!cfg.hasApiKey) {
        setStatus('⚠️ The server has no TMDB API key configured. Set <b>TMDB_API_KEY</b> and restart.', true);
        // anime still works (AniList needs no key), so continue into the chosen mode.
      }
      contentType = savedMode === 'anime' ? 'anime' : 'movies';
    } catch (_) { /* non-fatal */ }

    setMode(contentType);

    // Deep link: /?imdb=tt0111161 opens that title straight away.
    const deep = imdbIdOf(new URLSearchParams(location.search).get('imdb'));
    if (deep) {
      getJson('/api/find?imdb=' + deep).then((d) => {
        const item = d.results && d.results[0];
        if (item) openItem(item);
        else setStatus(`No movie or show found for IMDB id ${escapeHtml(deep)}.`, true);
      }).catch((err) => setStatus('❌ ' + escapeHtml(err.message), true));
    }
  }

  // Fill the Server dropdown with the sources for what's being played. Swift
  // Servers (our own player, torrents) get their own section above the embeds.
  function populateSourceSelect(grp) {
    const s = SRC[grp];
    if (!s.list.length) { sourcePicker.classList.add('hidden'); return; }
    sourcePicker.classList.remove('hidden');
    const opt = (x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`;
    const swift = s.list.filter((x) => x.torrent);
    const embeds = s.list.filter((x) => !x.torrent);
    sourceSelect.innerHTML = swift.length
      ? `<optgroup label="${escapeHtml(swift[0].group || 'Swift Servers')}">${swift.map(opt).join('')}</optgroup>` +
        `<optgroup label="Embed servers">${embeds.map(opt).join('')}</optgroup>`
      : embeds.map(opt).join('');
    sourceSelect.value = s.current;
  }

  // --- mode (Movies / Anime) ----------------------------------------------
  // opts.query carries a search across when switching sections.
  function setMode(mode, opts = {}) {
    contentType = mode;
    try { localStorage.setItem('ss_mode', mode); } catch (_) { /* ignore */ }
    [...modeTabs.querySelectorAll('.mode-tab')].forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
    searchInput.placeholder = mode === 'anime' ? 'Search anime, movies & TV…' : 'Search movies, TV & anime…';

    hideSuggestions();
    browseKind = 'default';
    browseGenre = null;
    browseList = null;
    const q = String(opts.query || '').trim();
    if (q) {
      searchInput.value = q;
      query = q;
      feedKind = 'search';
      startParallelSearch(q);             // reuses the search already made for this query
    } else {
      searchInput.value = '';
      query = '';
      feedKind = 'default';
      cancelParallelSearch();
    }

    loadGenres(mode);
    resetFeed();
  }

  modeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-tab');
    if (!btn || btn.dataset.mode === contentType) return;
    setMode(btn.dataset.mode, { query: feedKind === 'search' ? query : '' });
  });

  // --- genres sidebar ------------------------------------------------------
  async function loadGenres(mode) {
    if (genresCache[mode]) { renderGenres(genresCache[mode]); return; }
    genreList.innerHTML = '';
    try {
      const url = mode === 'anime' ? '/api/anime/genres' : '/api/genres/movie';
      const data = await getJson(url);
      genresCache[mode] = data.genres || [];
    } catch (_) {
      genresCache[mode] = [];
    }
    if (contentType === mode) renderGenres(genresCache[mode]);
  }

  // Browse lists above the genres; each pages through the whole TMDB / AniList catalog.
  const BROWSE_LISTS = {
    movies: [
      { id: 'popular', name: '⭐ Popular Movies' },
      { id: 'top_rated', name: '🏆 Top Rated Movies' },
      { id: 'now_playing', name: '🎟️ Now Playing' },
      { id: 'upcoming', name: '📅 Upcoming' },
      { id: 'tv_popular', name: '📺 Popular TV' },
      { id: 'tv_top_rated', name: '🏅 Top Rated TV' },
      { id: 'tv_on_air', name: '📡 On the Air' },
    ],
    anime: [
      { id: 'popular', name: '⭐ Popular' },
      { id: 'top_rated', name: '🏆 Top Rated' },
      { id: 'season', name: '🌱 This Season' },
      { id: 'upcoming', name: '📅 Upcoming' },
      { id: 'movies', name: '🎬 Anime Movies' },
    ],
  };

  function renderGenres(genres) {
    const trendingLabel = contentType === 'anime' ? '🔥 Trending Anime' : '🔥 Trending';
    const item = (attrs, label) => `<button class="genre-item" ${attrs}>${escapeHtml(label)}</button>`;
    const items = ['<div class="genre-head">Browse</div>', item('data-all="1"', trendingLabel)]
      .concat((BROWSE_LISTS[contentType] || []).map((l) =>
        item(`data-list="${escapeHtml(l.id)}" data-name="${escapeHtml(l.name)}"`, l.name)))
      .concat(genres.length ? ['<div class="genre-head">Genres</div>'] : [])
      .concat(genres.map((g) =>
        item(`data-id="${escapeHtml(String(g.id))}" data-name="${escapeHtml(g.name)}"`, g.name)));
    genreList.innerHTML = items.join('');
    highlightGenre();
  }

  genreList.addEventListener('click', (e) => {
    const btn = e.target.closest('.genre-item');
    if (!btn) return;
    searchInput.value = '';
    query = '';
    hideSuggestions();
    cancelParallelSearch();
    if (btn.dataset.all) {
      browseKind = 'default'; browseGenre = null; browseList = null; feedKind = 'default';
    } else if (btn.dataset.list) {
      browseKind = 'list';
      browseList = { id: btn.dataset.list, name: btn.dataset.name };
      browseGenre = null;
      feedKind = 'list';
    } else {
      browseKind = 'genre';
      browseGenre = { id: btn.dataset.id, name: btn.dataset.name };
      browseList = null;
      feedKind = 'genre';
    }
    highlightGenre();
    resetFeed();
  });

  function highlightGenre() {
    [...genreList.querySelectorAll('.genre-item')].forEach((b) => {
      const isActive = (feedKind === 'default' && b.dataset.all) ||
                       (feedKind === 'list' && browseList && b.dataset.list === browseList.id) ||
                       (feedKind === 'genre' && browseGenre && b.dataset.id === String(browseGenre.id));
      b.classList.toggle('active', Boolean(isActive));
    });
  }

  // --- feed / infinite scroll ---------------------------------------------
  function feedUrl(next) {
    if (feedKind === 'search' && imdbIdOf(query)) {
      return contentType === 'anime' ? null : '/api/find?imdb=' + imdbIdOf(query);
    }
    if (contentType === 'anime') {
      if (feedKind === 'search') return '/api/anime/search?q=' + encodeURIComponent(query) + '&page=' + next;
      if (feedKind === 'genre') return '/api/anime/browse?genre=' + encodeURIComponent(browseGenre.name) + '&page=' + next;
      if (feedKind === 'list') return '/api/anime/browse?list=' + encodeURIComponent(browseList.id) + '&page=' + next;
      return '/api/anime/browse?page=' + next;
    }
    if (feedKind === 'search') return '/api/search?q=' + encodeURIComponent(query) + '&page=' + next;
    if (feedKind === 'list') return '/api/list/' + encodeURIComponent(browseList.id) + '?page=' + next;
    if (feedKind === 'genre') return '/api/discover?genre=' + encodeURIComponent(browseGenre.id) + '&page=' + next;
    return '/api/trending?page=' + next;
  }

  function feedTitle() {
    if (feedKind === 'search') return `Results for “${query}”`;
    if (feedKind === 'list') return browseList.name;
    if (feedKind === 'genre') return `${browseGenre.name} ${contentType === 'anime' ? 'Anime' : 'Movies'}`;
    return contentType === 'anime' ? '🔥 Trending Anime' : '🔥 Trending this week';
  }

  function resetFeed() {
    feedToken += 1;
    page = 0; totalPages = 1; done = false; loading = false;
    seen.clear();
    resultsEl.innerHTML = '';
    showFeedEnd('hidden');
    sectionTitle.textContent = feedTitle();
    renderContinue();
    updateCrossHint();
    window.scrollTo({ top: 0 });
    loadMore();
  }

  function loadMore() {
    if (loading || done) return;
    loading = true;
    const myToken = feedToken;
    const next = page + 1;
    if (next === 1) setStatus('<span class="spinner"></span> Loading…');
    else showFeedEnd('loading');

    // Page 1 of a search reuses the request the parallel search already made.
    const shared = feedKind === 'search' && next === 1 && psearch && psearch.q === query
      ? psearch.promises[contentType]
      : null;
    const url = shared ? null : feedUrl(next);
    if (!shared && !url) {                  // nothing to fetch (e.g. an IMDB id in the Anime section)
      loading = false;
      done = true;
      if (next === 1) setStatus('No results found.');
      return;
    }

    (shared || getJson(url)).then((data) => {
      if (myToken !== feedToken) return;   // a newer feed replaced this one
      const results = data.results || [];
      page = data.page || next;
      totalPages = data.totalPages || page;

      const added = appendCards(results);

      if (next === 1) setStatus(feedKind === 'search' && !added ? 'No results found.' : '');
      if (page >= totalPages || (results.length === 0 && next > 1)) done = true;

      loading = false;
      showFeedEnd(done && seen.size ? 'end' : 'hidden');
      if (!done && nearBottom()) loadMore();
    }).catch((err) => {
      if (myToken !== feedToken) return;
      loading = false;
      done = true;
      if (next === 1) setStatus('❌ ' + escapeHtml(err.message), true);
      showFeedEnd('hidden');
    });
  }

  function appendCards(results) {
    let added = 0;
    for (const item of results) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      resultsEl.appendChild(makeCard(item));
      added++;
    }
    return added;
  }

  function nearBottom() {
    const doc = document.documentElement;
    return (doc.scrollHeight - window.scrollY - window.innerHeight) < 900;
  }
  let lastCheck = 0;
  function onScrollOrResize() {
    const now = Date.now();
    if (now - lastCheck < 120) return;
    lastCheck = now;
    if (!loading && !done && nearBottom()) loadMore();
  }
  window.addEventListener('scroll', onScrollOrResize, { passive: true });
  window.addEventListener('resize', onScrollOrResize);

  // --- parallel search -----------------------------------------------------
  // Every query hits Movies/TV (TMDB) and Anime (AniList) at the same time. The
  // dropdown fills in group by group as each answers; a newer query aborts the
  // older requests (and the server stops waiting on them too).
  function startParallelSearch(q) {
    if (psearch && psearch.q === q) return psearch;
    cancelParallelSearch();
    const ctrl = new AbortController();
    const enc = encodeURIComponent(q);
    const imdb = imdbIdOf(q);                // an IMDB id/link finds that exact title
    const ps = {
      q,
      ctrl,
      results: { movies: undefined, anime: undefined },   // undefined = still searching
      promises: {
        movies: getJson(imdb ? '/api/find?imdb=' + imdb : '/api/search?q=' + enc + '&page=1', ctrl.signal),
        anime: imdb ? Promise.resolve({ results: [], page: 1, totalPages: 1 })
          : getJson('/api/anime/search?q=' + enc + '&page=1', ctrl.signal),
      },
    };
    for (const g of ['movies', 'anime']) {
      ps.promises[g].then(
        (d) => {
          ps.results[g] = { items: d.results || [], more: (d.totalPages || 1) > 1 };
          onSearchUpdate(ps);
        },
        (err) => {
          if (err && err.name === 'AbortError') return;
          ps.results[g] = { items: [], more: false };
          onSearchUpdate(ps);
        });
    }
    psearch = ps;
    return ps;
  }
  function cancelParallelSearch() {
    if (psearch) psearch.ctrl.abort();
    psearch = null;
  }
  function onSearchUpdate(ps) {
    if (ps !== psearch) return;      // superseded by a newer query
    renderDropdown();
    updateCrossHint();
  }

  // Search the current section's grid + both catalogs for the dropdown.
  function runSearch(q, openDropdown) {
    if (!(feedKind === 'search' && query === q && psearch && psearch.q === q)) {
      startParallelSearch(q);
      query = q;
      feedKind = 'search';
      highlightGenre();
      resetFeed();                   // the grid reuses this section's half of the search
    }
    if (openDropdown) { dropdownOpen = true; renderDropdown(); }
  }

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (!q) {
      hideSuggestions();
      cancelParallelSearch();
      query = '';
      feedKind = browseKind;               // restore trending or the selected genre
      highlightGenre();
      resetFeed();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q, true), 250);
  });

  searchInput.addEventListener('focus', () => {
    const q = searchInput.value.trim();
    if (q && psearch && psearch.q === q) { dropdownOpen = true; renderDropdown(); }
  });

  searchInput.addEventListener('keydown', (e) => {
    const count = dropdownItems.length;
    if (e.key === 'ArrowDown' && dropdownOpen && count) {
      e.preventDefault();
      activeSuggestion = Math.min(activeSuggestion + 1, count - 1);
      highlightSuggestion();
    } else if (e.key === 'ArrowUp' && dropdownOpen && count) {
      e.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, 0);
      highlightSuggestion();
    } else if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      const item = dropdownOpen && activeSuggestion >= 0 ? dropdownItems[activeSuggestion] : null;
      if (item) { hideSuggestions(); openItem(item); return; }
      const q = searchInput.value.trim();
      if (q) runSearch(q, false);
      hideSuggestions();
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  // --- suggestions dropdown (grouped by catalog) ---------------------------
  const GROUP_LABEL = { movies: '🎬 Movies & TV', anime: '🌸 Anime' };

  function suggestionRow(item, i) {
    const poster = item.poster || PLACEHOLDER;
    const sub = [item.year, item.rating ? '★ ' + item.rating : ''].filter(Boolean).join(' · ');
    return `
      <div class="suggestion" role="option" data-index="${i}">
        <img loading="lazy" src="${escapeHtml(poster)}" alt="" onerror="this.src='${PLACEHOLDER}'">
        <div class="s-info">
          <div class="s-title">${escapeHtml(item.title)}</div>
          <div class="s-sub">${escapeHtml(sub || '—')}</div>
        </div>
        <span class="s-type ${escapeHtml(item.mediaType)}">${typeLabel(item.mediaType)}</span>
      </div>`;
  }

  function renderDropdown() {
    if (!dropdownOpen || !psearch) return;
    const ps = psearch;
    // this section's catalog first
    const order = contentType === 'anime' ? ['anime', 'movies'] : ['movies', 'anime'];
    const prevKey = activeSuggestion >= 0 && dropdownItems[activeSuggestion]
      ? keyOf(dropdownItems[activeSuggestion]) : null;
    dropdownItems = [];
    let html = '';
    let anyItems = false, anyPending = false;
    for (const g of order) {
      const r = ps.results[g];
      if (r === undefined) {
        anyPending = true;
        html += `<div class="s-group">${GROUP_LABEL[g]} <span class="spinner sm"></span></div>`;
        continue;
      }
      if (!r.items.length) continue;
      anyItems = true;
      html += `<div class="s-group">${GROUP_LABEL[g]}</div>`;
      for (const item of r.items.slice(0, 5)) html += suggestionRow(item, dropdownItems.push(item) - 1);
    }
    if (!anyItems && !anyPending) html = `<div class="s-empty">No matches for “${escapeHtml(ps.q)}”</div>`;
    suggestionsEl.innerHTML = html;
    // keep the keyboard highlight on the same title when the other group arrives
    activeSuggestion = prevKey ? dropdownItems.findIndex((it) => keyOf(it) === prevKey) : -1;
    highlightSuggestion();
    suggestionsEl.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
  }
  function hideSuggestions() {
    dropdownOpen = false;
    suggestionsEl.classList.add('hidden');
    suggestionsEl.innerHTML = '';
    activeSuggestion = -1;
    searchInput.setAttribute('aria-expanded', 'false');
  }
  function highlightSuggestion() {
    const els = suggestionsEl.querySelectorAll('.suggestion');
    els.forEach((el, i) => el.classList.toggle('active', i === activeSuggestion));
    if (els[activeSuggestion]) els[activeSuggestion].scrollIntoView({ block: 'nearest' });
  }
  suggestionsEl.addEventListener('click', (e) => {
    const el = e.target.closest('.suggestion');
    if (!el) return;
    const item = dropdownItems[Number(el.dataset.index)];
    hideSuggestions();
    if (item) openItem(item);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideSuggestions();
  });

  // "Also found N in the other section" hint above the results grid.
  function updateCrossHint() {
    const other = contentType === 'anime' ? 'movies' : 'anime';
    const r = feedKind === 'search' && psearch && psearch.q === query ? psearch.results[other] : null;
    if (!r || !r.items.length) {
      crossHint.classList.add('hidden');
      crossHint.innerHTML = '';
      return;
    }
    const n = r.items.length;
    const count = n + (r.more ? '+' : '');
    const noun = other === 'anime'
      ? `anime match${n === 1 && !r.more ? '' : 'es'}`
      : `movie & TV match${n === 1 && !r.more ? '' : 'es'}`;
    crossHint.innerHTML =
      `<span>${other === 'anime' ? '🌸' : '🎬'} Also found <b>${count}</b> ${noun} for “${escapeHtml(query)}”.</span>` +
      `<button type="button" class="link-btn" data-cross="${other}">Show ${other === 'anime' ? 'Anime' : 'Movies & TV'} →</button>`;
    crossHint.classList.remove('hidden');
  }
  crossHint.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cross]');
    if (b) setMode(b.dataset.cross, { query });
  });

  // --- card ----------------------------------------------------------------
  function makeCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const poster = item.poster || PLACEHOLDER;
    const ratingHtml = item.rating ? `<span class="rating">★ ${item.rating}</span>` : '';
    card.innerHTML = `
      <div class="poster">
        <img loading="lazy" src="${escapeHtml(poster)}" alt="${escapeHtml(item.title)} poster"
             onerror="this.src='${PLACEHOLDER}'">
        <span class="badge ${escapeHtml(item.mediaType)}">${typeLabel(item.mediaType)}</span>
        ${ratingHtml}
      </div>
      <div class="meta">
        <div class="title">${escapeHtml(item.title)}</div>
        <div class="year">${escapeHtml(item.year || '—')}</div>
      </div>`;
    const open = () => openItem(item);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return card;
  }

  // --- opening / playback --------------------------------------------------
  // Opening a title always picks up where you left off (episode + position).
  function openItem(item) {
    hideSuggestions();
    openToken += 1;
    currentItem = item;
    currentSeasons = [];
    pendingResume = null;
    modalTitle.textContent = item.title + (item.year ? ` (${item.year})` : '');
    const saved = getEntry(keyOf(item));

    if (item.mediaType === 'anime') {
      const isMovie = item.format === 'MOVIE' || item.format === 'MUSIC';
      currentMedia = { id: item.id, kind: isMovie ? 'anime-movie' : 'anime-show', season: null, episode: null };
      currentTvId = null;
      populateSourceSelect('anime');
      if (isMovie) {
        tvControls.classList.add('hidden');
        openModal();
        playCurrent();
        return;
      }
      tvControls.classList.remove('hidden');
      seasonWrap.classList.add('hidden');        // anime has no seasons here
      episodeWrap.classList.remove('hidden');
      openModal();
      setIframe('');
      const count = item.episodes || (saved && saved.episodes) || null;
      let ep = 1;
      if (saved && saved.episode >= 1) {
        ep = saved.episode;
        if (saved.completed) {
          if (!count || ep < count) { ep += 1; pendingResume = { type: 'next' }; }
          else { ep = 1; pendingResume = { type: 'restart' }; }      // finished the series
        } else if (ep > 1 || saved.position > 0) {
          pendingResume = { type: 'continue' };
        }
      }
      populateAnimeEpisodes(count, ep);
      playCurrent();
      return;
    }

    // Movies / TV via TMDB
    populateSourceSelect('movies');
    seasonWrap.classList.remove('hidden');
    episodeWrap.classList.remove('hidden');
    if (item.mediaType === 'movie') {
      currentMedia = { id: item.id, kind: 'movie', season: null, episode: null };
      currentTvId = null;
      tvControls.classList.add('hidden');
      openModal();
      playCurrent();
    } else {
      currentMedia = { id: item.id, kind: 'tv', season: null, episode: null };
      currentTvId = item.id;
      tvControls.classList.remove('hidden');
      openModal();
      setIframe('');
      loadSeasons(item.id, saved);
    }
  }

  function populateAnimeEpisodes(count, selected = 1) {
    let n = count && count > 0 ? Math.min(count, 2000) : 24;
    if (selected > n) n = Math.min(selected, 2000);   // ongoing shows: make sure the saved ep exists
    let html = '';
    for (let i = 1; i <= n; i++) html += `<option value="${i}">Episode ${i}</option>`;
    episodeSelect.innerHTML = html;
    episodeSelect.value = String(Math.min(selected, n));
  }

  function playCurrent() {
    if (!currentMedia) return;
    const k = currentMedia.kind;
    const grp = groupOf(k);
    const src = SRC[grp].byId[SRC[grp].current] || SRC[grp].list[0];
    if (!src) return;

    let season = null, episode = null;
    if (k === 'tv') {
      season = Number(seasonSelect.value);
      episode = Number(episodeSelect.value);
      if (!Number.isInteger(season) || !Number.isInteger(episode) || episode < 1) return;
    } else if (k === 'anime-show') {
      episode = Number(episodeSelect.value);
      if (!Number.isInteger(episode) || episode < 1) return;
    }
    let url = null;
    if (!src.torrent) {
      if (k === 'movie' || k === 'anime-movie') url = buildUrl(src.movie, { id: currentMedia.id });
      else if (k === 'tv') url = buildUrl(src.tv, { id: currentMedia.id, season, episode });
      else url = buildUrl(src.show, { id: currentMedia.id, episode });
    }
    currentMedia.season = season;
    currentMedia.episode = episode;

    // Where did we leave off in *this* episode? Jump there if the server supports it.
    const prev = currentItem ? getEntry(keyOf(currentItem)) : null;
    const at = prev && !prev.completed && prev.season === season && prev.episode === episode &&
      prev.position > 15 && (!prev.duration || prev.position < prev.duration * 0.95)
      ? Math.floor(prev.position) : 0;
    const canJump = Boolean(at && (src.startParam || src.torrent));
    if (canJump && src.startParam) url = withParam(url, src.startParam, at);
    // If this server can't jump there, it starts from 0:00 — don't let its early
    // progress reports overwrite your spot until you actually watch past it.
    resumeFloor = canJump ? 0 : at;

    const epLabel = k === 'tv' ? `S${season} · E${episode}` : (k === 'anime-show' ? `Episode ${episode}` : '');
    const why = pendingResume && pendingResume.type;
    pendingResume = null;
    if (src.torrent) playTorrent(at, epLabel, why === 'next');
    else setIframe(url);
    recordWatch();
    armEngagement();

    if (src.torrent && at) { /* the torrent player shows "Resuming at …" itself */ }
    else if (canJump) toast(`▶ Resuming${epLabel ? ' ' + epLabel : ''} at ${fmtTime(at)}`);
    else if (at) toast(`⏱ ${epLabel ? epLabel + ' — you' : 'You'} left off at ${fmtTime(at)} (this server can't jump there)`);
    else if (why === 'next') toast(`▶ Up next: ${epLabel}`);
    else if (why === 'restart') toast(`↺ Starting over from ${epLabel || 'the beginning'}`);
    else if (why === 'continue' && epLabel) toast(`▶ Continuing ${epLabel}`);
  }

  async function loadSeasons(id, saved) {
    const tok = openToken;
    seasonSelect.innerHTML = '<option>Loading…</option>';
    episodeSelect.innerHTML = '';
    try {
      const data = await getJson('/api/tv/' + encodeURIComponent(id));
      if (tok !== openToken) return;             // closed or opened something else meanwhile
      const seasons = (data.seasons || []).filter((s) => s.episodeCount > 0);
      currentSeasons = seasons;
      if (!seasons.length) { seasonSelect.innerHTML = '<option>No seasons</option>'; return; }
      seasonSelect.innerHTML = seasons
        .map((s) => `<option value="${s.seasonNumber}">${escapeHtml(s.name)}</option>`)
        .join('');
      const firstReal = seasons.find((s) => s.seasonNumber >= 1) || seasons[0];
      let season = firstReal.seasonNumber;
      let episode = null;
      if (saved && saved.episode >= 1 && seasons.some((s) => s.seasonNumber === saved.season)) {
        season = saved.season;
        episode = saved.episode;
        if (saved.completed) {
          const cur = seasons.find((s) => s.seasonNumber === season);
          const next = seasons.find((s) => s.seasonNumber > season && s.seasonNumber >= 1);
          if (cur && episode < cur.episodeCount) { episode += 1; pendingResume = { type: 'next' }; }
          else if (next) { season = next.seasonNumber; episode = 1; pendingResume = { type: 'next' }; }
          else { season = firstReal.seasonNumber; episode = null; pendingResume = { type: 'restart' }; }
        } else if (!(season === firstReal.seasonNumber && episode === 1) || saved.position > 0) {
          pendingResume = { type: 'continue' };
        }
      }
      seasonSelect.value = String(season);
      await loadEpisodes(id, season, true, episode);
    } catch (err) {
      if (tok !== openToken) return;
      seasonSelect.innerHTML = '<option>Error</option>';
      playerLoading.textContent = err.message;
    }
  }

  async function loadEpisodes(id, season, autoplayFirst = false, targetEpisode = null) {
    const tok = openToken;
    episodeSelect.innerHTML = '<option>Loading…</option>';
    try {
      const data = await getJson(`/api/tv/${encodeURIComponent(id)}/season/${encodeURIComponent(season)}`);
      if (tok !== openToken) return;
      const eps = data.episodes || [];
      if (!eps.length) { episodeSelect.innerHTML = '<option>No episodes</option>'; return; }
      episodeSelect.innerHTML = eps
        .map((e) => `<option value="${e.episodeNumber}">E${e.episodeNumber} · ${escapeHtml(e.name)}</option>`)
        .join('');
      const want = targetEpisode && eps.some((e) => e.episodeNumber === targetEpisode)
        ? targetEpisode : eps[0].episodeNumber;
      episodeSelect.value = String(want);
      if (autoplayFirst) playCurrent();
    } catch (err) {
      if (tok !== openToken) return;
      episodeSelect.innerHTML = '<option>Error</option>';
    }
  }

  seasonSelect.addEventListener('change', () => {
    if (currentTvId) loadEpisodes(currentTvId, seasonSelect.value, false);
  });
  episodeSelect.addEventListener('change', () => {
    if (currentMedia && (currentMedia.kind === 'anime-show')) playCurrent();
  });
  playEpisodeBtn.addEventListener('click', playCurrent);

  sourceSelect.addEventListener('change', () => {
    const grp = currentMedia ? groupOf(currentMedia.kind) : contentType;
    SRC[grp].current = sourceSelect.value;
    try {
      localStorage.setItem(grp === 'anime' ? 'ss_anime_source' : 'ss_source', SRC[grp].current);
    } catch (_) { /* ignore */ }
    iframe.removeAttribute('src');
    playCurrent();            // carries your position over if the new server can jump to it
  });

  // --- player progress (postMessage) --------------------------------------
  // CineSrc, VidEasy and VidFast broadcast playback progress to the page that
  // embeds them. We only trust messages from our player frame (or frames nested
  // in it) whose origin is the same site we loaded, and only read numbers from
  // them — the data is untrusted.
  let loadStartedAt = 0;
  let playingSite = '';
  let resumeFloor = 0;       // saved spot to protect while a non-jumping server replays from 0:00

  function siteLabel(host) {
    const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
  }
  function fromPlayer(win) {
    const root = iframe.contentWindow;
    let w = win;
    for (let i = 0; i < 6 && root && w; i++) {
      if (w === root) return true;
      let parent;
      try { parent = w.parent; } catch (_) { return false; }
      if (!parent || parent === w) return false;
      w = parent;
    }
    return false;
  }
  function parsePlayerMessage(raw) {
    let d = raw;
    if (typeof d === 'string') {
      if (d.length > 20000 || d.trim()[0] !== '{') return null;
      try { d = JSON.parse(d); } catch (_) { return null; }
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    // unwrap { type, data: {...} } envelopes
    const m = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? Object.assign({}, d, d.data) : d;
    const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean'
      ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    const tag = `${m.type || ''} ${m.event || ''}`.toLowerCase();
    const out = {};
    const dur = num(m.duration);
    const pos = num(m.currentTime ?? m.timestamp ?? m.time ?? m.position);
    if (dur !== null && dur > 30 && dur < 86400) out.duration = dur;
    if (pos !== null && out.duration !== undefined && pos >= 0 && pos <= out.duration + 5) out.position = pos;
    const s = num(m.season), e = num(m.episode);
    if (s !== null && Number.isInteger(s) && s >= 0 && s < 200) out.season = s;
    if (e !== null && Number.isInteger(e) && e >= 1 && e < 10000) out.episode = e;
    if (/\bended\b|complete/.test(tag)) out.ended = true;
    return out.position !== undefined || out.ended || out.episode !== undefined ? out : null;
  }
  function plausibleEpisode(season, episode) {
    if (currentMedia.kind === 'tv') {
      if (!currentSeasons.length) return true;
      const s = currentSeasons.find((x) => x.seasonNumber === season);
      return Boolean(s) && episode <= s.episodeCount + 1;
    }
    return !currentItem.episodes || episode <= currentItem.episodes + 1;
  }

  window.addEventListener('message', (ev) => {
    if (!currentMedia || !currentItem || modal.classList.contains('hidden')) return;
    if (!fromPlayer(ev.source)) return;
    let label;
    try { label = siteLabel(new URL(ev.origin).hostname); } catch (_) { return; }
    if (!playingSite || label !== playingSite) return;
    if (Date.now() - loadStartedAt < 2500) return;   // stragglers from the previous page
    const info = parsePlayerMessage(ev.data);
    if (info) applyProgress(info);
  });

  function applyProgress(info) {
    const entry = getEntry(keyOf(currentItem));
    if (!entry) return;
    const k = currentMedia.kind;
    // The player moved to another episode by itself (auto-next / in-player picker).
    if (k === 'tv' && info.season !== undefined && info.episode !== undefined &&
        (info.season !== currentMedia.season || info.episode !== currentMedia.episode) &&
        plausibleEpisode(info.season, info.episode)) {
      followEpisode(info.season, info.episode);
      return;
    }
    if (k === 'anime-show' && info.episode !== undefined && info.episode !== currentMedia.episode &&
        plausibleEpisode(null, info.episode)) {
      followEpisode(null, info.episode);
      return;
    }
    if (info.position !== undefined) {
      if (resumeFloor && info.position < resumeFloor - 30) {
        // restarted from 0:00 on a server that can't jump: keep the saved spot for now
      } else {
        entry.position = info.position;
        entry.duration = info.duration;
        if (info.position >= resumeFloor) resumeFloor = 0;
      }
    }
    if (info.ended || (entry.duration > 0 && entry.position >= entry.duration * 0.95)) entry.completed = true;
    entry.updatedAt = Date.now();
    saveHistorySoon();
  }

  // Sync our pickers + history to the episode the player switched to, without
  // reloading the iframe.
  function followEpisode(season, episode) {
    const k = currentMedia.kind;
    currentMedia.season = season;
    currentMedia.episode = episode;
    resumeFloor = 0;
    if (k === 'tv') {
      if (seasonSelect.value !== String(season)) {
        seasonSelect.value = String(season);
        loadEpisodes(currentTvId, season, false, episode);
      } else {
        episodeSelect.value = String(episode);
      }
    } else {
      if (![...episodeSelect.options].some((o) => o.value === String(episode))) {
        episodeSelect.insertAdjacentHTML('beforeend', `<option value="${episode}">Episode ${episode}</option>`);
      }
      episodeSelect.value = String(episode);
    }
    recordWatch();            // new episode -> progress starts fresh
    armEngagement();
    toast(k === 'tv' ? `▶ Now playing S${season} · E${episode}` : `▶ Now playing Episode ${episode}`);
  }

  // --- toast ---------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    if (!msg) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4500);
  }

  // --- torrent server ------------------------------------------------------
  // binge: moving on to the next episode — keep using the torrent picked before.
  function playTorrent(at, epLabel, binge) {
    iframe.removeAttribute('src');
    playingSite = '';
    playerLoading.style.display = 'none';
    torrentPlayer.play({
      kind: currentMedia.kind,
      id: currentMedia.id,
      season: currentMedia.season,
      episode: currentMedia.episode,
      at,
      binge: Boolean(binge),
      titleKey: keyOf(currentItem),
      label: [currentItem.title + (currentItem.year ? ` (${currentItem.year})` : ''), epLabel].filter(Boolean).join(' · '),
    });
  }

  // The episode after the one playing (null at the end of a show / for films).
  function upcomingEpisode() {
    const m = currentMedia;
    if (!m) return null;
    if (m.kind === 'tv') {
      const cur = currentSeasons.find((s) => s.seasonNumber === m.season);
      if (cur && m.episode < cur.episodeCount) return { season: m.season, episode: m.episode + 1 };
      const next = currentSeasons.find((s) => s.seasonNumber > m.season && s.seasonNumber >= 1);
      return next ? { season: next.seasonNumber, episode: 1 } : null;
    }
    if (m.kind === 'anime-show') {
      const count = currentItem && currentItem.episodes;
      return !count || m.episode < count ? { season: null, episode: m.episode + 1 } : null;
    }
    return null;
  }
  function goToEpisode(n) {
    if (!currentMedia) return;
    pendingResume = { type: 'next' };
    if (currentMedia.kind === 'tv') {
      if (seasonSelect.value !== String(n.season)) {
        seasonSelect.value = String(n.season);
        loadEpisodes(currentTvId, n.season, true, n.episode);
        return;
      }
      episodeSelect.value = String(n.episode);
    } else {
      if (![...episodeSelect.options].some((o) => o.value === String(n.episode))) {
        episodeSelect.insertAdjacentHTML('beforeend', `<option value="${n.episode}">Episode ${n.episode}</option>`);
      }
      episodeSelect.value = String(n.episode);
    }
    playCurrent();
  }
  // Finished an episode in the torrent player: mark it watched, offer the next.
  function onTorrentEnded() {
    if (!currentMedia || !currentItem) return;
    applyProgress({ ended: true });
    const n = upcomingEpisode();
    if (!n) return;
    const label = currentMedia.kind === 'tv' ? `S${n.season} · E${n.episode}` : `Episode ${n.episode}`;
    torrentPlayer.showUpNext(label, 10, () => goToEpisode(n));
  }

  // --- modal ---------------------------------------------------------------
  function setIframe(src) {
    if (torrentPlayer) torrentPlayer.stop();
    if (!src) {
      iframe.removeAttribute('src');
      playingSite = '';
      playerLoading.style.display = 'flex';
      playerLoading.textContent = 'Select an episode, then press Play.';
      return;
    }
    loadStartedAt = Date.now();
    try { playingSite = siteLabel(new URL(src).hostname); } catch (_) { playingSite = ''; }
    playerLoading.style.display = 'flex';
    playerLoading.textContent = 'Loading player…';
    iframe.src = src;
  }
  iframe.addEventListener('load', () => {
    if (iframe.getAttribute('src')) playerLoading.style.display = 'none';
  });
  function openModal() {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    hideSuggestions();
  }
  function closeModal() {
    if (fsElement()) exitFS();
    clearTimeout(engageTimer);
    clearTimeout(toastTimer);
    toastEl.classList.remove('show');
    if (torrentPlayer) torrentPlayer.stop();   // reports the final position first
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    iframe.removeAttribute('src');
    playingSite = '';
    openToken += 1;
    currentTvId = null;
    currentMedia = null;
    currentItem = null;
    saveHistoryNow();
    renderContinue();
  }
  closeBtn.addEventListener('click', closeModal);

  // --- fullscreen ----------------------------------------------------------
  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
           document.mozFullScreenElement || document.msFullscreenElement || null;
  }
  function requestFS(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen ||
               el.mozRequestFullScreen || el.msRequestFullscreen;
    return fn ? fn.call(el) : null;
  }
  function exitFS() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen ||
               document.mozCancelFullScreen || document.msExitFullscreen;
    return fn ? fn.call(document) : null;
  }
  function tryFS(el) {
    let p = null;
    try { p = requestFS(el); } catch (_) { return false; }
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return true;
  }
  fullscreenBtn.addEventListener('click', () => {
    if (fsElement()) { exitFS(); return; }
    let p = null;
    try { p = requestFS(playerFrame); } catch (_) { p = null; }
    if (p && typeof p.catch === 'function') p.catch(() => tryFS(iframe));
    else if (!p) tryFS(iframe);
  });
  function updateFsLabel() {
    fullscreenBtn.textContent = fsElement() ? '⤢ Exit fullscreen' : '⛶ Fullscreen';
  }
  document.addEventListener('fullscreenchange', updateFsLabel);
  document.addEventListener('webkitfullscreenchange', updateFsLabel);

  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key !== 'Escape' && torrentPlayer && torrentPlayer.active() && torrentPlayer.handleKey(e)) return;
    if (e.key === 'Escape' && !fsElement()) closeModal();
  });

  // --- go ------------------------------------------------------------------
  init();
})();
