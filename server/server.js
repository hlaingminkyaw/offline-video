'use strict';
/*
 * Dhamma Player – lightweight backend
 * Express + yt-dlp. Downloads the smallest usable audio (or 360p MP4) from a
 * YouTube link to a temp file, then serves it with HTTP Range support so the
 * phone can resume interrupted downloads.
 *
 *   POST /api/prepare   {url, type:'audio'|'video'}  -> job
 *   GET  /api/status/:id                              -> job
 *   GET  /api/file/:id   (Range supported)            -> media bytes
 *   GET  /api/info?url=                               -> {title, author}
 *   GET  /api/thumb/:vid                              -> small jpeg (CORS)
 *   GET  /health
 *
 * Curated catalog (what grandma's phone auto-downloads):
 *   GET    /api/catalog                               -> [{id, youtubeUrl, title, monk, mediaType, addedAt}]
 *   POST   /api/catalog      (header x-admin-pin)     {youtubeUrl, title?, monk?, mediaType}
 *   DELETE /api/catalog/:id  (header x-admin-pin)
 *   GET    /api/admin/check  (header x-admin-pin)     -> {ok:true}
 *
 * Suggestions feed (metadata only – nothing is downloaded until grandma taps a talk):
 *   GET    /api/suggestions                           -> {updatedAt, items:[{id,title,thumbnail,duration,url,channel,source}]}
 *   POST   /api/suggestions/refresh (x-admin-pin)     -> rebuild now
 *   GET    /api/sources          (x-admin-pin)        -> {sources, status}
 *   POST   /api/sources          (x-admin-pin)        {url, label?}   channel / playlist URL, "ytsearch8:words" or plain words
 *   DELETE /api/sources/:id      (x-admin-pin)
 *
 * It also serves the PWA from ../public, so one deploy = app + API.
 */
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------- config (all optional, via env) ----------
const PORT = Number(process.env.PORT) || 7860;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const TMP = process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'dhamma-dl');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const MAX_JOBS = Number(process.env.MAX_JOBS) || 40;
// Temp-file housekeeping:
//  - a finished file is deleted DELIVERED_GRACE after the phone has received its last byte
//  - a file nobody has requested for FILE_TTL_MIN (default 30) minutes is deleted
//    (the phone pauses/resumes downloads with HTTP Range, so a disconnect alone must not delete it)
//  - stray files in DOWNLOAD_DIR that belong to no job are deleted once older than FILE_TTL_MIN
const FILE_TTL_MS = (Number(process.env.FILE_TTL_MIN) || 30) * 60e3;
const DELIVERED_GRACE_MS = (Number(process.env.DELIVERED_GRACE_SEC) || 120) * 1e3;
const JOB_TIMEOUT_MS = (Number(process.env.JOB_TIMEOUT_MIN) || 40) * 60e3;
// yt-dlp needs a JS runtime for YouTube. Node is already here, so use it.
// Set YTDLP_JS_RUNTIME="" to disable (for very old yt-dlp versions).
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME ?? 'node';
const EXTRA_ARGS = (process.env.YTDLP_EXTRA_ARGS || '').split(' ').filter(Boolean);
const ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : '*';
const ADMIN_PIN = String(process.env.ADMIN_PIN || '1234');
// Where catalog.json and sources.json live. DATA_DIR wins (e.g. a Docker volume mounted at /data);
// otherwise /data is used automatically when writable (Hugging Face persistent storage), else server/data.
const DATA_DIR = process.env.DATA_DIR || (() => {
  try { fs.accessSync('/data', fs.constants.W_OK); return '/data'; }
  catch { return path.join(__dirname, 'data'); }
})();
const CATALOG_FILE = process.env.CATALOG_FILE || path.join(DATA_DIR, 'catalog.json');
const CATALOG_SEED = path.join(__dirname, 'catalog.seed.json');
const SOURCES_FILE = process.env.SOURCES_FILE || path.join(path.dirname(CATALOG_FILE), 'sources.json');
const SOURCES_SEED = path.join(__dirname, 'sources.seed.json');
const DEFAULT_SOURCES = [
  { id: 'default-mogok', url: 'ytsearch8:မိုးကုတ်ဆရာတော် တရားတော်', label: 'မိုးကုတ်ဆရာတော်' },
  { id: 'default-pamaukka', url: 'ytsearch8:ပါမောက္ခချုပ်ဆရာတော် တရားတော်', label: 'ပါမောက္ခချုပ်ဆရာတော်' },
];
const SUGGEST_TTL_MS = (Number(process.env.SUGGEST_TTL_HOURS) || 6) * 3600e3;
const SUGGEST_PER_SOURCE = Number(process.env.SUGGEST_PER_SOURCE) || 8;
// Skip very long uploads (e.g. 12-hour "sleep" compilations ≈ 250 MB even as audio).
const SUGGEST_MAX_SEC = (Number(process.env.SUGGEST_MAX_HOURS) || 3) * 3600;

