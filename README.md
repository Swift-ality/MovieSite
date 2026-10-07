# 🎬 SwiftWatchesMovies

A small self-hosted web app for browsing and streaming **Movies & TV** (via
[TheMovieDB](https://www.themoviedb.org/)) and **Anime** (via [AniList](https://anilist.co/)).
Switch between the **Movies** and **Anime** sections from the top tabs; each has its own
**genre sidebar**. The front page infinitely scrolls trending titles, the search bar shows
live poster previews, and the player is full-screen capable.

- **⚡ Swift Servers** stream torrents through the site's own player — pick a torrent to
  watch or download (see [Swift Servers](#-swift-servers-torrents-our-own-player)).
- **Movies/TV** play through a switchable set of embed sources (see below), by TMDB ID.
- **Anime** plays through its own switchable sources by AniList ID — **VidPlus**
  (`player.vidplus.to/embed/anime/{id}/{ep}`), **VidEasy** (`player.videasy.net/anime/{id}/{ep}`),
  and **MegaPlay** (`megaplay.buzz/stream/ani/{id}/{ep}/sub`). Each mode remembers its own source,
  so if one provider is down you can switch in the player.

Sources you can switch between in the player:

| Source | Movie URL | TV URL |
|---|---|---|
| **111Movies** | `…/movie/{id}` | `…/tv/{id}/{s}/{e}` |
| **VidFast** | `vidfast.vc/movie/{id}?autoPlay=true` | `vidfast.vc/tv/{id}/{s}/{e}?autoPlay=true` |
| **VidSrc** | `vidsrc.sbs/embed/movie/{id}` | `vidsrc.sbs/embed/tv/{id}/{s}/{e}` |
| **CineSrc** | `cinesrc.st/embed/movie/{id}` | `cinesrc.st/embed/tv/{id}?s={s}&e={e}` |
| **VidEasy** | `player.videasy.net/movie/{id}` | `player.videasy.net/tv/{id}/{s}/{e}` |

The TMDB ID is used directly (these providers accept TMDB IDs, and IMDB IDs with the
`tt` prefix). The chosen source is remembered per browser. Sources are defined in
[`server.js`](server.js) (`SOURCES`) — add or edit templates there.
Designed to run behind a **Pterodactyl egg** (included) or standalone with Node.js.

### Continue Watching

The site remembers where you left off, per browser (`localStorage`, no accounts):

- **Title, season/episode and server** are always saved, so reopening a show — from the
  **▶ Continue Watching** row on the home page or from anywhere else — puts you back on
  the right episode. Finish an episode and it offers the next one (rolling over to the
  next season / anime episode).
- **The timestamp inside the video** is captured when the player broadcasts progress via
  `postMessage` (CineSrc, VidEasy, VidFast do). On reopen it's passed back as a start time
  on servers that accept one — VidFast `startAt`, CineSrc `t`, VidEasy `progress`
  (`startParam` in `SOURCES`). Other servers start from 0:00 and a toast tells you the
  time to skip to; your saved spot isn't overwritten until you watch past it.
- If the player auto-advances to the next episode on its own, the episode picker and
  history follow along without reloading the video.
- Only messages from the player frame whose origin matches the loaded server are read,
  and only as numbers. Titles join the row after ~60s of watching (not on a quick click).
  Remove one with ✕, or **Clear all** per section.

### Parallel search

Every search queries **Movies & TV (TMDB)** and **Anime (AniList)** at the same time. The
dropdown fills in per catalog as each answers, the results grid reuses the same request,
and an "Also found N anime matches → Show Anime" hint (or the reverse) jumps sections
with your query. Typing more cancels the stale requests (the server aborts the upstream
call too), and search / trending / genre / season results are cached server-side.

### Browse lists & IMDB ids

- The sidebar's **Browse** group pages (infinite scroll) through whole catalogs:
  Trending, Popular Movies, Top Rated Movies, Now Playing, Upcoming, Popular TV, Top Rated TV
  and On the Air (TMDB); in the Anime section Trending, Popular, Top Rated, This Season,
  Upcoming and Anime Movies (AniList). Genres sit below.
- Search accepts **IMDB ids and links** — `tt0111161` or `https://www.imdb.com/title/tt0111161/`
  finds that exact title, and `/?imdb=tt0111161` opens it straight away.

### ⚡ Swift Servers (torrents, our own player)

The Stremio + Torrentio idea, built in: pick **⚡ Swift Server** in the player's *Server*
menu (its own **Swift Servers** section, above the embed servers). The site looks up
torrents for the movie / episode / anime episode, lists them with quality, size, seeders
and source, and you choose one to **▶ Watch** or **⬇ Download**. This server downloads
the torrent and streams it to the built-in player *while* it downloads — only the file
you're watching, the parts at the play head first — so playback starts after a few MB.

- **Torrent sources are yours to choose — nothing is hardcoded.** Set `STREMIO_ADDONS` to
  one or more Stremio *stream addon* URLs (the manifest URL you'd install in Stremio;
  Torrentio-style addons work, anime is looked up by Kitsu id) and/or `TORZNAB_URLS`
  (+ `TORZNAB_APIKEY`) for Jackett / Prowlarr. Swift Servers stay hidden until one is set.
- **Choosing:** the list is ranked for browser playback (resolution up to
  `TORRENT_MAX_RES`, x264/MP4 over HEVC, healthy seeders, sensible size). Hit
  **▶ Play best match**, or tick *Always auto-play the best torrent* to skip the list.
  Resuming and the next episode reuse the torrent you picked (season packs start
  instantly). Auto-picked torrents without peers are skipped automatically, and
  torrents that failed recently are ranked last for everyone.
- **Playback:** MP4/WebM the browser can decode play directly with normal seeking.
  MKV/AVI or AC3/DTS audio are remuxed by ffmpeg into fragmented MP4 (video copied, audio
  → AAC: cheap). Codecs the browser can't decode (HEVC on Firefox, XviD, 10-bit H.264) are
  transcoded to H.264 ≤720p — CPU heavy, one at a time (`TORRENT_TRANSCODE=0` turns it
  off). Seeking restarts the conversion exactly on a keyframe. Embedded text subtitles
  (SRT/ASS) and subtitle files inside the torrent appear under **CC**; other audio tracks
  under **Audio**. Continue Watching stores the exact position.
- **Downloads:** ⬇ starts the torrent here and hands your browser the file as it arrives
  (resumable byte ranges).
- **ffmpeg:** the system `ffmpeg`/`ffprobe` are used when present (the Pterodactyl
  Node.js yolks include them), else the bundled npm builds (`@ffmpeg-installer`,
  `@ffprobe-installer`). Without ffmpeg only MP4/WebM files play.
- **Server resources:** pieces are kept in `TORRENT_DIR` (default `./torrent-cache`,
  wiped on start) — one file per torrent holding only downloaded pieces, so disk usage
  is exactly what was fetched. Idle torrents are deleted after `TORRENT_IDLE_MINUTES`
  (5 minutes after you close the player), `TORRENT_CACHE_GB` caps the total,
  `TORRENT_MAX_ACTIVE` the number streaming at once, and files over
  `TORRENT_MAX_FILE_GB` aren't offered.
- **Not an open relay:** stream lists carry server-signed tokens, so visitors can only
  start torrents this server found for a title — not arbitrary ones.
- ⚠️ Unlike the embeds, **this server itself downloads and uploads (seeds) via
  BitTorrent**, from its own IP address. Rights holders' notices go to whoever owns that
  IP (your host). Only use it for content you're allowed to download and share;
  `TORRENT_UPLOAD_KBPS` limits seeding.

| Variable | Default | Meaning |
|---|---|---|
| `STREMIO_ADDONS` | *(empty)* | Stremio stream addon URL(s), space separated. |
| `TORZNAB_URLS` / `TORZNAB_APIKEY` | *(empty)* | Jackett / Prowlarr Torznab feed URL(s) and key. |
| `TORRENT_CACHE_GB` | `20` | Disk the torrent cache may use. |
| `TORRENT_MAX_ACTIVE` | `3` | Torrents streaming at the same time. |
| `TORRENT_MAX_FILE_GB` | `15` | Bigger files are hidden from the list. |
| `TORRENT_MAX_RES` | `1080` | Preferred maximum resolution when ranking. |
| `TORRENT_TRANSCODE` | `1` | `0` = never re-encode video. |
| `TORRENT_TRANSCODE_HEIGHT` / `_PRESET` | `720` / `veryfast` | Transcode size and x264 speed. |
| `TORRENT_MAX_TRANSCODES` | `1` | Concurrent re-encodes. |
| `TORRENT_IDLE_MINUTES` | `20` | Delete torrents nobody used for this long. |
| `TORRENT_CONNECT_TIMEOUT` | `60` | Seconds to find peers before a torrent counts as dead. |
| `TORRENT_PORT` / `TORRENT_DHT_PORT` | `0` | Fixed ports for incoming peers (add an allocation). |
| `TORRENT_UPLOAD_KBPS` / `TORRENT_DOWNLOAD_KBPS` | `0` | Speed limits (0 = none). |
| `TORRENT_DHT` / `TORRENT_PUBLIC_TRACKERS` | `1` | `0` turns off DHT / the built-in public tracker list. |
| `TORRENT_TRACKERS` | *(empty)* | Extra trackers added to every torrent. |
| `TORRENT_DIR` | `torrent-cache` | Where pieces are stored. |
| `FFMPEG_PATH` / `FFPROBE_PATH` | *(auto)* | Use specific ffmpeg/ffprobe binaries. |

On a panel, set these as server variables (the egg includes the main ones) **or** put
them in a `.env` file next to `server.js` — `.env` values also fill in variables the
panel passes empty.

---

## How it works

```
Browser ──▶ /api/search ──▶  Node/Express  ──▶ TheMovieDB API   (API key stays server-side)
Browser ──▶ iframe        ──▶ https://111movies.net/movie|tv/... (embed servers)
Browser ──▶ /api/torrent… ──▶  Node/Express  ──▶ Stremio addons / Torznab (find torrents)
                                     └──────▶ BitTorrent swarm ─▶ ffmpeg ─▶ <video> (Swift Servers)
```

The server proxies TMDB search/metadata so your API key is never exposed to the
browser. Embed servers play inside an `<iframe>` from the third-party provider; Swift
Servers are downloaded by this server and played by the site's own player.

---

## 1. Get a free TMDB API key (required)

1. Create an account at [themoviedb.org](https://www.themoviedb.org/).
2. Go to **Settings → API** and request an API key (choose *Developer*).
3. Copy either the **API Key (v3 auth)** or the **API Read Access Token (v4)** — both work.

Without this key, search returns an error.

---

## 2. Run locally (development)

```bash
npm install
cp .env.example .env      # then edit .env and paste your TMDB_API_KEY
npm start
```

Open <http://localhost:3000>.

On Windows PowerShell you can instead set it inline:

```bash
$env:TMDB_API_KEY="your_key_here"; npm start
```

---

## 3. Deploy with the Pterodactyl egg

The file [`egg-movie-stream-site.json`](egg-movie-stream-site.json) is a ready-to-import
custom egg.

### Import the egg
1. In the Pterodactyl **admin panel**: **Nests → Import Egg**.
2. Upload `egg-movie-stream-site.json` and assign it to a nest (e.g. create a "Web Apps" nest).

### Create the server
1. Create a new server using the **Movie & TV Stream Search Site** egg.
2. Give it at least one **port allocation** — the app listens on the injected `SERVER_PORT`.
3. Fill in the variables (see below) and install.

### Get the code onto the server — pick one

**Option A — Git (recommended, supports auto-update):**
- The **Git Repository** variable already defaults to `https://github.com/Swift-ality/MovieSite`,
  so there's nothing to set unless you're using your own fork.
- Optionally set **Git Branch**, and **Git Username** + **Git Access Token** for private repos.
- Set **Auto Update** to `1` to `git pull` on every restart.
- (Re)install / start the server — it clones the repo, runs `npm install`, then starts.

**Option B — Manual upload:**
- Leave **Git Repository** blank.
- After the install step, upload `server.js`, `package.json`, and the `public/` folder to
  `/home/container` via SFTP or the panel File Manager.
- Start the server — it runs `npm install` on first boot automatically.

### Egg variables

| Variable | Env | Default | Notes |
|---|---|---|---|
| TMDB API Key | `TMDB_API_KEY` | *(empty)* | **Required.** v3 key or v4 token. |
| 111Movies Base URL | `PLAYER_BASE_URL` | `https://111movies.net` | Base for the 111Movies source only; change if that domain moves. |
| Default Source | `DEFAULT_SOURCE` | `111movies` | First-selected server: `111movies`, `vidfast`, `vidsrc`, `cinesrc`, `videasy`, `swift`. |
| Default Anime Source | `DEFAULT_ANIME_SOURCE` | `vidplus` | `vidplus`, `videasy`, `megaplay`, `swift`. |
| Swift Servers: … | `STREMIO_ADDONS`, `TORZNAB_URLS`, `TORZNAB_APIKEY`, `TORRENT_CACHE_GB`, `TORRENT_MAX_ACTIVE`, `TORRENT_TRANSCODE`, `TORRENT_PORT`, `TORRENT_UPLOAD_KBPS` | see above | Torrent streaming (see **Swift Servers**). |
| Git Repository | `GIT_ADDRESS` | `https://github.com/Swift-ality/MovieSite` | HTTPS repo URL; blank = manual upload. |
| Git Branch | `BRANCH` | `main` | |
| Auto Update | `AUTO_UPDATE` | `0` | `1` = `git pull` each startup. |
| Main File | `MAIN_FILE` | `server.js` | Node entry point. |
| Git Username | `USERNAME` | *(empty)* | For private repos. |
| Git Access Token | `ACCESS_TOKEN` | *(empty)* | For private repos (hidden). |

The panel automatically provides `SERVER_PORT`; the app binds to `0.0.0.0:$SERVER_PORT`.
The egg marks the server as "started" when it prints `listening on`.

---

## Project structure

```
MovieSite/
├── server.js                     # Express server, TMDB/AniList proxy, browse lists
├── lib/torrent/                  # Swift Servers
│   ├── index.js                  #   routes, signed stream tokens, title -> IMDB/Kitsu ids
│   ├── providers.js              #   Stremio addon + Torznab clients
│   ├── release.js                #   release-name parsing, episode matching, ranking
│   ├── engine.js                 #   WebTorrent wrapper: start, stream ranges, idle cleanup
│   ├── piece-store.js            #   disk store holding only downloaded pieces
│   └── media.js                  #   ffprobe/ffmpeg: probe, remux/transcode, subtitles
├── vendor/webrtc-polyfill/       # stub (no WebRTC on the server; avoids a native build)
├── start.sh                      # Runtime launcher used by the egg startup command
├── package.json
├── .env.example
├── egg-movie-stream-site.json    # Pterodactyl egg
└── public/
    ├── index.html                # UI
    ├── style.css
    ├── app.js                    # search, browse, cards, player modal, history
    └── torrent.js                # Swift Servers player (picker, controls, subtitles)
```

`webtorrent` is kept on 2.x (Node 20 compatible) with `uint8-util` pinned to 2.2.6 via
`overrides` — newer `uint8-util` releases crash WebTorrent 2.x when a torrent is added.

The egg's startup command is just `sh /home/container/start.sh`. All boot logic
(optional `git pull`, `npm install` when `node_modules` is missing or `package.json` /
the lockfile changed, then `exec node`)
lives in [`start.sh`](start.sh) rather than in the panel's startup string — some
panels (e.g. Calagopus/BusyBox `ash`) can't reliably `eval` a multi-statement
`if…then…fi` startup string, but they run a script file fine.

## API endpoints (internal)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Sources, default source, anime source, API-key flag. |
| GET | `/api/search?q=&page=` | Movie/TV multi search (paginated). |
| GET | `/api/trending?page=` | Trending movies & TV (front page). |
| GET | `/api/list/:list?page=` | Browse lists: `popular`, `top_rated`, `now_playing`, `upcoming`, `tv_popular`, `tv_top_rated`, `tv_on_air`. |
| GET | `/api/find?imdb=tt…` | Look a title up by IMDB id or link. |
| GET | `/api/genres/movie` | Movie genre list (sidebar). |
| GET | `/api/discover?genre=&page=` | Movies by genre (paginated). |
| GET | `/api/tv/:id` · `/api/tv/:id/season/:n` | Seasons / episodes for a show. |
| GET | `/api/anime/genres` | Anime genre list (AniList). |
| GET | `/api/anime/browse?genre=&list=&page=` | Trending / list (`popular`, `top_rated`, `season`, `upcoming`, `movies`) / genre anime. |
| GET | `/api/anime/search?q=&page=` | Anime search (AniList, cached). |
| GET | `/api/torrents/search?kind=&id=&s=&e=` | Swift Servers: ranked torrents for a title / episode. |
| POST | `/api/torrent/start` | Start (or reuse) a torrent from a signed stream token. |
| GET | `/api/torrent/:hash/status` | Peers, speed, chosen file, playback plan (direct / remux / transcode). |
| GET | `/api/torrent/:hash/:file/raw` | Byte-range stream of a file (`?dl=1` = download). |
| GET | `/api/torrent/:hash/:file/play` · `/keyframe` · `/sub/:n` · `/subfile` | ffmpeg remux/transcode, seek point, subtitles as WebVTT. |
| GET | `/healthz` | Health check. |

Anime data comes from AniList (no key needed) and is cached in-memory for a few minutes
to stay under AniList's rate limit.

---

## Notes

- Playback content is served by the third-party embed provider, not by this app. Its
  availability, ads, and legality are outside this project's control — you are responsible
  for how you use it in your jurisdiction.
- If a player fails to load, the embed service may be down or may block iframe embedding
  for that title; try another title.

## Troubleshooting (Pterodactyl / Calagopus)

- **`syntax error: unexpected "then"` on startup** — the panel is `eval`-ing a
  multi-statement startup string under BusyBox `ash`. This egg avoids that by using
  `sh /home/container/start.sh` as the startup command. Make sure your server's
  **Startup** command is exactly that (reset it to the egg default if needed).
- **`exec /bin/bash: exec format error` during install** — the install image had no
  build for your CPU (common on ARM, e.g. Oracle Ampere). This egg installs with
  `ghcr.io/pterodactyl/yolks:nodejs_20`, which is multi-arch (amd64 + arm64).
- **`Cannot find module 'express'` / missing `server.js`** — the code was never pulled.
  **Reinstall** the server so the install step clones the repo, then start.
- After changing the egg, existing servers keep their old settings — **update the
  server's Startup command and Reinstall** for the changes to take effect.
