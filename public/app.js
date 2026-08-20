/* SwiftWatchesMovies frontend */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const searchInput = $('#search');
  const suggestionsEl = $('#suggestions');
  const resultsEl = $('#results');
  const statusEl = $('#status');
  const sectionTitle = $('#section-title');
  const feedEnd = $('#feed-end');
  const modeTabs = $('#mode-tabs');
  const genreList = $('#genre-list');

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

  // Streaming sources per content type, from /api/config.
  const SRC = {
    movies: { list: [], byId: {}, current: null },
    anime: { list: [], byId: {}, current: null },
  };
  let currentMedia = null;   // { id, kind }  kind: movie | tv | anime-movie | anime-show
  let currentTvId = null;

  // Feed state.
  let contentType = 'movies';   // 'movies' | 'anime'
  let feedKind = 'default';     // 'default' | 'genre' | 'search'
  let browseKind = 'default';   // remembered browse state to restore when search clears
  let browseGenre = null;       // { id, name }
  let query = '';
  let page = 0;
  let totalPages = 1;
  let loading = false;
  let done = false;
  let feedToken = 0;         // bumped on every resetFeed; stale loads are ignored
  const seen = new Set();
  const genresCache = { movies: null, anime: null };

  let lastResults = [];
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
  async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  function buildUrl(tpl, vars) {
    return tpl.replace(/\{(id|season|episode)\}/g, (_, k) =>
      (vars[k] != null ? encodeURIComponent(vars[k]) : ''));
  }
  function typeLabel(mt) {
    if (mt === 'tv') return 'TV';
    if (mt === 'anime') return 'Anime';
    return 'Movie';
  }

  // --- config + init -------------------------------------------------------
  async function init() {
    try {
      const cfg = await getJson('/api/config');
      SRC.movies.list = cfg.sources || [];
      SRC.movies.list.forEach((s) => { SRC.movies.byId[s.id] = s; });
      SRC.anime.list = cfg.animeSources || [];
      SRC.anime.list.forEach((s) => { SRC.anime.byId[s.id] = s; });

      let savedMovieSrc = null, savedAnimeSrc = null, savedMode = null;
      try {
        savedMovieSrc = localStorage.getItem('ss_source');
        savedAnimeSrc = localStorage.getItem('ss_anime_source');
        savedMode = localStorage.getItem('ss_mode');
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

    setMode(contentType, true);
  }

  // Fill the Server dropdown with the current mode's sources.
  function populateSourceSelect() {
    const s = SRC[contentType];
    if (!s.list.length) { sourcePicker.classList.add('hidden'); return; }
    sourcePicker.classList.remove('hidden');
    sourceSelect.innerHTML = s.list
      .map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`)
      .join('');
    sourceSelect.value = s.current;
  }

  // --- mode (Movies / Anime) ----------------------------------------------
  function setMode(mode, initial) {
    contentType = mode;
    try { localStorage.setItem('ss_mode', mode); } catch (_) { /* ignore */ }
    [...modeTabs.querySelectorAll('.mode-tab')].forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
    searchInput.placeholder = mode === 'anime' ? 'Search anime…' : 'Search movies & TV…';

    searchInput.value = '';
    query = '';
    hideSuggestions();
    browseKind = 'default';
    browseGenre = null;
    feedKind = 'default';

    populateSourceSelect();
    loadGenres(mode);
    resetFeed();
  }

  modeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-tab');
    if (btn && btn.dataset.mode !== contentType) setMode(btn.dataset.mode, false);
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

  function renderGenres(genres) {
    const trendingLabel = contentType === 'anime' ? '🔥 Trending Anime' : '🔥 Trending';
    const items = [`<button class="genre-item active" data-all="1">${trendingLabel}</button>`]
      .concat(genres.map((g) =>
        `<button class="genre-item" data-id="${escapeHtml(String(g.id))}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`));
    genreList.innerHTML = items.join('');
  }

  genreList.addEventListener('click', (e) => {
    const btn = e.target.closest('.genre-item');
    if (!btn) return;
    searchInput.value = '';
    query = '';
    hideSuggestions();
    if (btn.dataset.all) {
      browseKind = 'default'; browseGenre = null; feedKind = 'default';
    } else {
      browseKind = 'genre';
      browseGenre = { id: btn.dataset.id, name: btn.dataset.name };
      feedKind = 'genre';
    }
    highlightGenre();
    resetFeed();
  });

  function highlightGenre() {
    [...genreList.querySelectorAll('.genre-item')].forEach((b) => {
      const isActive = (feedKind === 'default' && b.dataset.all) ||
                       (feedKind === 'genre' && browseGenre && b.dataset.id === String(browseGenre.id));
      b.classList.toggle('active', Boolean(isActive));
    });
  }

  // --- feed / infinite scroll ---------------------------------------------
  function feedUrl(next) {
    if (contentType === 'anime') {
      if (feedKind === 'search') return '/api/anime/search?q=' + encodeURIComponent(query) + '&page=' + next;
      if (feedKind === 'genre') return '/api/anime/browse?genre=' + encodeURIComponent(browseGenre.name) + '&page=' + next;
      return '/api/anime/browse?page=' + next;
    }
    if (feedKind === 'search') return '/api/search?q=' + encodeURIComponent(query) + '&page=' + next;
    if (feedKind === 'genre') return '/api/discover?genre=' + encodeURIComponent(browseGenre.id) + '&page=' + next;
    return '/api/trending?page=' + next;
  }

  function feedTitle() {
    if (feedKind === 'search') return `Results for “${query}”`;
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

    getJson(feedUrl(next)).then((data) => {
      if (myToken !== feedToken) return;   // a newer feed replaced this one
      const results = data.results || [];
      page = data.page || next;
      totalPages = data.totalPages || page;

      if (feedKind === 'search' && next === 1) {
        lastResults = results;
        showSuggestions(results);
      }
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
      const key = item.mediaType + ':' + item.id;
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

  // --- search --------------------------------------------------------------
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (!q) {
      hideSuggestions();
      query = '';
      feedKind = browseKind;               // restore trending or the selected genre
      highlightGenre();
      resetFeed();
      return;
    }
    debounceTimer = setTimeout(() => {
      query = q;
      feedKind = 'search';
      highlightGenre();
      resetFeed();
    }, 300);
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim() && lastResults.length) showSuggestions(lastResults);
  });

  searchInput.addEventListener('keydown', (e) => {
    const items = suggestionsEl.querySelectorAll('.suggestion');
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      activeSuggestion = Math.min(activeSuggestion + 1, items.length - 1);
      highlightSuggestion(items);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      activeSuggestion = Math.max(activeSuggestion - 1, 0);
      highlightSuggestion(items);
    } else if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      if (activeSuggestion >= 0 && lastResults[activeSuggestion]) {
        openItem(lastResults[activeSuggestion]);
        hideSuggestions();
      } else {
        const q = searchInput.value.trim();
        if (q) { query = q; feedKind = 'search'; highlightGenre(); resetFeed(); }
        hideSuggestions();
      }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });

  // --- suggestions dropdown ------------------------------------------------
  function showSuggestions(results) {
    activeSuggestion = -1;
    const top = results.slice(0, 8);
    if (!top.length) { hideSuggestions(); return; }
    suggestionsEl.innerHTML = top.map((item, i) => {
      const poster = item.poster || PLACEHOLDER;
      const sub = [item.year, item.rating ? '★ ' + item.rating : ''].filter(Boolean).join(' · ');
      return `
        <div class="suggestion" role="option" data-index="${i}">
          <img loading="lazy" src="${poster}" alt="" onerror="this.src='${PLACEHOLDER}'">
          <div class="s-info">
            <div class="s-title">${escapeHtml(item.title)}</div>
            <div class="s-sub">${escapeHtml(sub || '—')}</div>
          </div>
          <span class="s-type ${item.mediaType}">${typeLabel(item.mediaType)}</span>
        </div>`;
    }).join('');
    suggestionsEl.querySelectorAll('.suggestion').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.index);
        if (lastResults[idx]) openItem(lastResults[idx]);
        hideSuggestions();
      });
    });
    suggestionsEl.classList.remove('hidden');
    searchInput.setAttribute('aria-expanded', 'true');
  }
  function hideSuggestions() {
    suggestionsEl.classList.add('hidden');
    suggestionsEl.innerHTML = '';
    activeSuggestion = -1;
    searchInput.setAttribute('aria-expanded', 'false');
  }
  function highlightSuggestion(items) {
    items.forEach((el, i) => el.classList.toggle('active', i === activeSuggestion));
    if (items[activeSuggestion]) items[activeSuggestion].scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideSuggestions();
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
        <img loading="lazy" src="${poster}" alt="${escapeHtml(item.title)} poster"
             onerror="this.src='${PLACEHOLDER}'">
        <span class="badge ${item.mediaType}">${typeLabel(item.mediaType)}</span>
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
  function openItem(item) {
    hideSuggestions();
    modalTitle.textContent = item.title + (item.year ? ` (${item.year})` : '');

    if (item.mediaType === 'anime') {
      const isMovie = item.format === 'MOVIE' || item.format === 'MUSIC';
      currentMedia = { id: item.id, kind: isMovie ? 'anime-movie' : 'anime-show' };
      currentTvId = null;
      if (isMovie) {
        tvControls.classList.add('hidden');
        openModal();
        playCurrent();
      } else {
        tvControls.classList.remove('hidden');
        seasonWrap.classList.add('hidden');        // anime has no seasons here
        episodeWrap.classList.remove('hidden');
        openModal();
        setIframe('');
        populateAnimeEpisodes(item.episodes);
        playCurrent();
      }
      return;
    }

    // Movies / TV via TMDB
    seasonWrap.classList.remove('hidden');
    if (item.mediaType === 'movie') {
      currentMedia = { id: item.id, kind: 'movie' };
      currentTvId = null;
      tvControls.classList.add('hidden');
      openModal();
      playCurrent();
    } else {
      currentMedia = { id: item.id, kind: 'tv' };
      currentTvId = item.id;
      tvControls.classList.remove('hidden');
      openModal();
      setIframe('');
      loadSeasons(item.id);
    }
  }

  function populateAnimeEpisodes(count) {
    const n = count && count > 0 ? Math.min(count, 2000) : 24;
    let html = '';
    for (let i = 1; i <= n; i++) html += `<option value="${i}">Episode ${i}</option>`;
    episodeSelect.innerHTML = html;
    episodeSelect.value = '1';
  }

  function playCurrent() {
    if (!currentMedia) return;
    const k = currentMedia.kind;
    const ms = SRC.movies.byId[SRC.movies.current] || SRC.movies.list[0];
    const as = SRC.anime.byId[SRC.anime.current] || SRC.anime.list[0];
    if (k === 'movie') {
      if (ms) setIframe(buildUrl(ms.movie, { id: currentMedia.id }));
    } else if (k === 'tv') {
      const season = seasonSelect.value, episode = episodeSelect.value;
      if (ms && season && episode && !Number.isNaN(Number(season)) && !Number.isNaN(Number(episode))) {
        setIframe(buildUrl(ms.tv, { id: currentMedia.id, season, episode }));
      }
    } else if (k === 'anime-movie') {
      if (as) setIframe(buildUrl(as.movie, { id: currentMedia.id }));
    } else if (k === 'anime-show') {
      const episode = episodeSelect.value;
      if (as && episode) setIframe(buildUrl(as.show, { id: currentMedia.id, episode }));
    }
  }

  async function loadSeasons(id) {
    seasonSelect.innerHTML = '<option>Loading…</option>';
    episodeSelect.innerHTML = '';
    try {
      const data = await getJson('/api/tv/' + encodeURIComponent(id));
      const seasons = (data.seasons || []).filter((s) => s.episodeCount > 0);
      if (!seasons.length) { seasonSelect.innerHTML = '<option>No seasons</option>'; return; }
      seasonSelect.innerHTML = seasons
        .map((s) => `<option value="${s.seasonNumber}">${escapeHtml(s.name)}</option>`)
        .join('');
      const firstReal = seasons.find((s) => s.seasonNumber >= 1) || seasons[0];
      seasonSelect.value = String(firstReal.seasonNumber);
      await loadEpisodes(id, firstReal.seasonNumber, true);
    } catch (err) {
      seasonSelect.innerHTML = '<option>Error</option>';
      playerLoading.textContent = err.message;
    }
  }

  async function loadEpisodes(id, season, autoplayFirst = false) {
    episodeSelect.innerHTML = '<option>Loading…</option>';
    try {
      const data = await getJson(`/api/tv/${encodeURIComponent(id)}/season/${encodeURIComponent(season)}`);
      const eps = data.episodes || [];
      if (!eps.length) { episodeSelect.innerHTML = '<option>No episodes</option>'; return; }
      episodeSelect.innerHTML = eps
        .map((e) => `<option value="${e.episodeNumber}">E${e.episodeNumber} · ${escapeHtml(e.name)}</option>`)
        .join('');
      episodeSelect.value = String(eps[0].episodeNumber);
      if (autoplayFirst) playCurrent();
    } catch (err) {
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
    const s = SRC[contentType];
    s.current = sourceSelect.value;
    try {
      localStorage.setItem(contentType === 'anime' ? 'ss_anime_source' : 'ss_source', s.current);
    } catch (_) { /* ignore */ }
    // reload so the new source (which may be sandbox-sensitive) reinitializes cleanly
    iframe.removeAttribute('src');
    playCurrent();
  });

  // --- modal ---------------------------------------------------------------
  function setIframe(src) {
    if (!src) {
      iframe.removeAttribute('src');
      playerLoading.style.display = 'flex';
      playerLoading.textContent = 'Select an episode, then press Play.';
      return;
    }
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
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    iframe.removeAttribute('src');
    currentTvId = null;
    currentMedia = null;
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
    if (e.key === 'Escape' && !modal.classList.contains('hidden') && !fsElement()) closeModal();
  });

  // --- go ------------------------------------------------------------------
  init();
})();
