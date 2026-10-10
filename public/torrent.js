/* SwiftWatchesMovies — torrent player (the "⚡ Torrent" server).
 *
 * Finds torrents for the open title via the server, starts the best one, and
 * plays it while the server downloads it. Files the browser can decode play
 * directly with byte-range seeking; everything else is remuxed/transcoded by
 * the server into fragmented MP4, so seeking restarts the stream at the new
 * time (this.offset tracks where the current stream started).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const LANG3 = {
    eng: 'en', jpn: 'ja', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', dut: 'nl', nld: 'nl',
    ita: 'it', por: 'pt', rus: 'ru', chi: 'zh', zho: 'zh', kor: 'ko', ara: 'ar', pol: 'pl', tur: 'tr',
    swe: 'sv', dan: 'da', nor: 'no', nob: 'no', fin: 'fi', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id',
    may: 'ms', msa: 'ms', heb: 'he', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro',
    ron: 'ro', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', slo: 'sk', slk: 'sk', est: 'et',
    lav: 'lv', lit: 'lt', per: 'fa', fas: 'fa', ben: 'bn', tam: 'ta', tel: 'te', fil: 'fil',
  };
  const lang2 = (l) => {
    const s = String(l || '').toLowerCase().split(/[-_]/)[0];
    if (!s || s === 'und') return '';
    return LANG3[s] || (s.length === 2 ? s : '');
  };
  let displayNames = null;
  try { displayNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (_) { /* old browser */ }
  const langName = (l) => {
    const c = lang2(l);
    if (!c) return '';
    try { return (displayNames && displayNames.of(c)) || c.toUpperCase(); } catch (_) { return c.toUpperCase(); }
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtTime(sec) {
    const t = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return '?';
    if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1)} GB`;
    if (n >= 2 ** 20) return `${Math.round(n / 2 ** 20)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }
  const fmtSpeed = (n) => (n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB/s` : `${Math.round((n || 0) / 1024)} KB/s`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJson(url, opts = {}) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // What this browser can decode, sent to the server so it can rank streams and
  // decide between direct play / remux / transcode.
  function detectCaps() {
    const v = document.createElement('video');
    const can = (t) => { try { return v.canPlayType(t) !== ''; } catch (_) { return false; } };
    const ms = (t) => { try { return Boolean(window.MediaSource && MediaSource.isTypeSupported(t)); } catch (_) { return false; } };
    const caps = [];
    if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || ms('video/mp4; codecs="hvc1.1.6.L120.90"')) caps.push('hevc');
    if (can('video/mp4; codecs="av01.0.08M.08"')) caps.push('av1');
    if (can('video/webm; codecs="vp9"')) caps.push('vp9');
    if (can('audio/mp4; codecs="ac-3"')) caps.push('ac3');
    if (can('audio/mp4; codecs="ec-3"')) caps.push('eac3');
    if (can('audio/mp4; codecs="opus"')) caps.push('opus');
    if (can('audio/mp4; codecs="flac"')) caps.push('flac');
    return caps.join(',');
  }

  // Small per-browser preferences: chosen subtitle language, volume, and the
  // last torrent/release group used per show (so the next episode prefers the
  // same season pack and stays instant).
  const PREF_KEY = 'sw_torrent_pref_v1';
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      return p && typeof p === 'object' ? p : {};
    } catch (_) { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (_) { /* ignore */ }
  }

  // Streaming WebVTT parser: feed text chunks, get cues as soon as each block completes.
  function vttParser(onCue) {
    let buf = '';
    const toSec = (ts) => {
      const p = ts.trim().split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    const block = (b) => {
      const lines = b.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) return;
      const m = /([\d:.]+)\s+-->\s+([\d:.]+)/.exec(lines[i]);
      if (!m) return;
      const text = lines.slice(i + 1).join('\n').trim();
      if (text) onCue(toSec(m[1]), toSec(m[2]), text);
    };
    return {
      push(chunk) {
        buf += chunk.replace(/\r\n?/g, '\n');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          block(buf.slice(0, at));
          buf = buf.slice(at + 2);
        }
      },
      end() { if (buf.trim()) block(buf); buf = ''; },
    };
  }

  // -------------------------------------------------------------- the player
  function create(container, hooks = {}) {
    const caps = detectCaps();
    const prefs = loadPrefs();

    const root = document.createElement('div');
    root.className = 'tp hidden';
    root.innerHTML = `
      <video class="tp-video" playsinline preload="auto"></video>
      <div class="tp-status">
        <div class="tp-card">
          <div class="tp-spin"></div>
          <div class="tp-title"></div>
          <div class="tp-sub"></div>
          <div class="tp-actions"></div>
        </div>
      </div>
      <div class="tp-pick hidden">
        <div class="tp-pick-card">
          <div class="tp-pick-head">
            <div class="tp-pick-kicker">⚡ Swift Servers</div>
            <div class="tp-pick-title"></div>
            <div class="tp-pick-meta"></div>
            <div class="tp-pick-msg hidden"></div>
            <div class="tp-pick-actions">
              <button type="button" class="tp-btn primary" data-act="best">▶ Play best match</button>
              <label class="tp-check"><input type="checkbox" class="tp-auto"> Always auto-play the best torrent</label>
            </div>
          </div>
          <div class="tp-pick-list" role="list"></div>
        </div>
      </div>
      <div class="tp-wait hidden"><div class="tp-spin"></div><div class="tp-wait-text"></div></div>
      <div class="tp-upnext hidden">
        <div class="tp-upnext-label"></div>
        <div class="tp-upnext-actions">
          <button type="button" class="tp-btn primary" data-act="upnext-go">▶ Play now</button>
          <button type="button" class="tp-btn" data-act="upnext-cancel">Cancel</button>
        </div>
      </div>
      <div class="tp-bar">
        <div class="tp-seek" role="slider" aria-label="Seek" tabindex="0">
          <canvas class="tp-dl" width="80" height="1"></canvas>
          <div class="tp-buf"></div>
          <div class="tp-played"></div>
          <div class="tp-knob"></div>
          <div class="tp-tip hidden"></div>
        </div>
        <div class="tp-row">
          <button type="button" class="tp-ic" data-act="play" title="Play (k)">▶</button>
          <button type="button" class="tp-ic" data-act="back" title="Back 10s (←)">↺</button>
          <button type="button" class="tp-ic" data-act="fwd" title="Forward 10s (→)">↻</button>
          <button type="button" class="tp-ic" data-act="mute" title="Mute (m)">🔊</button>
          <input class="tp-vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
          <span class="tp-time">0:00 / 0:00</span>
          <span class="tp-stats"></span>
          <span class="tp-grow"></span>
          <button type="button" class="tp-txt" data-act="subs" title="Subtitles (c)">CC</button>
          <button type="button" class="tp-txt hidden" data-act="audio" title="Audio track">Audio</button>
          <button type="button" class="tp-txt" data-act="streams" title="Pick another torrent / download">⚡ Torrents</button>
          <button type="button" class="tp-ic" data-act="fs" title="Fullscreen (f)">⛶</button>
        </div>
      </div>
      <div class="tp-menu hidden" role="menu"></div>
      <aside class="tp-panel hidden" aria-label="Torrents">
        <div class="tp-panel-head">
          <div><b>Torrents</b><div class="tp-panel-meta"></div></div>
          <button type="button" class="tp-ic" data-act="panel-close" aria-label="Close">✕</button>
        </div>
        <div class="tp-panel-list"></div>
      </aside>`;
    container.appendChild(root);

    const $ = (sel) => root.querySelector(sel);
    const video = $('.tp-video');
    const statusEl = $('.tp-status');
    const statusTitle = $('.tp-title');
    const statusSub = $('.tp-sub');
    const statusActions = $('.tp-actions');
    const statusSpin = $('.tp-card .tp-spin');
    const waitEl = $('.tp-wait');
    const waitText = $('.tp-wait-text');
    const bar = $('.tp-bar');
    const seekEl = $('.tp-seek');
    const dlCanvas = $('.tp-dl');
    const bufEl = $('.tp-buf');
    const playedEl = $('.tp-played');
    const knobEl = $('.tp-knob');
    const tipEl = $('.tp-tip');
    const timeEl = $('.tp-time');
    const statsEl = $('.tp-stats');
    const volEl = $('.tp-vol');
    const menuEl = $('.tp-menu');
    const panel = $('.tp-panel');
    const panelList = $('.tp-panel-list');
    const panelMeta = $('.tp-panel-meta');
    const upNextEl = $('.tp-upnext');
    const pickEl = $('.tp-pick');
    const pickTitle = $('.tp-pick-title');
    const pickMeta = $('.tp-pick-meta');
    const pickMsg = $('.tp-pick-msg');
    const pickList = $('.tp-pick-list');
    const autoBox = $('.tp-auto');
    const btn = (act) => root.querySelector(`[data-act="${act}"]`);
    autoBox.checked = Boolean(prefs.autoPlay);

    // Subtitles are drawn in our own layer (.tp-subs) from the track's active
    // cues instead of by the browser: native cue rendering doesn't reliably show
    // when the player container (rather than the <video>) is fullscreen, and our
    // layer can move up above the control bar.
    const subsEl = document.createElement('div');
    subsEl.className = 'tp-subs';
    subsEl.setAttribute('aria-hidden', 'true');
    video.insertAdjacentElement('afterend', subsEl);
    const subTrack = video.addTextTrack('subtitles', 'Subtitles');
    subTrack.mode = 'hidden';                   // still fires cuechange; we render
    const cueHtml = (t) => esc(t).replace(/&lt;(\/?)([biu])&gt;/g, '<$1$2>').replace(/\n/g, '<br>');
    function renderSubs() {
      const active = subTrack.activeCues ? [...subTrack.activeCues] : [];
      subsEl.innerHTML = active.map((c) => `<span>${cueHtml(c.text)}</span>`).join('<br>');
    }
    subTrack.addEventListener('cuechange', renderSubs);

    const S = {
      req: null,
      searchCtrl: null,
      streams: [],
      providers: [],
      hidden: 0,
      idx: -1,
      failed: new Set(),
      autoMode: false,     // started by auto-play / "Play best": failures move on to the next torrent
      autoTries: 0,
      dlText: new Map(),   // stream token -> download status line
      attempt: 0,          // bumps per stream attempt; stale polls/fetches are dropped
      videoSeq: 0,         // bumps per (re)start of the video element's source
      hash: null,
      fileHint: null,
      fileIdx: null,
      status: null,
      pb: null,            // playback plan from the server
      mode: null,          // direct | remux | transcode | url
      offset: 0,           // remux/transcode: file time where the current stream starts
      duration: 0,
      audioIndex: null,
      pendingAt: 0,
      startedAt: 0,
      playing: false,
      everPlayed: false,
      restarts: 0,
      sub: null,           // selected subtitle option
      subCtrl: null,
      subFrom: 0,
      lastProgress: 0,
      pollTimer: null,
      stallTimer: null,
      upNextTimer: null,
      seekDrag: false,
    };

    // ------------------------------------------------------------ status UI
    function show() { root.classList.remove('hidden'); }
    function setStatus(title, sub = '', actions = [], spinning = true) {
      pickEl.classList.add('hidden');
      statusEl.classList.remove('hidden');
      statusTitle.textContent = title;
      statusSub.innerHTML = sub;
      statusSpin.classList.toggle('hidden', !spinning);
      statusActions.innerHTML = actions.map((a) =>
        `<button type="button" class="tp-btn${a.primary ? ' primary' : ''}" data-act="${a.act}">${esc(a.label)}</button>`).join('');
      waitEl.classList.add('hidden');
    }
    function hideStatus() { statusEl.classList.add('hidden'); }
    function setWaiting(on, text = '') {
      waitEl.classList.toggle('hidden', !on || !statusEl.classList.contains('hidden'));
      waitText.textContent = text;
    }
    function streamLine(st) {
      if (!st) return '';
      const bits = [st.quality, ...(st.tags || []).slice(0, 3)];
      const meta = [st.size ? fmtBytes(st.size) : '', st.seeders != null ? `👤 ${st.seeders}` : '', st.provider].filter(Boolean);
      return `${esc(bits.filter(Boolean).join(' · '))}<br><span class="tp-dim">${esc(meta.join(' · '))}</span>`;
    }
    function toast(msg) { if (hooks.toast) hooks.toast(msg); }
    const skipAction = () => (S.autoMode ? { act: 'next', label: 'Skip →' } : { act: 'next', label: '← Choose another' });

    // --------------------------------------------------------------- flow
    function reqQuery(extra = {}, r = S.req) {
      const q = new URLSearchParams({ kind: r.kind, id: r.id, caps });
      if (r.season != null) q.set('s', r.season);
      if (r.episode != null) q.set('e', r.episode);
      for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
      return q;
    }

    async function play(req) {
      stop({ keepVisible: true });
      S.req = req;
      S.pendingAt = req.at > 0 ? req.at : 0;
      show();
      setStatus('Searching Swift Servers…', esc(req.label || ''));
      const ctrl = new AbortController();
      S.searchCtrl = ctrl;
      const pref = (prefs.shows || {})[req.titleKey] || {};
      let data;
      try {
        const prefer = { ph: pref.hash, pg: pref.group, pr: pref.res };
        data = await getJson(`/api/torrents/search?${reqQuery(prefer)}`, { signal: ctrl.signal });
        if (data.client && data.client.length) {
          // Some addons (Torrentio, for one) refuse the server's datacenter IP but
          // answer viewers' browsers, the way the Stremio app uses them. Ask them
          // from here and let the server merge, rank and sign the results.
          setStatus('Searching Swift Servers…', esc(`${req.label || ''} — asking ${data.client.map((c) => c.name).join(', ')}`));
          const sources = await Promise.all(data.client.map(async (c) => {
            const t = new AbortController();
            const timer = setTimeout(() => t.abort(), 15000);
            const stop = () => t.abort();
            ctrl.signal.addEventListener('abort', stop);
            try {
              const r = await fetch(c.url, { signal: t.signal });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const j = await r.json();
              return { base: c.base, streams: Array.isArray(j.streams) ? j.streams.slice(0, 200) : [] };
            } catch (err) {
              return { base: c.base, error: ctrl.signal.aborted ? 'cancelled' : (t.signal.aborted ? 'timed out' : err.message) };
            } finally {
              clearTimeout(timer);
              ctrl.signal.removeEventListener('abort', stop);
            }
          }));
          if (ctrl.signal.aborted) return;
          const body = Object.fromEntries(reqQuery(prefer));
          body.sources = sources;
          data = await getJson('/api/torrents/rank', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setStatus('Couldn\'t search for torrents', esc(err.message), [{ act: 'retry', label: '↻ Retry', primary: true }], false);
        return;
      }
      if (ctrl.signal.aborted || S.req !== req) return;
      S.searchCtrl = null;
      S.streams = data.streams || [];
      S.providers = data.providers || [];
      S.hidden = data.hidden || 0;
      renderPanel();
      if (!S.streams.length) {
        const down = S.providers.filter((p) => !p.ok);
        const why = down.length && down.length === S.providers.length
          ? `Couldn't reach the torrent sources: ${down.map((p) => `${p.name} (${p.error})`).join(', ')}.`
          : 'None of the torrent sources had this title' + (req.episode != null ? ' / episode' : '') + '.';
        setStatus('No torrents found', `${esc(why)}<br>Try another server from the <b>Server</b> menu.`,
          [{ act: 'retry', label: '↻ Search again' }], false);
        return;
      }
      // Pick automatically when asked to, or when picking up where you left off
      // (resume / next episode) with the torrent you chose before; otherwise you choose.
      const same = pref.hash ? S.streams.findIndex((s) => s.hash === pref.hash) : -1;
      const sameGroup = req.binge && pref.group && S.streams[0].group === pref.group;
      if (prefs.autoPlay) startStream(0, { auto: true });
      else if (same >= 0 && (S.pendingAt > 0 || req.binge)) startStream(same);
      else if (sameGroup) startStream(0, { auto: true });
      else showPicker();
    }

    function showPicker(message = '') {
      S.attempt += 1;                                // stop anything still loading
      clearTimeout(S.pollTimer);
      statusEl.classList.add('hidden');
      waitEl.classList.add('hidden');
      closeMenu();
      closePanel();
      const r = S.req || {};
      pickTitle.textContent = r.label || 'Choose a torrent';
      pickMsg.textContent = message;
      pickMsg.classList.toggle('hidden', !message);
      renderPanel();
      pickEl.classList.remove('hidden');
      const first = pickList.querySelector('.tp-stream:not(.bad) .tp-watch');
      if (first) first.focus({ preventScroll: true });
    }

    async function startStream(i, { auto = false, keepTime = false } = {}) {
      const st = S.streams[i];
      if (!st) return;
      if (keepTime && S.everPlayed) S.pendingAt = currentTime();
      const prevHash = S.hash;
      const att = ++S.attempt;
      resetVideo();
      pickEl.classList.add('hidden');
      S.autoMode = auto;
      S.idx = i;
      S.hash = null;
      S.fileIdx = null;
      S.fileHint = null;
      S.pb = null;
      S.status = null;
      S.restarts = 0;
      S.startedAt = Date.now();
      if (!auto) S.autoTries = 0;
      renderPanel();
      if (prevHash && prevHash !== st.hash) release(prevHash);

      if (st.url) {                                   // direct link (e.g. a debrid addon)
        S.mode = 'url';
        S.pb = { mode: 'url', url: st.url, audio: [], subs: [], duration: 0 };
        setupMenus();
        setStatus('Loading stream…', streamLine(st));
        startVideo(S.pendingAt);
        return;
      }

      setStatus(`Starting stream ${i + 1} of ${S.streams.length}…`, streamLine(st));
      let r;
      try {
        r = await getJson('/api/torrent/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ t: st.t }),
        });
      } catch (err) {
        if (att !== S.attempt) return;
        if (err.data && err.data.expired && S.req) { play(S.req); return; }   // server restarted: search again
        if (err.status === 503) {
          setStatus('Server busy', esc(err.message), [{ act: 'retry-stream', label: '↻ Try again', primary: true }], false);
          return;
        }
        failStream(err.message);
        return;
      }
      if (att !== S.attempt) { release(r.hash); return; }
      S.hash = r.hash;
      S.fileHint = r.fileIdx;
      poll(att);
    }

    function schedulePoll(att, ms) {
      clearTimeout(S.pollTimer);
      S.pollTimer = setTimeout(() => poll(att), ms);
    }

    async function poll(att) {
      if (att !== S.attempt || !S.hash) return;
      const extra = { a: S.audioIndex };
      if (S.fileIdx != null) extra.file = S.fileIdx;
      else extra.fi = S.fileHint;
      let st;
      try {
        st = await getJson(`/api/torrent/${S.hash}/status?${reqQuery(extra)}`);
      } catch (err) {
        if (att !== S.attempt) return;
        if (err.status === 404) { failStream('The server dropped this torrent.'); return; }
        schedulePoll(att, 3000);                     // network blip: keep trying
        return;
      }
      if (att !== S.attempt) return;
      S.status = st;
      updateStats();
      const cur = S.streams[S.idx];

      if (st.state === 'error') { failStream(st.error || 'Torrent failed.'); return; }
      if (st.state !== 'ready') {
        const waited = Date.now() - S.startedAt;
        if (!st.peers && waited > 30000) { failStream('No peers found.'); return; }
        setStatus(st.peers ? `Connecting… ${st.peers} peer${st.peers === 1 ? '' : 's'}` : 'Looking for peers…',
          streamLine(cur), [skipAction()]);
        schedulePoll(att, 1000);
        return;
      }
      if (!st.file) {
        if (st.files && st.files.length && !hasNextStream()) { showFilePicker(st); return; }
        failStream(st.choice || 'No playable video in this torrent.');
        return;
      }
      S.fileIdx = st.file.i;
      if (st.probing) {
        setStatus('Reading video info…',
          `${esc(st.file.name)}<br><span class="tp-dim">${fmtBytes(st.file.done)} of ${fmtBytes(st.file.size)} · ${st.peers} peers · ${fmtSpeed(st.down)}</span>`,
          [skipAction()]);
        schedulePoll(att, 1000);
        return;
      }
      if (!S.pb && st.playback) {
        const pb = st.playback;
        if (pb.mode === 'error' || pb.mode === 'unsupported') { failStream(pb.reason || 'Can\'t play this file.'); return; }
        S.pb = pb;
        S.mode = pb.mode;
        S.duration = pb.duration || 0;
        S.audioIndex = pb.audioIndex;
        rememberChoice();
        setupMenus();
        startVideo(S.pendingAt);
        pickDefaultSubs();
      }
      schedulePoll(att, S.playing ? 3000 : 1500);
    }

    function hasNextStream() {
      return S.streams.some((s, j) => j !== S.idx && !S.failed.has(j));
    }
    function nextStreamIndex() {
      for (let j = S.idx + 1; j < S.streams.length; j++) if (!S.failed.has(j)) return j;
      for (let j = 0; j < S.idx; j++) if (!S.failed.has(j)) return j;
      return -1;
    }

    function failStream(reason) {
      S.attempt += 1;                                // stop polling the failed one
      clearTimeout(S.pollTimer);
      const wasPlaying = S.everPlayed;
      if (wasPlaying) S.pendingAt = currentTime();   // a replacement stream continues from here
      if (S.hash) release(S.hash);
      S.hash = null;
      resetVideo();
      S.failed.add(S.idx);
      renderPanel();
      const next = nextStreamIndex();
      if (S.autoMode && next >= 0 && S.autoTries < 4 && !wasPlaying) {
        S.autoTries += 1;
        toast(`Torrent ${S.idx + 1} didn't work (${reason}) — trying the next one`);
        startStream(next, { auto: true });
        return;
      }
      // you picked this one: back to the list so you can choose another
      showPicker(`That torrent didn't work: ${reason}`);
    }

    function showFilePicker(st) {
      const list = st.files.map((f) =>
        `<button type="button" class="tp-file" data-file="${f.i}">${esc(f.name)} <span class="tp-dim">${fmtBytes(f.size)}</span></button>`).join('');
      setStatus('Which file should play?', `${esc(st.choice || '')}<div class="tp-files">${list}</div>`, [], false);
    }

    // ------------------------------------------------------------- video
    const streamed = () => S.mode === 'remux' || S.mode === 'transcode';
    function currentTime() { return streamed() ? S.offset + (video.currentTime || 0) : (video.currentTime || 0); }
    function duration() {
      if (S.duration > 0) return S.duration;
      return Number.isFinite(video.duration) && !streamed() ? video.duration : 0;
    }
    function playUrl(t) {
      const q = new URLSearchParams({ t: t.toFixed(3), caps });
      if (S.audioIndex != null) q.set('a', S.audioIndex);
      const base = S.mode === 'transcode' ? S.pb.url.replace(/m=remux/, 'm=transcode') : S.pb.url;
      return `${base}&${q}`;
    }

    function resetVideo() {
      clearTimeout(S.stallTimer);
      cancelSubs();
      root.classList.remove('tp-ready');
      S.playing = false;
      S.everPlayed = false;
      try { video.pause(); } catch (_) { /* ignore */ }
      video.removeAttribute('src');
      try { video.load(); } catch (_) { /* ignore */ }
      setWaiting(false);
      updatePlayButton();
    }

    async function startVideo(at) {
      const att = S.attempt;
      const seq = ++S.videoSeq;                      // a newer seek wins over an older one
      const midPlay = S.everPlayed;
      at = Math.max(0, at || 0);
      const dur = duration();
      if (dur && at > dur - 5) at = 0;
      root.classList.add('tp-ready');
      if (S.mode === 'direct' || S.mode === 'url') {
        S.offset = 0;
        video.src = S.pb.url;
        if (at > 0) {
          video.addEventListener('loadedmetadata', function seekOnce() {
            video.removeEventListener('loadedmetadata', seekOnce);
            try { video.currentTime = at; } catch (_) { /* ignore */ }
          });
        }
      } else {
        if (at > 0 && S.mode === 'remux') {
          if (midPlay) setWaiting(true, `Seeking to ${fmtTime(at)}…`);
          else setStatus('Seeking…', `Jumping to ${fmtTime(at)}`, [], true);
          try {
            const k = await getJson(`/api/torrent/${S.hash}/${S.fileIdx}/keyframe?t=${at.toFixed(3)}`);
            if (att !== S.attempt || seq !== S.videoSeq) return;
            at = Math.max(0, Number(k.t) || at) + (k.exact ? 0.001 : 0);
          } catch (_) { /* fall back to the approximate time */ }
        }
        if (att !== S.attempt || seq !== S.videoSeq) return;
        S.offset = at;
        video.src = playUrl(at);
      }
      if (midPlay) setWaiting(true, 'Buffering…');
      else {
        setStatus(at > 0 ? `Resuming at ${fmtTime(at)}…` : 'Starting playback…', streamLine(S.streams[S.idx]),
          [skipAction()]);
      }
      loadSubs(at);
      video.play().catch(() => {
        // autoplay blocked: show a play button instead of the spinner
        if (att === S.attempt && !S.playing) {
          setStatus('Ready', 'Press play to start.', [{ act: 'play', label: '▶ Play', primary: true }], false);
        }
      });
    }

    function seekTo(t) {
      if (!S.pb) return;
      const dur = duration();
      t = Math.max(0, Math.min(dur ? dur - 1 : t, t));
      clearUpNext();
      if (S.mode === 'direct' || S.mode === 'url') {
        video.currentTime = t;
        if (S.sub && S.sub.kind === 'embedded' && (t < S.subFrom || t > S.subFrom + 60)) loadSubs(t);
        return;
      }
      // still inside what this stream already buffered? then seek natively
      const rel = t - S.offset;
      for (let i = 0; i < video.buffered.length; i++) {
        if (rel >= video.buffered.start(i) && rel <= video.buffered.end(i) - 0.5) { video.currentTime = rel; return; }
      }
      const wasPaused = video.paused && S.everPlayed;
      startVideo(t).then(() => { if (wasPaused) video.pause(); });
    }

    function togglePlay() {
      if (!S.pb) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    video.addEventListener('playing', () => {
      S.playing = true;
      S.everPlayed = true;
      S.autoTries = 0;
      clearTimeout(S.stallTimer);
      hideStatus();
      setWaiting(false);
      updatePlayButton();
      kickControls();
    });
    video.addEventListener('pause', () => { S.playing = false; updatePlayButton(); showControls(); reportProgress(true); });
    video.addEventListener('play', updatePlayButton);
    video.addEventListener('waiting', () => {
      if (!S.everPlayed) return;
      setWaiting(true, 'Buffering…');
      clearTimeout(S.stallTimer);
      S.stallTimer = setTimeout(() => {
        const st = S.status;
        setWaiting(true, `Still buffering… ${st ? `${st.peers} peers · ${fmtSpeed(st.down)}` : ''}`);
      }, 8000);
    });
    video.addEventListener('canplay', () => { if (S.everPlayed) { clearTimeout(S.stallTimer); setWaiting(false); } });
    video.addEventListener('seeked', () => { if (S.everPlayed && video.readyState >= 3) setWaiting(false); });
    video.addEventListener('timeupdate', () => { updateTimeUI(); reportProgress(false); });
    video.addEventListener('volumechange', () => {
      volEl.value = video.muted ? 0 : video.volume;
      btn('mute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
      prefs.volume = video.volume;
      prefs.muted = video.muted;
      savePrefs(prefs);
    });
    video.addEventListener('ended', () => {
      const dur = duration();
      const t = currentTime();
      if (streamed() && dur && t < dur - 30 && S.restarts < 3) {
        S.restarts += 1;                               // the converter stopped early: pick up where it ended
        startVideo(t);
        return;
      }
      reportProgress(true);
      updatePlayButton();
      if (hooks.onEnded) hooks.onEnded();
    });
    video.addEventListener('error', () => {
      if (!S.pb || !video.getAttribute('src')) return;
      const err = video.error;
      const t = currentTime();
      if (S.mode === 'direct') {                     // can't decode after all: let the server convert it
        S.mode = 'remux';
        S.pb = { ...S.pb, url: S.pb.url.replace(/\/raw$/, '/play?m=remux') };
        toast('Converting this file for your browser…');
        startVideo(S.everPlayed ? t : S.pendingAt);
        return;
      }
      if (S.mode === 'remux' && S.pb.video && S.pb.video.codec !== 'h264' && hooks.canTranscode && hooks.canTranscode()) {
        S.mode = 'transcode';                        // e.g. HEVC the browser claimed but couldn't decode
        toast('Re-encoding the video for your browser…');
        startVideo(S.everPlayed ? t : S.pendingAt);
        return;
      }
      if (streamed() && S.everPlayed && S.restarts < 3) {
        S.restarts += 1;
        startVideo(t);
        return;
      }
      failStream(err && err.message ? err.message : 'The browser couldn\'t play this file.');
    });

    function reportProgress(force) {
      if (!hooks.onProgress || !S.everPlayed) return;
      const now = Date.now();
      if (!force && now - S.lastProgress < 5000) return;
      S.lastProgress = now;
      const dur = duration();
      if (dur > 0) hooks.onProgress(currentTime(), dur);
    }

    // ------------------------------------------------------------ controls UI
    function updatePlayButton() {
      btn('play').textContent = video.paused || !S.pb ? '▶' : '❚❚';
    }
    function updateTimeUI() {
      const dur = duration();
      const t = currentTime();
      timeEl.textContent = `${fmtTime(t)} / ${dur ? fmtTime(dur) : '--:--'}`;
      if (S.seekDrag) return;
      const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
      playedEl.style.width = `${pct}%`;
      knobEl.style.left = `${pct}%`;
      // buffered range around the play head
      let bufEnd = t;
      for (let i = 0; i < video.buffered.length; i++) {
        const s = video.buffered.start(i), e = video.buffered.end(i);
        const rel = streamed() ? t - S.offset : t;
        if (rel >= s - 1 && rel <= e + 1) bufEnd = (streamed() ? S.offset : 0) + e;
      }
      bufEl.style.left = `${pct}%`;
      bufEl.style.width = `${dur ? Math.max(0, Math.min(100, (bufEnd / dur) * 100) - pct) : 0}%`;
    }
    function updateStats() {
      const st = S.status;
      if (!st) { statsEl.textContent = ''; return; }
      const parts = [`↓ ${fmtSpeed(st.down)}`, `${st.peers} peer${st.peers === 1 ? '' : 's'}`];
      if (st.file) parts.push(`${Math.floor((st.file.progress || 0) * 100)}%`);
      statsEl.textContent = parts.join(' · ');
      const map = st.file && st.file.map;
      if (map) {
        if (dlCanvas.width !== map.length) dlCanvas.width = map.length;
        const g = dlCanvas.getContext('2d');
        g.clearRect(0, 0, dlCanvas.width, 1);
        for (let i = 0; i < map.length; i++) {
          const v = Number(map[i]) / 9;
          if (v > 0) { g.fillStyle = `rgba(255,255,255,${(0.12 + 0.3 * v).toFixed(2)})`; g.fillRect(i, 0, 1, 1); }
        }
      }
    }

    let hideTimer = null;
    function showControls() {
      root.classList.add('tp-show');
      root.classList.remove('tp-idle');
    }
    function kickControls() {
      showControls();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (S.playing && menuEl.classList.contains('hidden') && panel.classList.contains('hidden') && !bar.matches(':hover')) {
          root.classList.remove('tp-show');
          root.classList.add('tp-idle');
        }
      }, 2800);
    }
    root.addEventListener('mousemove', kickControls);
    root.addEventListener('touchstart', kickControls, { passive: true });

    video.addEventListener('click', (ev) => {
      if (ev.pointerType === 'touch' && !root.classList.contains('tp-show')) { kickControls(); return; }
      togglePlay();
      kickControls();
    });
    video.addEventListener('dblclick', () => { if (hooks.toggleFullscreen) hooks.toggleFullscreen(); });

    // seek bar
    function seekFraction(ev) {
      const r = seekEl.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      return Math.max(0, Math.min(1, x / r.width));
    }
    function previewSeek(frac) {
      const dur = duration();
      playedEl.style.width = `${frac * 100}%`;
      knobEl.style.left = `${frac * 100}%`;
      tipEl.textContent = fmtTime(frac * dur);
      tipEl.style.left = `${frac * 100}%`;
      tipEl.classList.remove('hidden');
    }
    seekEl.addEventListener('pointerdown', (ev) => {
      if (!duration()) return;
      S.seekDrag = true;
      seekEl.setPointerCapture(ev.pointerId);
      previewSeek(seekFraction(ev));
    });
    seekEl.addEventListener('pointermove', (ev) => {
      if (!duration()) return;
      const f = seekFraction(ev);
      if (S.seekDrag) previewSeek(f);
      else { tipEl.textContent = fmtTime(f * duration()); tipEl.style.left = `${f * 100}%`; tipEl.classList.remove('hidden'); }
    });
    seekEl.addEventListener('pointerleave', () => { if (!S.seekDrag) tipEl.classList.add('hidden'); });
    seekEl.addEventListener('pointerup', (ev) => {
      if (!S.seekDrag) return;
      S.seekDrag = false;
      tipEl.classList.add('hidden');
      seekTo(seekFraction(ev) * duration());
    });
    seekEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); seekTo(currentTime() - 10); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); seekTo(currentTime() + 10); }
    });

    volEl.addEventListener('input', () => {
      video.volume = Number(volEl.value);
      video.muted = video.volume === 0;
    });
    if (typeof prefs.volume === 'number') video.volume = Math.max(0, Math.min(1, prefs.volume));
    if (prefs.muted) video.muted = true;
    volEl.value = video.muted ? 0 : video.volume;

    // ------------------------------------------------------- menus: subs/audio
    function subLabel(s) {
      const name = langName(s.lang) || (s.kind === 'file' ? '' : 'Unknown');
      const extra = s.title && !/^(english|eng|subs?|subtitles?)$/i.test(s.title) ? s.title : '';
      return [name, extra].filter(Boolean).join(' — ') + (s.forced ? ' (forced)' : '') + (s.kind === 'file' ? ' · file' : '');
    }
    function audioLabel(a) {
      const ch = a.channels ? (a.channels >= 6 ? ` ${a.channels - 1}.1` : a.channels === 2 ? ' stereo' : '') : '';
      return `${langName(a.lang) || 'Track'}${a.title ? ` — ${a.title}` : ''} · ${String(a.codec || '').toUpperCase()}${ch}`;
    }
    function setupMenus() {
      const pb = S.pb;
      btn('subs').classList.toggle('dim', !(pb && pb.subs && pb.subs.length));
      btn('audio').classList.toggle('hidden', !(pb && pb.audio && pb.audio.length > 1));
      btn('subs').classList.toggle('on', Boolean(S.sub));
    }
    function openMenu(kind) {
      const pb = S.pb;
      if (!pb) return;
      let html = '';
      if (kind === 'subs') {
        html += `<div class="tp-menu-h">Subtitles</div>`;
        html += `<button type="button" class="tp-mi${!S.sub ? ' sel' : ''}" data-sub="">Off</button>`;
        for (const s of pb.subs || []) {
          html += `<button type="button" class="tp-mi${S.sub && S.sub.id === s.id ? ' sel' : ''}" data-sub="${esc(s.id)}">${esc(subLabel(s))}</button>`;
        }
        if (!(pb.subs || []).length) html += `<div class="tp-menu-note">No text subtitles in this file.</div>`;
      } else {
        html += `<div class="tp-menu-h">Audio</div>`;
        for (const a of pb.audio || []) {
          html += `<button type="button" class="tp-mi${a.index === S.audioIndex ? ' sel' : ''}" data-audio="${a.index}">${esc(audioLabel(a))}</button>`;
        }
      }
      menuEl.innerHTML = html;
      menuEl.dataset.kind = kind;
      menuEl.classList.remove('hidden');
      showControls();
    }
    function closeMenu() { menuEl.classList.add('hidden'); }

    function pickDefaultSubs() {
      const pb = S.pb;
      const subs = (pb && pb.subs) || [];
      S.sub = null;
      if (subs.length && prefs.subs !== 'off') {
        const langs = [...new Set([prefs.subLang, ...(navigator.languages || [navigator.language || 'en']).map(lang2), 'en'].filter(Boolean))];
        const audio = (pb.audio || []).find((a) => a.index === S.audioIndex);
        const audioLang = audio ? lang2(audio.lang) : '';
        const anime = String(S.req.kind).startsWith('anime');
        // Full subtitles when the audio isn't in your language (anime: assume Japanese).
        const needFull = audioLang ? audioLang !== langs[0] : anime;
        const score = (s) => (s.default ? 2 : 0) + (/sign|song/i.test(s.title) ? -5 : 0) + (s.kind === 'embedded' ? 1 : 0);
        // never default to subtitles in the language being spoken (unless that's what you picked before)
        const wanted = langs.filter((l) => l !== audioLang || l === prefs.subLang);
        for (const l of needFull ? wanted : langs.slice(0, 1)) {
          if (!needFull && l !== langs[0]) break;
          const pool = subs.filter((s) => lang2(s.lang) === l && (needFull ? !s.forced : s.forced));
          if (pool.length) { S.sub = pool.sort((a, b) => score(b) - score(a))[0]; break; }
          if (!needFull) break;
        }
        if (!S.sub && needFull && anime) {
          const unknown = subs.filter((s) => !lang2(s.lang) && !s.forced);   // fansubs often leave the language unset
          if (unknown.length) S.sub = unknown.sort((a, b) => score(b) - score(a))[0];
        }
      }
      setupMenus();
      loadSubs(currentTime());
    }

    function cancelSubs() {
      if (S.subCtrl) S.subCtrl.abort();
      S.subCtrl = null;
      const cues = subTrack.cues;
      while (cues && cues.length) subTrack.removeCue(cues[0]);
      subsEl.innerHTML = '';
    }

    // Subtitle cue times are file times; shift them onto the current stream's clock.
    async function loadSubs(from) {
      cancelSubs();
      const sub = S.sub;
      if (!sub || !S.pb) return;
      const ctrl = new AbortController();
      S.subCtrl = ctrl;
      const t = Math.max(0, from || 0);
      S.subFrom = t;
      const url = sub.kind === 'embedded' ? `${sub.url}?t=${t.toFixed(2)}` : sub.url;
      const shift = streamed() ? -S.offset : 0;
      const Cue = window.VTTCue || window.TextTrackCue;
      const parser = vttParser((start, end, text) => {
        if (ctrl.signal.aborted) return;
        const s = start + shift, e = end + shift;
        if (e <= 0) return;
        try { subTrack.addCue(new Cue(Math.max(0, s), e, text.replace(/<(?!\/?[biu]>)[^>]+>/g, ''))); } catch (_) { /* ignore */ }
      });
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(dec.decode(value, { stream: true }));
        }
        parser.end();
      } catch (err) {
        if (!ctrl.signal.aborted) toast(`Subtitles unavailable (${err.message})`);
      }
    }

    function chooseSub(id) {
      const pb = S.pb;
      S.sub = id ? (pb.subs || []).find((s) => s.id === id) || null : null;
      prefs.subs = S.sub ? 'on' : 'off';
      if (S.sub && lang2(S.sub.lang)) prefs.subLang = lang2(S.sub.lang);
      savePrefs(prefs);
      setupMenus();
      loadSubs(currentTime());
    }

    function chooseAudio(index) {
      if (index === S.audioIndex) return;
      const t = currentTime();
      S.audioIndex = index;
      const first = S.pb.audio[0];
      if (S.mode === 'direct' && (!first || first.index !== index)) {
        S.mode = 'remux';                            // the browser can't switch tracks itself
        S.pb = { ...S.pb, url: S.pb.url.replace(/\/raw$/, '/play?m=remux') };
      }
      startVideo(t);
    }

    menuEl.addEventListener('click', (ev) => {
      const b = ev.target.closest('.tp-mi');
      if (!b) return;
      if (b.dataset.sub !== undefined) chooseSub(b.dataset.sub);
      if (b.dataset.audio !== undefined) chooseAudio(Number(b.dataset.audio));
      closeMenu();
    });

    // ------------------------------------------- torrent list (picker + side panel)
    const dlKey = (st) => st.hash || st.url || st.t;
    function rowHtml(st, i) {
      const pref = (S.req && (prefs.shows || {})[S.req.titleKey]) || {};
      const playing = i === S.idx && (S.hash || S.pb);
      const cls = ['tp-stream', playing ? 'cur' : '', S.failed.has(i) ? 'bad' : ''].filter(Boolean).join(' ');
      const tags = (st.tags || []).slice(0, 4).map((t) => `<span class="tp-tag">${esc(t)}</span>`).join('') +
        (playing ? '<span class="tp-tag now">playing</span>' : '') +
        (pref.hash && st.hash === pref.hash && !playing ? '<span class="tp-tag last">last played</span>' : '');
      const meta = [st.size ? fmtBytes(st.size) : '', st.seeders != null ? `👤 ${st.seeders}` : '', st.pack ? 'pack' : '',
        [st.provider, st.origin].filter(Boolean).join(' · ')].filter(Boolean);
      const dl = S.dlText.get(dlKey(st)) || '';
      return `<div class="${cls}" data-stream="${i}" role="listitem">
          <span class="tp-q">${esc(st.quality)}</span>
          <span class="tp-sinfo">
            <span class="tp-tags">${tags}</span>
            <span class="tp-sname">${esc(st.file || st.title)}</span>
            <span class="tp-smeta">${esc(meta.join(' · '))}</span>
            <span class="tp-dlstate${dl ? '' : ' hidden'}" data-dlkey="${esc(dlKey(st))}">${esc(dl)}</span>
          </span>
          <span class="tp-sbtns">
            <button type="button" class="tp-btn primary tp-watch" title="Watch this torrent">▶ Watch</button>
            <button type="button" class="tp-btn tp-dlbtn" data-dl="${i}" title="Download the video file">⬇</button>
          </span>
        </div>`;
    }
    function renderPanel() {
      const ok = S.providers.filter((p) => p.ok).length;
      const bad = S.providers.filter((p) => !p.ok);
      const meta = esc(`${S.streams.length} torrent${S.streams.length === 1 ? '' : 's'} · ${ok}/${S.providers.length} source${S.providers.length === 1 ? '' : 's'} answered`) +
        (bad.length ? `<br><span class="tp-warn">${esc(bad.map((p) => `${p.name}: ${p.error}`).join(' · '))}</span>` : '') +
        (S.hidden ? `<br><span class="tp-dim">${S.hidden} hidden (too large for this server)</span>` : '');
      panelMeta.innerHTML = meta;
      pickMeta.innerHTML = meta;
      const html = S.streams.map(rowHtml).join('') || '<div class="tp-menu-note">No torrents.</div>';
      panelList.innerHTML = html;
      pickList.innerHTML = html;
    }
    function openPanel() { closeMenu(); renderPanel(); panel.classList.remove('hidden'); showControls(); }
    function closePanel() { panel.classList.add('hidden'); }
    function onListClick(ev) {
      const d = ev.target.closest('[data-dl]');
      if (d) { downloadStream(Number(d.dataset.dl)); return; }
      const row = ev.target.closest('[data-stream]');
      if (!row) return;
      const i = Number(row.dataset.stream);
      closePanel();
      S.failed.delete(i);
      startStream(i, { keepTime: true });
    }
    panelList.addEventListener('click', onListClick);
    pickList.addEventListener('click', onListClick);
    autoBox.addEventListener('change', () => {
      prefs.autoPlay = autoBox.checked;
      savePrefs(prefs);
    });

    // ---------------------------------------------------------------- download
    // Starts the torrent on the server, waits for its file list, then hands the
    // browser a download link for the movie/episode file (it downloads as fast as
    // the server receives it; the browser can resume it via byte ranges).
    function setDl(key, text) {
      S.dlText.set(key, text);
      for (const el of root.querySelectorAll('[data-dlkey]')) {
        if (el.dataset.dlkey === key) { el.textContent = text; el.classList.toggle('hidden', !text); }
      }
    }
    function saveFile(url) {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    async function downloadStream(i) {
      const st = S.streams[i];
      const req = S.req;
      if (!st || !req) return;
      const key = dlKey(st);
      if (st.url) { saveFile(st.url); setDl(key, '⬇ Download started'); return; }
      setDl(key, 'Preparing download…');
      try {
        const r = await getJson('/api/torrent/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ t: st.t }),
        });
        const t0 = Date.now();
        for (;;) {
          const extra = { noprobe: 1 };
          if (r.fileIdx != null) extra.fi = r.fileIdx;
          const s = await getJson(`/api/torrent/${r.hash}/status?${reqQuery(extra, req)}`);
          if (s.state === 'error') throw new Error(s.error || 'Torrent failed.');
          if (s.state === 'ready') {
            if (!s.file) throw new Error(s.choice || 'No video file in this torrent.');
            saveFile(`/api/torrent/${r.hash}/${s.file.i}/raw?dl=1`);
            setDl(key, `⬇ Downloading ${s.file.name} (${fmtBytes(s.file.size)})`);
            toast(`⬇ Download started: ${s.file.name}`);
            return;
          }
          if (!s.peers && Date.now() - t0 > 30000) throw new Error('No peers found.');
          setDl(key, s.peers ? `Preparing download… ${s.peers} peer${s.peers === 1 ? '' : 's'}` : 'Preparing download… looking for peers');
          await sleep(1000);
        }
      } catch (err) {
        setDl(key, `✕ Download failed: ${err.message}`);
      }
    }

    // --------------------------------------------------------------- up next
    function showUpNext(label, seconds, go) {
      clearUpNext();
      let left = seconds;
      const tick = () => {
        $('.tp-upnext-label').innerHTML = `Up next: <b>${esc(label)}</b> — playing in ${left}s`;
        if (left <= 0) { clearUpNext(); go(); return; }
        left -= 1;
        S.upNextTimer = setTimeout(tick, 1000);
      };
      S.upNextGo = go;
      upNextEl.classList.remove('hidden');
      tick();
    }
    function clearUpNext() {
      clearTimeout(S.upNextTimer);
      S.upNextTimer = null;
      S.upNextGo = null;
      upNextEl.classList.add('hidden');
    }

    // ------------------------------------------------------------- buttons
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b || b.closest('.tp-menu')) return;
      const act = b.dataset.act;
      if (act !== 'subs' && act !== 'audio') closeMenu();
      switch (act) {
        case 'play': togglePlay(); break;
        case 'back': seekTo(currentTime() - 10); break;
        case 'fwd': seekTo(currentTime() + 10); break;
        case 'mute': video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; break;
        case 'subs': menuEl.classList.contains('hidden') || menuEl.dataset.kind !== 'subs' ? openMenu('subs') : closeMenu(); break;
        case 'audio': menuEl.classList.contains('hidden') || menuEl.dataset.kind !== 'audio' ? openMenu('audio') : closeMenu(); break;
        case 'streams': panel.classList.contains('hidden') ? openPanel() : closePanel(); break;
        case 'panel-close': closePanel(); break;
        case 'fs': if (hooks.toggleFullscreen) hooks.toggleFullscreen(); break;
        case 'retry': if (S.req) play(S.req); break;
        case 'retry-stream': startStream(Math.max(0, S.idx)); break;
        case 'next': {                               // "Skip →" (auto) / "← Choose another"
          if (S.hash) release(S.hash);
          S.hash = null;
          if (!S.autoMode) { resetVideo(); showPicker(); break; }
          S.failed.add(S.idx);
          const n = nextStreamIndex();
          if (n >= 0) startStream(n, { auto: true, keepTime: true });
          else { resetVideo(); showPicker('All torrents for this title were tried.'); }
          break;
        }
        case 'best': {
          const n = S.streams.findIndex((s, j) => !S.failed.has(j));
          if (n >= 0) startStream(n, { auto: true });
          break;
        }
        case 'upnext-go': { const go = S.upNextGo; clearUpNext(); if (go) go(); break; }
        case 'upnext-cancel': clearUpNext(); break;
        default: break;
      }
    });
    statusEl.addEventListener('click', (ev) => {
      const f = ev.target.closest('[data-file]');
      if (!f) return;
      S.fileIdx = Number(f.dataset.file);
      setStatus('Loading file…', '', []);
      poll(S.attempt);
    });
    document.addEventListener('click', (ev) => {
      if (!menuEl.classList.contains('hidden') && !ev.target.closest('.tp-menu') && !ev.target.closest('[data-act="subs"],[data-act="audio"]')) closeMenu();
    });

    function onKey(ev) {
      if (root.classList.contains('hidden') || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
      const tag = (ev.target && ev.target.tagName) || '';
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) && ev.target !== volEl) return false;
      const k = ev.key;
      if ((k === ' ' || k === 'Enter') && tag === 'BUTTON') return false;   // the focused button handles it
      if (k === ' ' || k === 'k') { togglePlay(); }
      else if (k === 'ArrowLeft' || k === 'j') { seekTo(currentTime() - (k === 'j' ? 30 : 10)); }
      else if (k === 'ArrowRight' || k === 'l') { seekTo(currentTime() + (k === 'l' ? 30 : 10)); }
      else if (k === 'ArrowUp') { video.volume = Math.min(1, video.volume + 0.1); video.muted = false; }
      else if (k === 'ArrowDown') { video.volume = Math.max(0, video.volume - 0.1); }
      else if (k === 'm') { video.muted = !video.muted; }
      else if (k === 'f') { if (hooks.toggleFullscreen) hooks.toggleFullscreen(); }
      else if (k === 'c') {
        const subs = (S.pb && S.pb.subs) || [];
        if (S.sub) chooseSub('');
        else if (subs.length) { pickDefaultSubs(); if (!S.sub) chooseSub(subs[0].id); else { prefs.subs = 'on'; savePrefs(prefs); } }
      } else return false;
      ev.preventDefault();
      kickControls();
      return true;
    }

    // ------------------------------------------------------------- lifecycle
    function release(hash) {
      if (!hash) return;
      const url = `/api/torrent/${hash}/release`;
      try {
        if (!(navigator.sendBeacon && navigator.sendBeacon(url))) fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
      } catch (_) { /* ignore */ }
    }
    function rememberChoice() {
      const st = S.streams[S.idx];
      if (!st || !S.req || !S.req.titleKey) return;
      prefs.shows = prefs.shows || {};
      // the torrent that worked: resuming (and the next episode of a season pack) reuses it
      prefs.shows[S.req.titleKey] = { hash: st.hash || null, group: st.group || null, res: st.res || null, at: Date.now() };
      const keys = Object.keys(prefs.shows);
      if (keys.length > 80) {
        keys.sort((a, b) => (prefs.shows[a].at || 0) - (prefs.shows[b].at || 0));
        for (const k of keys.slice(0, keys.length - 80)) delete prefs.shows[k];
      }
      savePrefs(prefs);
    }

    function stop({ keepVisible = false } = {}) {
      if (S.searchCtrl) S.searchCtrl.abort();
      S.searchCtrl = null;
      S.attempt += 1;
      clearTimeout(S.pollTimer);
      clearUpNext();
      reportProgress(true);
      resetVideo();
      if (S.hash) release(S.hash);
      S.hash = null;
      S.req = keepVisible ? S.req : null;
      S.streams = [];
      S.idx = -1;
      S.failed = new Set();
      S.autoMode = false;
      S.autoTries = 0;
      S.dlText = new Map();
      S.pb = null;
      S.mode = null;
      S.sub = null;
      S.status = null;
      S.duration = 0;
      S.offset = 0;
      S.audioIndex = null;
      pickEl.classList.add('hidden');
      statsEl.textContent = '';
      timeEl.textContent = '0:00 / 0:00';
      playedEl.style.width = '0%';
      knobEl.style.left = '0%';
      bufEl.style.width = '0%';
      const g = dlCanvas.getContext('2d');
      g.clearRect(0, 0, dlCanvas.width, 1);
      closeMenu();
      closePanel();
      if (!keepVisible) root.classList.add('hidden');
    }

    window.addEventListener('pagehide', () => { if (S.hash) release(S.hash); });

    return {
      play,
      stop: () => stop(),
      active: () => !root.classList.contains('hidden'),
      handleKey: onKey,
      showUpNext,
      currentTime,
    };
  }

  window.SwiftTorrent = { create };
})();
