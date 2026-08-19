# 🎬 StreamSearch

A small self-hosted web app that lets you **search movies & TV shows** (powered by
[TheMovieDB](https://www.themoviedb.org/)) and **stream them** through an embeddable
player. Search results show the poster + title; clicking one opens a player.

- **Movies** embed `https://111movies.net/movie/{id}`
- **TV shows** embed `https://111movies.net/tv/{id}/{season}/{episode}` with season/episode pickers

The TMDB ID is used directly (111movies.net accepts TMDB IDs, and IMDB IDs with the `tt` prefix).
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
| Player Base URL | `PLAYER_BASE_URL` | `https://111movies.net` | Change only if the provider domain changes. |
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
| GET | `/api/config` | Player base URL + whether an API key is set. |
| GET | `/api/search?q=` | Multi search (movies + TV). |
| GET | `/api/tv/:id` | Season list for a show. |
| GET | `/api/tv/:id/season/:n` | Episodes for a season. |
| GET | `/healthz` | Health check. |

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
