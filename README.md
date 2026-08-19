# 🎬 SwiftWatchesMovies

A small self-hosted web app for browsing and streaming **Movies & TV** (via
[TheMovieDB](https://www.themoviedb.org/)) and **Anime** (via [AniList](https://anilist.co/)).
Switch between the **Movies** and **Anime** sections from the top tabs; each has its own
**genre sidebar**. The front page infinitely scrolls trending titles, the search bar shows
live poster previews, and the player is full-screen capable.

- **Movies/TV** play through a switchable set of embed sources (see below), by TMDB ID.
- **Anime** plays through [VidEasy's](https://www.videasy.to/) AniList endpoints
  (`player.videasy.net/anime/{id}` for films, `…/anime/{id}/{episode}` for series; sub + dub).

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

---

## How it works

```
Browser ──▶ /api/search ──▶  Node/Express  ──▶ TheMovieDB API   (API key stays server-side)
Browser ──▶ iframe        ──▶ https://111movies.net/movie|tv/... (playback)
```

The server only proxies TMDB search/metadata so your API key is never exposed to the
browser. Playback is handled entirely by the third-party embed provider inside an `<iframe>`.

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
| Default Source | `DEFAULT_SOURCE` | `111movies` | First-selected source: `111movies`, `vidfast`, `vidsrc`, `cinesrc`, `videasy`. |
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
movie-stream-site/
├── server.js                     # Express server + TMDB proxy
├── start.sh                      # Runtime launcher used by the egg startup command
├── package.json
├── .env.example
├── egg-movie-stream-site.json    # Pterodactyl egg
└── public/
    ├── index.html                # UI
    ├── style.css
    └── app.js                    # search, cards, player modal
```

The egg's startup command is just `sh /home/container/start.sh`. All boot logic
(optional `git pull`, `npm install` if `node_modules` is missing, then `exec node`)
lives in [`start.sh`](start.sh) rather than in the panel's startup string — some
panels (e.g. Calagopus/BusyBox `ash`) can't reliably `eval` a multi-statement
`if…then…fi` startup string, but they run a script file fine.

## API endpoints (internal)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Sources, default source, anime source, API-key flag. |
| GET | `/api/search?q=&page=` | Movie/TV multi search (paginated). |
| GET | `/api/trending?page=` | Trending movies & TV (front page). |
| GET | `/api/genres/movie` | Movie genre list (sidebar). |
| GET | `/api/discover?genre=&page=` | Movies by genre (paginated). |
| GET | `/api/tv/:id` · `/api/tv/:id/season/:n` | Seasons / episodes for a show. |
| GET | `/api/anime/genres` | Anime genre list (AniList). |
| GET | `/api/anime/browse?genre=&page=` | Trending / genre anime (AniList, cached). |
| GET | `/api/anime/search?q=&page=` | Anime search (AniList, cached). |
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