const FORMATS = {
  // Smallest m4a around 48 kbps (fine for speech); falls back to any small audio.
  audio: {
    f: process.env.AUDIO_FORMAT || 'ba[ext=m4a][abr>=45]/ba[ext=m4a]/ba[ext=mp3]/ba/w',
    sort: '+size,+br',
  },
  // Progressive 360p MP4 (format 18) needs no merging; otherwise merge <=360p.
  video: {
    f: process.env.VIDEO_FORMAT ||
      'b[height<=360][ext=mp4]/bv*[height<=360][ext=mp4]+ba[ext=m4a]/b[height<=360]/w',
    sort: null,
  },
};

const MIME = {
  m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', opus: 'audio/ogg',
  ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
};

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// Optional cookies (helps when YouTube says "confirm you're not a bot").
// YTDLP_COOKIES = full text of a Netscape cookies.txt (good for HF secrets)
// YTDLP_COOKIES_FILE = path to such a file
let COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || null;
if (!COOKIES_FILE && process.env.YTDLP_COOKIES) {
  COOKIES_FILE = path.join(os.tmpdir(), 'yt-cookies.txt');
  fs.writeFileSync(COOKIES_FILE, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
}

// ---------- helpers ----------
function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

const jobs = new Map();      // jobId -> job
const byKey = new Map();     // `${vid}-${type}` -> jobId
const queue = [];
let running = 0;

function publicJob(j) {
  return {
    id: j.id, videoId: j.vid, type: j.type, status: j.status,
    progress: Math.round(j.progress * 10) / 10,
    size: j.size || 0, ext: j.ext || null, mime: j.mime || null,
    error: j.error || null,
  };
}

function removeJob(j) {
  if (j.proc) { try { j.proc.kill('SIGKILL'); } catch {} }
  try { if (j.file) fs.rmSync(j.file, { force: true }); removeJobFiles(j.id); } catch {}   // file + .part / fragment leftovers
  jobs.delete(j.id);
  if (byKey.get(j.key) === j.id) byKey.delete(j.key);
}

// Create (or reuse) a server-side download job for one video.
function startJob(vid, type) {
  const t = type === 'video' ? 'video' : 'audio';
  const key = `${vid}-${t}`;
  const existing = jobs.get(byKey.get(key));
  if (existing && existing.status !== 'error') return existing;
  if (existing) removeJob(existing);
  if (jobs.size >= MAX_JOBS) return null;
  const job = {
    id: `${key}-${crypto.randomBytes(4).toString('hex')}`,
    key, vid, type: t, status: 'queued', progress: 0,
    created: Date.now(), finished: 0, file: null, proc: null,
    lastAccess: Date.now(), active: 0, delivered: 0,
  };
  jobs.set(job.id, job);
  byKey.set(key, job.id);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (!jobs.has(job.id)) continue;
    running++;
    runJob(job).finally(() => { running--; pump(); });
  }
}

