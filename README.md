---
title: Dhamma Player
emoji: ☸️
colorFrom: yellow
colorTo: red
sdk: docker
app_port: 7860
pinned: false
---

# ☸ ဓမ္မ နားထောင်ရန် — Offline Dhamma Player

An offline-first PWA for listening to Dhamma talks during power and internet cuts.
It is plain HTML, CSS and JavaScript with no frameworks, built for an Android 10 phone with 2 GB of RAM.

```
public/            ← the PWA (can be hosted anywhere over HTTPS)
  index.html       ← whole app (UI + IndexedDB + player + downloader)
  manifest.json
  sw.js            ← caches the app shell + Burmese font for offline launch
  icons/
server/
  server.js        ← Express + yt-dlp backend + catalog API (also serves /public)
  data/catalog.json← created automatically (the curated talk list)
  data/sources.json← created when you edit suggestion sources
  package.json
Dockerfile         ← one image for Render and Hugging Face Spaces
```

## Remote catalog: push talks to her phone

Grandma never pastes links. Her screen shows only large talk cards, each with a green **Offline Ready ✓** badge or a blue **ဒေါင်းလုဒ်ဆွဲနေသည်...** badge. You manage the list from anywhere:

1. Open the app URL with **`#admin`** at the end, e.g. `https://<your-app>.onrender.com/#admin`. On her phone you can also tap the **⚙** in the top corner **5 times quickly**.
2. Enter the **Admin PIN**, which is the server's `ADMIN_PIN`.
3. Paste a YouTube link and choose **🎧 Audio (49 kbps m4a)** or **🎬 Video (360p mp4)**.
   - Leave the title empty and the server fills it in with `yt-dlp --get-title`.
   - Leave the monk empty and the server uses the YouTube channel name.
4. Tap **➕ Catalog သို့ ထည့်မည်**. The server starts preparing the file straight away.

Her phone fetches `/api/catalog` each time the app opens, when the internet comes back, and when the app returns to the screen (at most every 5 minutes). New talks are queued and downloaded **strictly one at a time**, each in 2 MB pieces that are released after saving.

**When you remove a talk from the catalog:**
- If it is already on her phone, it is **kept** and stays playable. It is marked *(Catalog မှ ဖယ်ထားသည်)*, but only in the admin view.
- If it was not downloaded yet, it is dropped quietly.
- An **empty** catalog never deletes anything on the phone, so a server reset can't wipe her library.

To delete a talk from the phone itself, open `#admin` on her phone and tap 🗑 on the card. Delete buttons are hidden in her normal view.

### `ADMIN_PIN` and where the catalog is stored

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_PIN` | `1234` | PIN for adding and removing catalog talks. **Change it.** After 5 wrong tries the IP is locked out for 15 minutes. |
| `CATALOG_FILE` | `/data/catalog.json` if `/data` is writable, otherwise `server/data/catalog.json` | Where the catalog is saved |
| `TRUST_PROXY` | `1` | Proxy hops in front of the app, so the lockout uses the real client IP |

- **Render:** open the service → **Environment** → add `ADMIN_PIN`, then save. The service redeploys.
- **Hugging Face Spaces:** open the Space → **Settings → Variables and secrets** → **New secret** named `ADMIN_PIN`. The Space restarts.

⚠ **Free hosting wipes local files on redeploy or restart.** Neither Render's free plan nor a Space without persistent storage keeps `catalog.json`. Her phone keeps every talk it already downloaded, but you would need to re-add them on the server. To make the catalog permanent:
- **Hugging Face:** enable *Persistent storage* (Settings). The server then uses `/data/catalog.json` automatically.
- **Any host:** commit a `server/catalog.seed.json` (same format as `GET /api/catalog`). It is copied in whenever no catalog file exists. To back up, open `/api/catalog` and save the JSON into that file.

## Suggested talks (တရားအသစ်များ) — a fresh feed without pasting links

When the phone is online, her main screen has two sections:

1. **💾 သိမ်းထားပြီးသား တရားတော်များ (Saved Offline):** always shown, and plays without internet.
2. **✨ နားထောင်ရန် အကြံပြုချက်များ (Suggested Talks):** shown only while online. It lists up to 16 new talks from your trusted sources, skipping anything already on the phone.

**Nothing in the suggestions is downloaded until she taps one.** On a tap:
- It starts streaming from YouTube straight away.
- Its audio (~22 MB/hour) goes to the **front** of the download queue. If a catalog download is running, it is paused and later resumes from its last saved 2 MB piece, so there is still only one download at a time.
- When the download finishes, playback switches to the phone copy at the same second, and the talk moves into *Saved Offline* for good.

**Managing sources** (in `#admin`, under *✨ Suggestion sources*):
- Accepted forms:
  - `ytsearch8:မိုးကုတ်ဆရာတော် တရားတော်` (a search)
  - plain words (treated as a search)
  - a YouTube **channel** URL (`https://www.youtube.com/@name`, which uses its *Videos* tab)
  - a **playlist** URL
