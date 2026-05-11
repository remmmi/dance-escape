'use strict';

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const MP3_DIR = path.join(UPLOADS_DIR, 'mp3');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const SFX_DIR = path.join(UPLOADS_DIR, 'sfx');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const VIDEOS_INDEX_PATH = path.join(DATA_DIR, 'videos.json');

for (const d of [DATA_DIR, UPLOADS_DIR, MP3_DIR, VIDEOS_DIR, SFX_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Custom sound effects (one file per kind: buzzer, victory).
// Stored as <kind>.<ext> in SFX_DIR — any ext OK as long as the browser
// can decode it. Whitelist of kinds prevents path injection.
const SFX_KINDS = ['buzzer', 'victory'];
function findSfxFile(kind) {
  if (!SFX_KINDS.includes(kind)) return null;
  try {
    const re = new RegExp('^' + kind + '\\.', 'i');
    return fs.readdirSync(SFX_DIR).find(f => re.test(f)) || null;
  } catch { return null; }
}
function sfxUrl(kind) {
  const f = findSfxFile(kind);
  return f ? '/uploads/sfx/' + encodeURIComponent(f) : null;
}
function deleteSfx(kind) {
  if (!SFX_KINDS.includes(kind)) return;
  try {
    const re = new RegExp('^' + kind + '\\.', 'i');
    fs.readdirSync(SFX_DIR).filter(f => re.test(f))
      .forEach(f => { try { fs.unlinkSync(path.join(SFX_DIR, f)); } catch {} });
  } catch {}
}

// Defaults = state actuellement en prod (versionné dans data/config.json
// aussi, mais ça sert de fallback si le fichier est supprimé). Modifier
// ici si on veut shipper un nouveau preset.
const DEFAULT_CONFIG = {
  timings: {
    phase1DurationMs: 10000,
    buzzerDurationMs: 0,
    warningModalMs: 8000,
    victoryStartMs: 40000,
    totalDurationMs: 60000,
    victoryModalMs: 30000
  },
  emails: [],
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    from: ''
  },
  secretCode: 'CODE-SECRET',
  publicBaseUrl: '',
  youtube: [
    { videoId: 'K4Jkh5aAn-0', title: "au pays d'aragon..",                startSeconds: 0  },
    { videoId: 'yURRmWtbTbo', title: "MJ Don't Stop 'Til You Get Enough", startSeconds: 14 },
    { videoId: 'ZNaXb3uuekk', title: "Sex Machine",                       startSeconds: 11 }
  ],
  // Toutes les lignes de texte affichées sur le kiosk, éditables via
  // l'admin. Le DOM correspondant est repéré par data-text="<clé>".
  // Seule `warningBody` est rendue en innerHTML (pour autoriser <em>).
  texts: {
    overline:        "Mariage · Just Married",
    title:           "Dance Escape",
    subtitle:        "Saurez-vous danser jusqu'au code secret ?",
    startButton:     "Démarrer la danse",
    hint:            "Activez votre micro et votre caméra à la demande du navigateur.",
    danceCall:       "Dansez !",
    danceSub:        "Énergie, sourires, mouvements…",
    warningTitle:    "Pas encore ça !",
    warningBody:     "Il va falloir y mettre <em>plus d'énergie</em> et de chorégraphie…",
    warningSub:      "Reprenez de plus belle !",
    victoryOverline: "Bravo !",
    victoryTitle:    "Code secret",
    victorySub:      "Notez-le bien et passez à l'épreuve suivante."
  }
};

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function mergeDefaults(target, defaults) {
  if (target == null || typeof target !== 'object') return defaults;
  const out = Array.isArray(defaults) ? [...target] : { ...defaults, ...target };
  if (!Array.isArray(defaults)) {
    for (const k of Object.keys(defaults)) {
      if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
        out[k] = mergeDefaults(target[k], defaults[k]);
      }
    }
  }
  return out;
}

function loadConfig() {
  const raw = readJson(CONFIG_PATH, null);
  const cfg = mergeDefaults(raw || {}, DEFAULT_CONFIG);
  if (!raw) writeJsonAtomic(CONFIG_PATH, cfg);
  return cfg;
}

function saveConfig(cfg) {
  writeJsonAtomic(CONFIG_PATH, cfg);
}

function loadVideos() {
  return readJson(VIDEOS_INDEX_PATH, []);
}

function saveVideos(list) {
  writeJsonAtomic(VIDEOS_INDEX_PATH, list);
}