function runJob(job) {
  return new Promise(resolve => {
    job.status = 'downloading';
    const fmt = FORMATS[job.type];
    const args = [
      '--no-playlist', '--newline', '--no-mtime', '--no-color',
      '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30',
      '--cache-dir', path.join(TMP, '.cache'),
      '-f', fmt.f,
      ...(fmt.sort ? ['-S', fmt.sort] : []),
      ...(job.type === 'video' ? ['--merge-output-format', 'mp4'] : []),
      ...(JS_RUNTIME ? ['--js-runtimes', JS_RUNTIME] : []),
      ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
      ...EXTRA_ARGS,
      '-o', path.join(TMP, job.id + '.%(ext)s'),
      '--', `https://www.youtube.com/watch?v=${job.vid}`,
    ];
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = proc;
    let errTail = '';
    const onData = buf => {
      const text = buf.toString();
      const m = text.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/g);
      if (m) {
        const last = m[m.length - 1].match(/(\d{1,3}(?:\.\d+)?)%/);
        if (last) job.progress = Math.min(99, parseFloat(last[1]));
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', buf => {
      onData(buf);
      errTail = (errTail + buf.toString()).slice(-1500); // keep memory tiny
    });
    const killer = setTimeout(() => { job.error = 'timeout'; proc.kill('SIGKILL'); }, JOB_TIMEOUT_MS);

    const finish = code => {
      clearTimeout(killer);
      job.proc = null;
      job.finished = Date.now();
      if (!jobs.has(job.id)) return resolve();
      if (code === 0) {
        const name = fs.readdirSync(TMP).find(f =>
          f.startsWith(job.id + '.') && !/\.(part|ytdl|temp)$/.test(f) && !/\.f\d+\./.test(f));
        if (name) {
          job.file = path.join(TMP, name);
          job.size = fs.statSync(job.file).size;
          job.ext = path.extname(name).slice(1).toLowerCase();
          job.mime = MIME[job.ext] || (job.type === 'audio' ? 'audio/mp4' : 'video/mp4');
          if (job.type === 'audio' && job.ext === 'webm') job.mime = 'audio/webm';
          job.status = 'ready';
          job.progress = 100;
          console.log(`[ready] ${job.id} ${name} ${(job.size / 1048576).toFixed(1)} MB`);
          return resolve();
        }
      }
      job.status = 'error';
      const lines = errTail.split('\n').filter(l => /ERROR/.test(l));
      job.error = job.error || (lines.pop() || `yt-dlp exited with code ${code}`).replace(/^.*?ERROR:\s*/, '').slice(0, 300);
      console.warn(`[error] ${job.id}: ${job.error}`);
      removeJobFiles(job.id);   // delete partial downloads right away
      resolve();
    };
    proc.on('error', err => { job.error = 'yt-dlp not found: ' + err.message; finish(-1); });
    proc.on('close', finish);
  });
}

function removeJobFiles(prefix) {
  for (const f of fs.readdirSync(TMP)) if (f.startsWith(prefix + '.')) fs.rmSync(path.join(TMP, f), { recursive: true, force: true });
}

// Housekeeping: delivered files, idle files and orphans (small VPS disks).
function sweep() {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.proc || j.active > 0) continue;                       // still downloading from YouTube / still streaming
    const idle = now - Math.max(j.lastAccess, j.finished || 0);
    if (j.status === 'error' && idle > FILE_TTL_MS) { removeJob(j); continue; }
    if (j.delivered && idle > DELIVERED_GRACE_MS) {
      console.log(`[clean] ${j.id} delivered`); removeJob(j);
    } else if (j.finished && idle > FILE_TTL_MS) {
      console.log(`[clean] ${j.id} idle ${Math.round(idle / 60e3)} min`); removeJob(j);
    }
  }
  // orphans: files whose job is gone (e.g. evicted, crashed process)
  const live = [...jobs.keys()];
  for (const f of fs.readdirSync(TMP)) {
    if (f === '.cache' || live.some(id => f.startsWith(id + '.'))) continue;
    const full = path.join(TMP, f);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > FILE_TTL_MS) { fs.rmSync(full, { recursive: true, force: true }); console.log(`[clean] orphan ${f}`); }
    } catch {}
  }
}
setInterval(sweep, Math.min(60e3, FILE_TTL_MS / 2, DELIVERED_GRACE_MS)).unref();

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(cors({
  origin: ORIGINS,
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
  maxAge: 86400,
}));