- Other websites are rejected.
- The two searches above are the default sources the first time the server starts.
- Each source shows ✓ *N talks* or the YouTube error. **🔄 Refresh** rebuilds the feed immediately.

**How the server builds the feed:**
- It runs `yt-dlp --flat-playlist --dump-single-json --playlist-end 8` once per source, one source at a time. This reads metadata only (`id, title, thumbnail, duration, url`) and downloads no media.
- The merged feed (sources interleaved, duplicates removed) is cached **in memory for 6 hours**, so app opens are instant and YouTube isn't hit repeatedly.
- After 6 hours, the old feed is still served while a fresh one is built in the background. A source that fails keeps its previous results.
- Uploads shorter than 2 minutes (Shorts) or longer than 3 hours (e.g. 12-hour compilations, ~250 MB) are skipped.

| Var | Default | Purpose |
|---|---|---|
| `SUGGEST_TTL_HOURS` | 6 | How long the feed is cached |
| `SUGGEST_PER_SOURCE` | 8 | Talks per source (`--playlist-end`) |
| `SUGGEST_MAX_HOURS` | 3 | Skip talks longer than this |
| `SOURCES_FILE` | next to `catalog.json` | Where `sources.json` is saved (the same storage caveat applies; `server/sources.seed.json` works like the catalog seed) |

## How it works

| Situation | What plays |
|---|---|
| Track already saved on the phone | Local file from IndexedDB in a plain `<audio>`/`<video>` (online or offline) |
| Catalog talk not downloaded yet, online | YouTube iframe right away, while the phone keeps downloading it in the background |
| Download finishes while YouTube is playing | Iframe is destroyed; the local file continues from the same second |
| Internet drops while YouTube is playing | Iframe is removed at once; the local file continues from the same second (if not saved yet, it shows a message and resumes saving when back online) |

Steps taken to keep memory low:
- Downloads are streamed and written to IndexedDB in **2 MB pieces**, so the whole file is never held in RAM. Each buffer is released right after it is saved.
- For playback, the pieces are joined with `new Blob([...pieces])`. Chrome keeps IndexedDB blobs on disk, so this does not copy the file into memory.
- The previous blob URL is always released with `URL.revokeObjectURL()`, and the media element is reset with `removeAttribute('src')` + `load()` to free its decoder buffers.
- The YouTube script is loaded only when needed, never offline.
- No animations, shadows or blur.

Other behaviour:
- **Interrupted downloads resume** with HTTP `Range` from the last saved piece.
- The last position of each talk is saved, and lock-screen controls work through the Media Session API.

## Run locally

Needs Node 20 or newer, `yt-dlp` and `ffmpeg`.

```bash
cd server && npm install && npm start      # http://localhost:7860
```

On a phone, service workers need **HTTPS** (localhost is the only exception), so use one of the deploys below.

## Deploy (free)

The Dockerfile serves the PWA and the API from **one URL**, so there is nothing to configure in the app.

### Render
1. Push this folder to a GitHub repo.
2. In Render, choose **New → Web Service**, pick the repo, set Runtime to **Docker**, and choose the Free plan.
3. Open `https://<name>.onrender.com` on the phone.

Free Render instances sleep after about 15 minutes idle. The first YouTube download after a sleep waits about 1 minute, which the app handles.

### Hugging Face Spaces
1. Create a Space and choose the **Docker** SDK (blank template).
2. Upload or push all files in this folder. The front-matter at the top of this README already sets `sdk: docker` and `app_port: 7860`.
3. Open `https://<user>-<space>.hf.space`.