const safeNameRe = /^[A-Za-z0-9._-]+$/;
function isSafeName(n) {
  return typeof n === 'string' && safeNameRe.test(n) && !n.includes('..');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Static
app.use('/uploads/mp3', express.static(MP3_DIR, { fallthrough: true }));
app.use('/uploads/videos', express.static(VIDEOS_DIR, { fallthrough: true }));
app.use('/uploads/sfx', express.static(SFX_DIR, { fallthrough: true }));
app.use(express.static(path.join(ROOT, 'public')));

// ---- Public kiosk APIs ----
app.get('/api/session/config', (_req, res) => {
  const cfg = loadConfig();
  // Build playlist from disk mp3s + youtube entries
  const mp3Files = fs.readdirSync(MP3_DIR)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .map(f => ({ type: 'mp3', url: '/uploads/mp3/' + encodeURIComponent(f), title: f.replace(/\.mp3$/i, '') }));
  const ytItems = (cfg.youtube || []).map(y => ({
    type: 'youtube',
    videoId: y.videoId,
    title: y.title || y.videoId,
    startSeconds: Number.isFinite(y.startSeconds) ? y.startSeconds : 0
  }));
  const playlist = [...mp3Files, ...ytItems];
  res.json({
    timings: cfg.timings,
    secretCode: cfg.secretCode,
    playlist,
    sfx: {
      buzzerUrl: sfxUrl('buzzer'),
      victoryUrl: sfxUrl('victory')
    },
    texts: cfg.texts || DEFAULT_CONFIG.texts
  });
});

// Upload recorded video
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIDEOS_DIR),
    filename: (_req, file, cb) => {
      const id = crypto.randomBytes(6).toString('hex');
      const ext = file.mimetype.includes('mp4') ? '.mp4' : '.webm';
      cb(null, `${Date.now()}-${id}${ext}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/api/session/upload', videoUpload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const meta = {
    id: crypto.randomBytes(6).toString('hex'),
    filename: req.file.filename,
    size: req.file.size,
    createdAt: new Date().toISOString(),
    music: (req.body && req.body.music) || '',
    musicType: (req.body && req.body.musicType) || ''
  };
  const videos = loadVideos();
  videos.unshift(meta);
  saveVideos(videos);

  // Async email
  sendVideoEmail(meta).catch(err => console.error('[mail] send failed:', err.message));

  res.json({ ok: true, video: meta });
});

async function sendVideoEmail(meta) {
  const cfg = loadConfig();
  const { smtp, emails, publicBaseUrl } = cfg;
  if (!emails || emails.length === 0) return;
  if (!smtp.host || !smtp.user) {
    console.log('[mail] SMTP not configured, skipping');
    return;
  }
  const base = publicBaseUrl || '';
  const link = `${base}/uploads/videos/${meta.filename}`;
  const adminLink = `${base}/justmarried/videos.html`;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: !!smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass }
  });
  const from = smtp.from || smtp.user;
  await transporter.sendMail({
    from,
    to: emails.join(', '),
    subject: 'Nouvelle danse enregistrée 💃',
    text: `Une nouvelle danse vient d'être enregistrée.\n\nLien vidéo : ${link}\nAdmin : ${adminLink}\n\nMusique : ${meta.music}\nDate : ${meta.createdAt}`,
    html: `<p>Une nouvelle danse vient d'être enregistrée.</p>
           <p><a href="${link}">Voir la vidéo</a></p>
           <p>Musique : <em>${escapeHtml(meta.music)}</em><br>Date : ${meta.createdAt}</p>
           <p><a href="${adminLink}">Ouvrir l'admin</a></p>`
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Admin APIs (unprotected, under /justmarried) ----
app.get('/api/admin/config', (_req, res) => res.json(loadConfig()));

app.post('/api/admin/config', (req, res) => {
  const cur = loadConfig();
  const incoming = req.body || {};
  // Whitelist update
  if (incoming.timings) {
    for (const k of Object.keys(cur.timings)) {
      if (typeof incoming.timings[k] === 'number' && incoming.timings[k] >= 0) {
        cur.timings[k] = Math.floor(incoming.timings[k]);
      }
    }
  }
  if (Array.isArray(incoming.emails)) {
    cur.emails = incoming.emails.map(s => String(s).trim()).filter(Boolean);
  }
  if (incoming.smtp && typeof incoming.smtp === 'object') {
    for (const k of ['host', 'user', 'pass', 'from']) {
      if (typeof incoming.smtp[k] === 'string') cur.smtp[k] = incoming.smtp[k];
    }
    if (typeof incoming.smtp.port === 'number') cur.smtp.port = incoming.smtp.port;
    if (typeof incoming.smtp.secure === 'boolean') cur.smtp.secure = incoming.smtp.secure;
  }
  if (typeof incoming.secretCode === 'string') cur.secretCode = incoming.secretCode;
  if (incoming.texts && typeof incoming.texts === 'object') {
    cur.texts = cur.texts || {};
    // Only accept keys that exist in the default schema — prevents
    // arbitrary key injection. Empty string is a valid value (admin
    // may want to blank out a line).
    for (const k of Object.keys(DEFAULT_CONFIG.texts)) {
      if (typeof incoming.texts[k] === 'string') cur.texts[k] = incoming.texts[k];
    }
  }
  if (typeof incoming.publicBaseUrl === 'string') cur.publicBaseUrl = incoming.publicBaseUrl.replace(/\/+$/, '');
  if (Array.isArray(incoming.youtube)) {
    cur.youtube = incoming.youtube
      .map(y => {
        const s = Number(y.startSeconds);
        return {
          videoId: String(y.videoId || '').trim(),
          title: String(y.title || '').trim(),
          startSeconds: Number.isFinite(s) && s >= 0 ? Math.floor(s) : 0
        };
      })
      .filter(y => y.videoId);
  }
  saveConfig(cur);
  res.json({ ok: true, config: cur });
});

app.post('/api/admin/smtp-test', async (req, res) => {
  try {
    const cfg = loadConfig();
    const to = (req.body && req.body.to) || (cfg.emails && cfg.emails[0]);
    if (!to) return res.status(400).json({ error: 'pas de destinataire' });
    const t = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: !!cfg.smtp.secure,
      auth: { user: cfg.smtp.user, pass: cfg.smtp.pass }
    });
    await t.sendMail({
      from: cfg.smtp.from || cfg.smtp.user,
      to,
      subject: 'Test Dance-Escape ✓',
      text: 'Le SMTP fonctionne !'
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// MP3 list / upload / delete
app.get('/api/admin/mp3', (_req, res) => {
  const files = fs.readdirSync(MP3_DIR)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .map(f => {
      const st = fs.statSync(path.join(MP3_DIR, f));
      return { name: f, size: st.size, url: '/uploads/mp3/' + encodeURIComponent(f) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(files);
});

const mp3Upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MP3_DIR),
    filename: (_req, file, cb) => {
      const base = path.basename(file.originalname).replace(/[^A-Za-z0-9._-]/g, '_');
      const safe = base.toLowerCase().endsWith('.mp3') ? base : base + '.mp3';
      cb(null, safe);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/\.mp3$/i.test(file.originalname)) return cb(new Error('MP3 uniquement'));
    cb(null, true);
  }
});

app.post('/api/admin/mp3', mp3Upload.array('files', 20), (req, res) => {
  res.json({ ok: true, count: (req.files || []).length });
});

app.delete('/api/admin/mp3/:name', (req, res) => {
  const name = req.params.name;
  if (!isSafeName(name)) return res.status(400).json({ error: 'nom invalide' });
  const p = path.join(MP3_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'introuvable' });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

// SFX (buzzer / victory) — upload, info, delete
const sfxAllowedRe = /\.(wav|ogg|opus|mp3|m4a|aac|webm|flac)$/i;
function sfxMulter(kind) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, SFX_DIR),
      filename: (_req, file, cb) => {
        const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]+$/) || ['.wav'])[0];
        cb(null, kind + ext);
      }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (/^audio\//.test(file.mimetype) || sfxAllowedRe.test(file.originalname)) return cb(null, true);
      cb(new Error('Fichier audio uniquement (wav, ogg, mp3, m4a, opus...)'));
    }
  });
}

