/* StreamSearch frontend */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const searchInput = $('#search');
  const suggestionsEl = $('#suggestions');
  const resultsEl = $('#results');
  const statusEl = $('#status');
  const sectionTitle = $('#section-title');
  const feedEnd = $('#feed-end');

  const modal = $('#player-modal');
  const modalTitle = $('#modal-title');
  const playerFrame = $('#player-frame');
  const tvControls = $('#tv-controls');
  const seasonSelect = $('#season-select');
  const episodeSelect = $('#episode-select');
  const playEpisodeBtn = $('#play-episode');
  const sourceSelect = $('#source-select');
  const fullscreenBtn = $('#fullscreen-btn');
  const closeBtn = $('#close-modal');
  const iframe = $('#player');
  const playerLoading = $('#player-loading');

  // Embed sources (loaded from /api/config).
  let sources = [];
  const sourceById = {};
  let currentSourceId = null;
  let currentMedia = null;   // { id, mediaType } currently open in the player

  let currentTvId = null;
  let lastResults = [];      // first page of the current search (for the dropdown)
  let activeSuggestion = -1;

  // Infinite-scroll feed state.
  let mode = 'trending';     // 'trending' | 'search'
  let query = '';
  let page = 0;              // highest page loaded so far
  let totalPages = 1;
  let loading = false;
  let done = false;
  const seen = new Set();

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
    if (state === 'loading') {
      feedEnd.textContent = 'Loading more…';
      feedEnd.classList.remove('hidden');
    } else if (state === 'end') {
      feedEnd.textContent = "You've reached the end.";
      feedEnd.classList.remove('hidden');
    } else {
      feedEnd.classList.add('hidden');
    }
  }

  async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // --- config + first load -------------------------------------------------
  async function init() {
    try {
      const cfg = await getJson('/api/config');
      sources = cfg.sources || [];
      sources.forEach((s) => { sourceById[s.id] = s; });

      let saved = null;
      try { saved = localStorage.getItem('ss_source'); } catch (_) { /* ignore */ }
      currentSourceId = (saved && sourceById[saved])
        ? saved
        : (cfg.defaultSource && sourceById[cfg.defaultSource] ? cfg.defaultSource : (sources[0] && sources[0].id));
      buildSourceSelect();

      if (!cfg.hasApiKey) {
        setStatus('⚠️ The server has no TMDB API key configured. Set <b>TMDB_API_KEY</b> and restart.', true);
        return;
      }
    } catch (_) {
      /* non-fatal */
    }
    resetFeed('trending', '');
  }

  function buildSourceSelect() {
    if (!sources.length) return;
    sourceSelect.innerHTML = sources
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join('');
    sourceSelect.value = currentSourceId;
  }

  // Fill {id} / {season} / {episode} placeholders in a source URL template.
  function buildUrl(tpl, vars) {
    return tpl.replace(/\{(id|season|episode)\}/g, (_, k) =>
      (vars[k] != null ? encodeURIComponent(vars[k]) : ''));
  }

  // --- infinite-scroll feed ------------------------------------------------
  function resetFeed(newMode, newQuery) {
    mode = newMode;
    query = newQuery || '';
    page = 0;
    totalPages = 1;
    done = false;
    loading = false;
    seen.clear();
    resultsEl.innerHTML = '';
    showFeedEnd('hidden');
    sectionTitle.textContent = mode === 'search' ? `Results for “${query}”` : '🔥 Trending this week';
    window.scrollTo({ top: 0 });
    loadMore();
  }

  function loadMore() {
    if (loading || done) return;
    loading = true;
    const next = page + 1;
    if (next === 1) setStatus('<span class="spinner"></span> Loading…');
    else showFeedEnd('loading');

    const url = mode === 'search'
      ? '/api/search?q=' + encodeURIComponent(query) + '&page=' + next
      : '/api/trending?page=' + next;

    getJson(url).then((data) => {
      const results = data.results || [];
      page = data.page || next;
      totalPages = data.totalPages || page;

      if (mode === 'search' && next === 1) {
        lastResults = results;
        showSuggestions(results);
      }

      const added = appendCards(results);

      if (next === 1) {
        setStatus(mode === 'search' && !added ? 'No results found.' : '');
      }
      if (page >= totalPages || (results.length === 0 && next > 1)) done = true;

      loading = false;
      showFeedEnd(done && seen.size ? 'end' : 'hidden');

      // Keep filling until the viewport is covered (or we're done).
      if (!done && nearBottom()) loadMore();
    }).catch((err) => {
      loading = false;
      done = true; // stop hammering on error
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

  // Are we within ~900px of the bottom of the page?
  function nearBottom() {
    const doc = document.documentElement;
    return (doc.scrollHeight - window.scrollY - window.innerHeight) < 900;
  }

  // Trigger more loads on scroll/resize (time-throttled, no rAF dependency).
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
      resetFeed('trending', '');
      return;
    }
    debounceTimer = setTimeout(() => resetFeed('search', q), 300);
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
        if (q) resetFeed('search', q);
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
      const type = item.mediaType === 'tv' ? 'TV' : 'Movie';
      const sub = [item.year, item.rating ? '★ ' + item.rating : ''].filter(Boolean).join(' · ');
      return `
        <div class="suggestion" role="option" data-index="${i}">
          <img loading="lazy" src="${poster}" alt="" onerror="this.src='${PLACEHOLDER}'">
          <div class="s-info">
            <div class="s-title">${escapeHtml(item.title)}</div>
            <div class="s-sub">${escapeHtml(sub || '—')}</div>
          </div>
          <span class="s-type ${item.mediaType}">${type}</span>
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
    const typeLabel = item.mediaType === 'tv' ? 'TV' : 'Movie';
    const ratingHtml = item.rating ? `<span class="rating">★ ${item.rating}</span>` : '';

    card.innerHTML = `
      <div class="poster">
        <img loading="lazy" src="${poster}" alt="${escapeHtml(item.title)} poster"
             onerror="this.src='${PLACEHOLDER}'">
        <span class="badge ${item.mediaType}">${typeLabel}</span>
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
    currentMedia = { id: item.id, mediaType: item.mediaType };
    modalTitle.textContent = item.title + (item.year ? ` (${item.year})` : '');
    if (item.mediaType === 'movie') {
      tvControls.classList.add('hidden');
      currentTvId = null;
      openModal();
      playCurrent();
    } else {
      currentTvId = item.id;
      tvControls.classList.remove('hidden');
      openModal();
      setIframe('');
      loadSeasons(item.id);
    }
  }

  // Build and load the embed URL for the current title on the current source.
  function playCurrent() {
    if (!currentMedia) return;
    const src = sourceById[currentSourceId] || sources[0];
    if (!src) return;
    if (currentMedia.mediaType === 'movie') {
      setIframe(buildUrl(src.movie, { id: currentMedia.id }));
    } else {
      const season = seasonSelect.value;
      const episode = episodeSelect.value;
      if (!season || !episode || Number.isNaN(Number(season)) || Number.isNaN(Number(episode))) return;
      setIframe(buildUrl(src.tv, { id: currentMedia.id, season, episode }));
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
  playEpisodeBtn.addEventListener('click', playCurrent);

  // Switch streaming source and reload the current title.
  sourceSelect.addEventListener('change', () => {
    currentSourceId = sourceSelect.value;
    try { localStorage.setItem('ss_source', currentSourceId); } catch (_) { /* ignore */ }
    playCurrent();
  });

  // --- modal ---------------------------------------------------------------
  function setIframe(src) {
    if (!src) {
      iframe.removeAttribute('src');
      playerLoading.style.display = 'flex';
      playerLoading.textContent = 'Select a season & episode, then press Play.';
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

  // --- fullscreen (with vendor prefixes) -----------------------------------
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
    if (p && typeof p.catch === 'function') p.catch(() => {}); // swallow rejections
    return true;
  }

  fullscreenBtn.addEventListener('click', () => {
    if (fsElement()) { exitFS(); return; }
    // Prefer the player container; fall back to the iframe element itself.
    let p = null;
    try { p = requestFS(playerFrame); } catch (_) { p = null; }
    if (p && typeof p.catch === 'function') {
      p.catch(() => tryFS(iframe));
    } else if (!p) {
      tryFS(iframe);
    }
  });

  function updateFsLabel() {
    fullscreenBtn.textContent = fsElement() ? '⤢ Exit fullscreen' : '⛶ Fullscreen';
  }
  document.addEventListener('fullscreenchange', updateFsLabel);
  document.addEventListener('webkitfullscreenchange', updateFsLabel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden') && !fsElement()) {
      closeModal();
    }
  });

  // --- go ------------------------------------------------------------------
  init();
})();
