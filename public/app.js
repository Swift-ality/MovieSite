/* StreamSearch frontend */
(() => {
  'use strict';

  let playerBaseUrl = 'https://111movies.net';

  const $ = (sel) => document.querySelector(sel);
  const searchInput = $('#search');
  const resultsEl = $('#results');
  const statusEl = $('#status');

  const modal = $('#player-modal');
  const modalTitle = $('#modal-title');
  const tvControls = $('#tv-controls');
  const seasonSelect = $('#season-select');
  const episodeSelect = $('#episode-select');
  const playEpisodeBtn = $('#play-episode');
  const iframe = $('#player');
  const playerLoading = $('#player-loading');

  let currentTvId = null;

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

  async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // --- config --------------------------------------------------------------
  async function loadConfig() {
    try {
      const cfg = await getJson('/api/config');
      if (cfg.playerBaseUrl) playerBaseUrl = cfg.playerBaseUrl;
      if (!cfg.hasApiKey) {
        setStatus('⚠️ The server has no TMDB API key configured. Set <b>TMDB_API_KEY</b> and restart.', true);
      }
    } catch (_) {
      /* non-fatal */
    }
  }

  // --- search --------------------------------------------------------------
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 350);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      doSearch();
    }
  });

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) {
      resultsEl.innerHTML = '';
      setStatus('');
      return;
    }
    setStatus('<span class="spinner"></span> Searching…');
    try {
      const data = await getJson('/api/search?q=' + encodeURIComponent(q));
      renderResults(data.results || []);
    } catch (err) {
      setStatus('❌ ' + escapeHtml(err.message), true);
    }
  }

  function renderResults(results) {
    if (!results.length) {
      resultsEl.innerHTML = '';
      setStatus('No results found.');
      return;
    }
    setStatus(`${results.length} result${results.length === 1 ? '' : 's'}`);
    resultsEl.innerHTML = '';

    for (const item of results) {
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
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      resultsEl.appendChild(card);
    }
  }

  // --- opening / playback --------------------------------------------------
  function openItem(item) {
    modalTitle.textContent = item.title + (item.year ? ` (${item.year})` : '');
    if (item.mediaType === 'movie') {
      tvControls.classList.add('hidden');
      currentTvId = null;
      openModal();
      setIframe(`${playerBaseUrl}/movie/${item.id}`);
    } else {
      currentTvId = item.id;
      tvControls.classList.remove('hidden');
      openModal();
      setIframe(''); // wait until a season/episode is chosen
      loadSeasons(item.id);
    }
  }

  async function loadSeasons(id) {
    seasonSelect.innerHTML = '<option>Loading…</option>';
    episodeSelect.innerHTML = '';
    try {
      const data = await getJson('/api/tv/' + encodeURIComponent(id));
      const seasons = (data.seasons || []).filter((s) => s.episodeCount > 0);
      if (!seasons.length) {
        seasonSelect.innerHTML = '<option>No seasons</option>';
        return;
      }
      seasonSelect.innerHTML = seasons
        .map((s) => `<option value="${s.seasonNumber}">${escapeHtml(s.name)}</option>`)
        .join('');

      // Prefer the first "real" season (skip specials / season 0) when possible.
      const firstReal = seasons.find((s) => s.seasonNumber >= 1) || seasons[0];
      seasonSelect.value = String(firstReal.seasonNumber);

      await loadEpisodes(id, firstReal.seasonNumber, true);
    } catch (err) {
      seasonSelect.innerHTML = '<option>Error</option>';
      setStatus('❌ ' + escapeHtml(err.message), true);
    }
  }

  async function loadEpisodes(id, season, autoplayFirst = false) {
    episodeSelect.innerHTML = '<option>Loading…</option>';
    try {
      const data = await getJson(`/api/tv/${encodeURIComponent(id)}/season/${encodeURIComponent(season)}`);
      const eps = data.episodes || [];
      if (!eps.length) {
        episodeSelect.innerHTML = '<option>No episodes</option>';
        return;
      }
      episodeSelect.innerHTML = eps
        .map((e) => `<option value="${e.episodeNumber}">E${e.episodeNumber} · ${escapeHtml(e.name)}</option>`)
        .join('');
      episodeSelect.value = String(eps[0].episodeNumber);
      if (autoplayFirst) playCurrentEpisode();
    } catch (err) {
      episodeSelect.innerHTML = '<option>Error</option>';
      setStatus('❌ ' + escapeHtml(err.message), true);
    }
  }

  function playCurrentEpisode() {
    if (!currentTvId) return;
    const season = seasonSelect.value;
    const episode = episodeSelect.value;
    if (!season || !episode || Number.isNaN(Number(season)) || Number.isNaN(Number(episode))) return;
    setIframe(`${playerBaseUrl}/tv/${currentTvId}/${season}/${episode}`);
  }

  seasonSelect.addEventListener('change', () => {
    if (currentTvId) loadEpisodes(currentTvId, seasonSelect.value, false);
  });
  playEpisodeBtn.addEventListener('click', playCurrentEpisode);

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
  }

  function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    iframe.removeAttribute('src'); // stop playback
    currentTvId = null;
  }

  modal.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });

  // --- init ----------------------------------------------------------------
  loadConfig();
})();