app.get('/health', (req, res) => res.json({ ok: true, jobs: jobs.size, running }));

app.post('/api/prepare', express.json({ limit: '2kb' }), (req, res) => {
  const { url, type } = req.body || {};
  const vid = parseYouTubeId(url);
  if (!vid) return res.status(400).json({ error: 'Invalid YouTube link' });
  const job = startJob(vid, type);
  if (!job) return res.status(503).json({ error: 'Server busy, try later' });
  res.json(publicJob(job));
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store').json(publicJob(job));
});

app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'ready' || !job.file) return res.status(404).json({ error: 'not ready' });
  job.lastAccess = Date.now(); // keep file alive while the phone is still downloading
  job.active++;
  // Does this request reach the end of the file? (no Range, or Range ending at the last byte)
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const toEnd = !m || !m[2] || Number(m[2]) >= job.size - 1;
  let done = false;
  res.on('finish', () => { if (toEnd) job.delivered = Date.now(); });   // phone has the last byte
  res.on('close', () => {                                               // finished OR client disconnected
    if (done) return; done = true;
    job.active = Math.max(0, job.active - 1);
    job.lastAccess = Date.now();   // partial: kept for HTTP Range resume, removed after FILE_TTL_MIN idle
  });
  res.setHeader('Content-Type', job.mime);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(job.file, { acceptRanges: true }, err => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
});

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(t); }
}