app.get('/api/admin/sfx/:kind', (req, res) => {
  const kind = req.params.kind;
  if (!SFX_KINDS.includes(kind)) return res.status(404).json({ error: 'kind inconnu' });
  const f = findSfxFile(kind);
  if (!f) return res.json({ url: null, name: null, size: 0 });
  const st = fs.statSync(path.join(SFX_DIR, f));
  res.json({ url: '/uploads/sfx/' + encodeURIComponent(f), name: f, size: st.size });
});

app.post('/api/admin/sfx/:kind', (req, res) => {
  const kind = req.params.kind;
  if (!SFX_KINDS.includes(kind)) return res.status(404).json({ error: 'kind inconnu' });
  deleteSfx(kind); // remove any previous file (different ext etc.)
  sfxMulter(kind).single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    res.json({ ok: true, name: req.file.filename, url: '/uploads/sfx/' + encodeURIComponent(req.file.filename) });
  });
});

app.delete('/api/admin/sfx/:kind', (req, res) => {
  const kind = req.params.kind;
  if (!SFX_KINDS.includes(kind)) return res.status(404).json({ error: 'kind inconnu' });
  deleteSfx(kind);
  res.json({ ok: true });
});

// Videos list / delete
app.get('/api/admin/videos', (_req, res) => res.json(loadVideos()));

app.delete('/api/admin/videos/:id', (req, res) => {
  const id = req.params.id;
  const list = loadVideos();
  const idx = list.findIndex(v => v.id === id);
  if (idx < 0) return res.status(404).json({ error: 'introuvable' });
  const [removed] = list.splice(idx, 1);
  saveVideos(list);
  try {
    const p = path.join(VIDEOS_DIR, removed.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.warn('[videos] delete file failed:', e.message);
  }
  res.json({ ok: true });
});

// Fallback for SPA-like paths (none here, but ensure /justmarried/ resolves to index)
app.get('/justmarried', (_req, res) => res.redirect('/justmarried/index.html'));
app.get('/justmarried/', (_req, res) => res.redirect('/justmarried/index.html'));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`💃 Dance Escape démarré sur http://${HOST}:${PORT}`);
  console.log(`   Kiosk      → http://${HOST}:${PORT}/`);
  console.log(`   Admin      → http://${HOST}:${PORT}/justmarried/`);
});