### Your own VPS (Ubuntu/Debian) — recommended if you have one
The catalog is stored permanently and nothing goes to sleep. As root on the server:
```bash
curl -fsSL https://raw.githubusercontent.com/hlaingminkyaw/offline-video/main/deploy/setup-vps.sh -o setup-vps.sh
bash setup-vps.sh
```
- It asks for an Admin PIN, then installs everything under `/opt/offline-video`. It uses its own Node.js copy, so other apps on the server are not affected.
- The app runs as the systemd service `offline-video`, bound to `127.0.0.1`. HTTPS comes from Caddy, or from nginx/Apache + certbot if one of them already uses port 80/443.
- Without a domain it uses `https://<ip-with-dashes>.sslip.io`. To use your own: `DOMAIN=dhamma.example.com bash setup-vps.sh`.
- Settings live in `/etc/offline-video.env`; logs: `journalctl -u offline-video -f`.
- Run the same command again to update.
- Ports 80 and 443 must be open in the cloud provider's firewall.

### Hosting the PWA somewhere else (GitHub Pages, Netlify…)
Upload `public/`. Then either set `DEFAULT_API` at the top of the `<script>` in `index.html`, or enter the server URL in the app under **⚙ ဆက်တင်**. CORS is enabled.

## Phone setup (do this once, online)
1. Open the URL in **Chrome** on the phone.
2. Tap **📲 ဖုန်း Home Screen သို့ ထည့်မည်**, or use Chrome menu → *Add to Home screen*. Installing it is also what makes Chrome grant `navigator.storage.persist()`, so saved talks are not auto-deleted. ⚙ Settings shows whether persistence was granted.
3. Add talks from `#admin` (see above); the phone downloads them by itself. The badge turns green — **✓ အင်တာနက်မလိုဘဲ နားထောင်နိုင်သည် (Offline Ready)** — once the app is cached and at least one talk is saved.
4. Turn on aeroplane mode and test before handing the phone over.

Size guide: audio is about 22 MB per hour (≈48 kbps AAC); 360p video is about 250–300 MB per hour. Prefer **🎧 အသံသာ** (audio only).

## Server environment variables (all optional)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 7860 | Render sets this automatically |
| `YTDLP_COOKIES` | – | Full text of a Netscape `cookies.txt` (store it as a Render/HF **secret**) |
| `YTDLP_COOKIES_FILE` | – | Path to a cookies file instead |
| `ALLOWED_ORIGINS` | `*` | Comma-separated list to restrict CORS |
| `MAX_CONCURRENT` | 2 | Parallel yt-dlp jobs |
| `FILE_TTL_MIN` | 180 | Minutes to keep server files (needed to resume phone downloads) |
| `AUDIO_FORMAT` / `VIDEO_FORMAT` | see server.js | yt-dlp `-f` selectors |
| `YTDLP_JS_RUNTIME` | `node` | JS runtime yt-dlp uses for YouTube; set to empty for old yt-dlp |
| `YTDLP_EXTRA_ARGS` | – | Extra yt-dlp flags |

### ⚠ YouTube bot checks
YouTube often blocks downloads from cloud server IPs. The usual error is *"Sign in to confirm you're not a bot"*, and the app shows it under the talk as **⚠ သိမ်း၍ မရပါ (…)**. If that happens:
1. Export cookies from a logged-in browser with a "Get cookies.txt" extension. A throw-away Google account is safer.
2. Paste the file's contents into the `YTDLP_COOKIES` secret and restart the service.

The container runs `yt-dlp -U` at every start to stay current. **Local files** (📁 Add Local File) never need the server.

## API
`GET /api/suggestions` · `POST /api/suggestions/refresh` 🔐 · `GET/POST /api/sources` 🔐 `{url, label?}` · `DELETE /api/sources/:id` 🔐

`GET /api/catalog` · `POST /api/catalog` 🔐 `{youtubeUrl, title?, monk?, mediaType}` · `DELETE /api/catalog/:id` 🔐 · `GET /api/admin/check` 🔐 (🔐 = header `x-admin-pin`)

`POST /api/prepare {url, type:"audio"|"video"}` → job ·
`GET /api/status/:id` ·
`GET /api/file/:id` (Range) ·
`GET /api/info?url=` ·
`GET /api/thumb/:videoId` ·
`GET /health`