app.get('/api/info', async (req, res) => {
  const vid = parseYouTubeId(req.query.url);
  if (!vid) return res.status(400).json({ error: 'Invalid YouTube link' });
  try {
    const r = await fetchWithTimeout(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`, 8000);
    if (!r.ok) throw new Error('oembed ' + r.status);
    const d = await r.json();
    res.set('Cache-Control', 'public, max-age=86400').json({
      videoId: vid, title: d.title || '', author: d.author_name || '',
      thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
    });
  } catch (e) {
    res.status(502).json({ error: 'info unavailable', videoId: vid });
  }
});

// Tiny thumbnail proxy (adds CORS so the app can store it offline).
app.get('/api/thumb/:vid', async (req, res) => {
  const vid = req.params.vid;
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return res.status(400).end();
  try {
    const r = await fetchWithTimeout(`https://i.ytimg.com/vi/${vid}/default.jpg`, 8000);
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' }).send(buf);
  } catch {
    res.status(502).end();
  }
});

// ---------- JSON files (catalog.json, sources.json) ----------
function loadJsonList(file, seedFile, fallback) {
  try {
    if (!fs.existsSync(file) && fs.existsSync(seedFile)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(seedFile, file);
      console.log(`[data] seeded ${path.basename(file)} from ${path.basename(seedFile)}`);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : fallback;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[data] could not read ${file}:`, e.message);
    return fallback;
  }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);   // atomic: never leaves a half-written file
}

// ---------- Curated catalog ----------
function saveCatalog() { saveJson(CATALOG_FILE, catalog); }
let catalog = loadJsonList(CATALOG_FILE, CATALOG_SEED, []);

// PIN check with constant-time compare + lockout after 5 wrong tries (15 min, per IP).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
const pinFails = new Map();
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function requirePin(req, res, next) {
  const now = Date.now();
  const f = pinFails.get(req.ip);
  if (f && f.until > now) return res.status(429).json({ error: 'Too many wrong PINs. Try again in 15 minutes.' });
  if (crypto.timingSafeEqual(sha(req.get('x-admin-pin') || ''), sha(ADMIN_PIN))) {
    pinFails.delete(req.ip);
    return next();
  }
  const n = (f && !f.until ? f.n : 0) + 1;
  pinFails.set(req.ip, n >= 5 ? { n, until: now + 15 * 60e3 } : { n, until: 0 });
  res.status(401).json({ error: 'Wrong PIN' });
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of pinFails) if (f.until && f.until < now) pinFails.delete(ip);
}, 30 * 60e3).unref();

function ytGetTitle(vid) {
  return new Promise(resolve => {
    const args = [
      '--get-title', '--no-playlist', '--no-warnings',
      ...(JS_RUNTIME ? ['--js-runtimes', JS_RUNTIME] : []),
      ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
      ...EXTRA_ARGS,
      '--', `https://www.youtube.com/watch?v=${vid}`,
    ];
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { if (out.length < 2000) out += d; });
    const timer = setTimeout(() => p.kill('SIGKILL'), 45000);
    p.on('error', () => { clearTimeout(timer); resolve(''); });
    p.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? out.trim().split('\n')[0].slice(0, 300) : '');
    });
  });
}
async function oembed(vid) {
  try {
    const r = await fetchWithTimeout(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`, 8000);
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

app.get('/api/catalog', (req, res) => {
  res.set('Cache-Control', 'no-store').json(catalog);
});

app.get('/api/admin/check', requirePin, (req, res) => {
  res.json({ ok: true, count: catalog.length, catalogFile: CATALOG_FILE });
});

app.post('/api/catalog', express.json({ limit: '4kb' }), requirePin, async (req, res) => {
  const b = req.body || {};
  const vid = parseYouTubeId(b.youtubeUrl || b.url);
  if (!vid) return res.status(400).json({ error: 'Invalid YouTube link' });
  const mediaType = b.mediaType === 'video' ? 'video' : 'audio';
  const id = `${vid}-${mediaType}`;
  if (catalog.some(c => c.id === id)) return res.status(409).json({ error: 'Already in catalog' });

  let title = String(b.title || '').trim().slice(0, 300);
  let monk = String(b.monk || '').trim().slice(0, 200);
  if (!title || !monk) {
    const [ytTitle, info] = await Promise.all([title ? '' : ytGetTitle(vid), monk ? {} : oembed(vid)]);
    if (!title) title = ytTitle || info.title || (await oembed(vid)).title || `YouTube ${vid}`;
    if (!monk) monk = String(info.author_name || '').slice(0, 200);   // default: channel name
  }
  if (catalog.some(c => c.id === id)) return res.status(409).json({ error: 'Already in catalog' });

  const item = {
    id, youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
    title, monk, mediaType, addedAt: new Date().toISOString(),
  };
  catalog.unshift(item);
  try { saveCatalog(); } catch (e) {
    catalog = catalog.filter(c => c !== item);
    return res.status(500).json({ error: 'Could not save catalog: ' + e.message });
  }
  startJob(vid, mediaType);   // warm up: start preparing the file before the phone asks
  console.log(`[catalog] + ${id} "${title}"`);
  res.status(201).json(item);
});

app.delete('/api/catalog/:id', requirePin, (req, res) => {
  const before = catalog.length;
  catalog = catalog.filter(c => c.id !== req.params.id);
  if (catalog.length === before) return res.status(404).json({ error: 'not found' });
  saveCatalog();
  console.log(`[catalog] - ${req.params.id}`);
  res.json({ ok: true });
});

// ---------- Suggestion sources & feed ----------
let sources = loadJsonList(SOURCES_FILE, SOURCES_SEED, DEFAULT_SOURCES.slice());

// Accept: "ytsearch8:words", plain words (-> search), YouTube channel or playlist URLs. Nothing else.
function normalizeSource(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/^ytsearch(\d{0,2}):(.+)$/i);
  if (m) {
    const n = Math.min(Math.max(parseInt(m[1] || '8', 10) || 8, 1), 20);
    const q = m[2].trim().slice(0, 200);
    return q ? `ytsearch${n}:${q}` : null;
  }
  let u;
  try { u = new URL(s); } catch { return s.length <= 200 ? `ytsearch${SUGGEST_PER_SOURCE}:${s}` : null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host !== 'youtube.com') return null;
  const list = u.searchParams.get('list');
  if (list && /^[A-Za-z0-9_-]{10,64}$/.test(list)) return `https://www.youtube.com/playlist?list=${list}`;
  const ch = u.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(videos|streams|featured|shorts))?\/?$/);
  // a bare channel URL lists its tabs, so point it at the uploads ("videos") tab
  if (ch) return `https://www.youtube.com/${ch[1]}/${ch[2] && ch[2] !== 'featured' ? ch[2] : 'videos'}`;
  return null;
}

function fetchSourceEntries(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--flat-playlist', '--dump-single-json', '--playlist-end', String(SUGGEST_PER_SOURCE),
      '--no-warnings', '--socket-timeout', '30',
      ...(COOKIES_FILE ? ['--cookies', COOKIES_FILE] : []),
      ...EXTRA_ARGS,
      '--', url,
    ];
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outLen = 0, err = '';
    p.stdout.on('data', d => { outLen += d.length; if (outLen < 5e6) out.push(d); });
    p.stderr.on('data', d => { err = (err + d).slice(-600); });
    const timer = setTimeout(() => p.kill('SIGKILL'), 90000);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err.split('\n').filter(l => /ERROR/.test(l)).pop() || `yt-dlp exit ${code}`).replace(/^.*?ERROR:\s*/, '').slice(0, 200)));
      try {
        const json = JSON.parse(Buffer.concat(out).toString('utf8'));
        const items = [];
        for (const e of json.entries || []) {
          if (!e || !/^[A-Za-z0-9_-]{11}$/.test(e.id || '')) continue;
          if (e.live_status === 'is_live' || e.live_status === 'is_upcoming') continue;
          if (/^\[(private|deleted)/i.test(e.title || '')) continue;
          if (e.duration && e.duration < 120) continue;            // skip Shorts / clips
          if (e.duration && e.duration > SUGGEST_MAX_SEC) continue; // too big for a 2 GB phone
          items.push({
            id: e.id,
            title: String(e.title || '').slice(0, 300),
            thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
            duration: Math.round(e.duration || 0),
            url: `https://www.youtube.com/watch?v=${e.id}`,
            channel: String(e.channel || e.uploader || json.channel || json.uploader || '').slice(0, 200),
          });
        }
        resolve(items);
      } catch (e) { reject(new Error('bad yt-dlp output')); }
    });
  });
}

// In-memory cache: served instantly for SUGGEST_TTL; after that the stale copy is still served
// while a refresh runs in the background. A failing source keeps its previous results.
const sugg = { data: null, at: 0, inflight: null, dirty: false, perSource: new Map() };
function buildSuggestions() {
  if (sugg.inflight) return sugg.inflight;
  sugg.dirty = false;
  const srcs = sources.slice();
  sugg.inflight = (async () => {
    const status = [];
    for (const s of srcs) {   // one at a time: gentle on YouTube and on a tiny free server
      try {
        const items = await fetchSourceEntries(s.url);
        sugg.perSource.set(s.url, items);
        status.push({ id: s.id, label: s.label, ok: true, count: items.length });
      } catch (e) {
        status.push({ id: s.id, label: s.label, ok: false, error: e.message, count: (sugg.perSource.get(s.url) || []).length });
      }
    }
    // Round-robin merge so every monk appears near the top; drop duplicates.
    const lists = srcs.map(s => (sugg.perSource.get(s.url) || []).map(it => ({ ...it, source: s.label })));
    const seen = new Set(), items = [];
    for (let i = 0; lists.some(l => i < l.length); i++) {
      for (const l of lists) if (l[i] && !seen.has(l[i].id)) { seen.add(l[i].id); items.push(l[i]); }
    }
    sugg.data = { updatedAt: new Date().toISOString(), items, sources: status };
    sugg.at = Date.now();
    console.log(`[suggestions] ${items.length} talks from ${srcs.length} sources`);
    return sugg.data;
  })().finally(() => {
    sugg.inflight = null;
    if (sugg.dirty) buildSuggestions().catch(() => {});
  });
  return sugg.inflight;
}
function sourcesChanged() {
  saveJson(SOURCES_FILE, sources);
  const keep = new Set(sources.map(s => s.url));
  for (const k of sugg.perSource.keys()) if (!keep.has(k)) sugg.perSource.delete(k);
  sugg.at = 0;
  if (sugg.inflight) sugg.dirty = true; else buildSuggestions().catch(() => {});
}
setTimeout(() => buildSuggestions().catch(() => {}), 3000).unref();   // warm the cache at start-up

app.get('/api/suggestions', async (req, res) => {
  try {
    if (sugg.data) {
      if (Date.now() - sugg.at > SUGGEST_TTL_MS) buildSuggestions().catch(() => {});
      return res.set('Cache-Control', 'no-store').json(sugg.data);
    }
    res.set('Cache-Control', 'no-store').json(await buildSuggestions());
  } catch (e) {
    res.status(502).json({ error: 'suggestions unavailable' });
  }
});

app.post('/api/suggestions/refresh', requirePin, async (req, res) => {
  if (sugg.inflight) await sugg.inflight.catch(() => {});
  try { res.json(await buildSuggestions()); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/sources', requirePin, (req, res) => {
  res.json({ sources, status: (sugg.data && sugg.data.sources) || [], updatedAt: sugg.data && sugg.data.updatedAt });
});

app.post('/api/sources', express.json({ limit: '4kb' }), requirePin, (req, res) => {
  const b = req.body || {};
  const url = normalizeSource(b.url);
  if (!url) return res.status(400).json({ error: 'Use a YouTube channel / playlist URL, "ytsearch8:words", or plain search words' });
  if (sources.some(s => s.url === url)) return res.status(409).json({ error: 'Source already added' });
  if (sources.length >= 20) return res.status(400).json({ error: 'Max 20 sources' });
  const label = String(b.label || '').trim().slice(0, 100) ||
    (url.startsWith('ytsearch') ? url.replace(/^ytsearch\d*:/, '') : url.replace('https://www.youtube.com/', ''));
  const item = { id: crypto.randomBytes(4).toString('hex'), url, label, addedAt: new Date().toISOString() };
  sources.push(item);
  sourcesChanged();
  console.log(`[sources] + ${url}`);
  res.status(201).json(item);
});

app.delete('/api/sources/:id', requirePin, (req, res) => {
  const before = sources.length;
  sources = sources.filter(s => s.id !== req.params.id);
  if (sources.length === before) return res.status(404).json({ error: 'not found' });
  sourcesChanged();
  res.json({ ok: true });
});

// Serve the PWA (optional – you can also host /public elsewhere).
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, file) {
      if (/(sw\.js|index\.html|manifest\.json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
}

// HOST=127.0.0.1 keeps the port private when a reverse proxy (Caddy/nginx) sits in front.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Dhamma server on ${HOST}:${PORT}  (yt-dlp: ${YTDLP}, tmp: ${TMP})`);
  console.log(`Catalog: ${CATALOG_FILE} (${catalog.length} talks)`);
  if (!process.env.ADMIN_PIN) console.warn('⚠ ADMIN_PIN not set – using default "1234". Set it before deploying!');
});
