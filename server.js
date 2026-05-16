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
const DELETED_VIDEOS_DIR = path.join(VIDEOS_DIR, 'deleted');
const SFX_DIR = path.join(UPLOADS_DIR, 'sfx');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const VIDEOS_INDEX_PATH = path.join(DATA_DIR, 'videos.json');
const DELETED_VIDEOS_INDEX_PATH = path.join(DATA_DIR, 'videos-deleted.json');

for (const d of [DATA_DIR, UPLOADS_DIR, MP3_DIR, VIDEOS_DIR, SFX_DIR, DELETED_VIDEOS_DIR]) {
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
    // Modele event-driven absolu (cf. kiosk.js runSession). Tous les
    // temps sont en ms depuis T0 (debut session). Le buzzer (1.5s) et
    // le fadeout (10s) sont hardcodes cote front.
    introDurationMs: 5000,    // intro : compte a rebours avant T0 (musique + recording)
    t1Ms: 10000,              // event 1: modal "Faites mieux" + buzzer
    warningDurationMs: 8000,  // duree du compte a rebours du modal warning
    t2Ms: 40000,              // event 2: victoire (son + confettis + modal code)
    t3Ms: 60000,              // event 3: fin enregistrement video
    t4Ms: 90000,              // event 4: disparition modal code
    t5Ms: 0                   // event 5: debut fadeout. 0 = auto (song_duration - 10s)
  },
  emails: [],
  emailsEnabled: true,
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
  // Trickerie visuelle des comptes à rebours (intro + warning). Le temps
  // réel ne change pas (les events serveur ne sont pas touchés), mais
  // l'affichage démarre à N = round(T × multiplier) secondes virtuelles
  // et chaque seconde virtuelle suivante est raccourcie. `intensity` est
  // un % du raccourcissement max théorique (0–100) : 0 % = linéaire,
  // 100 % = la dernière seconde virtuelle dure ~0 ms.
  countdownTrick: {
    intensity: 60,
    multiplier: 2.0
  },
  // Playlist par défaut au premier boot (data/config.json absent). La
  // configuration en place sur l'instance live n'est PAS écrasée par
  // ces valeurs — elles ne servent que pour un clone fresh.
  youtube: [
    { videoId: 'sOnqjkJTMaA', title: 'Michael Jackson — Thriller',                   startSeconds: 565, bpm: 118 },
    { videoId: 'qxa9C2ESdrc', title: 'Macarena (Bayside Boys Remix)',                startSeconds: 0,   bpm: 103 },
    { videoId: '4bPGxLxogvw', title: 'Maître Gims — Sapés comme jamais (ft. Niska)', startSeconds: 0,   bpm: 100 },
    { videoId: 'dguwagsajok', title: 'Bratisla Boys — Stach Stach',                  startSeconds: 30,  bpm: 135 },
    { videoId: 'gJLIiF15wjQ', title: 'Spice Girls — Wannabe',                        startSeconds: 49,  bpm: 110 },
    { videoId: 'ZRaOzXS1slI', title: 'Claude François — Alexandrie Alexandra',       startSeconds: 0,   bpm: 124 }
  ],
  // Metadonnees BPM par fichier MP3, indexees par nom de fichier (e.g.
  // "song.mp3"). Permet de piloter l'animation du danseur sur le tempo
  // du morceau en cours. 0 ou absent = vitesse par defaut.
  mp3Meta: {},
  // Modales annexes (independantes de la timeline T1-T5). Chaque entree
  // declenche un overlay au timestamp `t` (ms depuis T0) avec titre +
  // message pendant `duration`. N'affecte pas la musique ni les events.
  // Si deux modales se chevauchent : la suivante remplace la precedente.
  customModals: [],
  // Toutes les lignes de texte affichées sur le kiosk, éditables via
  // l'admin. Le DOM correspondant est repéré par data-text="<clé>".
  // Seule `warningBody` est rendue en innerHTML (pour autoriser <em>).
  texts: {
    overline:        "Mariage · Just Married",
    title:           "Dance Escape",
    subtitle:        "Saurez-vous danser jusqu'au code secret ?",
    startButton:     "Démarrer la danse",
    hint:            "Activez votre micro et votre caméra à la demande du navigateur.",
    introTitle:      "Préparez-vous !",
    introBody:       "Dansez pour découvrir le code secret. Que le show commence !",
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

// Migre une config v1.x (schema phase1/victoryStart/total/victoryModal) vers
// le schema event-driven (t1/t2/t3/t4/t5). Garde les vieilles cles si
// presentes pour ne casser aucun consommateur, mais ajoute les nouvelles.
function migrateTimings(t) {
  if (!t || typeof t !== 'object') return t;
  // Si t1Ms est deja la, c'est deja le nouveau schema -> rien a faire.
  if (typeof t.t1Ms === 'number') return t;
  const out = {};
  if (typeof t.phase1DurationMs === 'number') out.t1Ms = t.phase1DurationMs;
  if (typeof t.warningModalMs === 'number')   out.warningDurationMs = t.warningModalMs;
  if (typeof t.victoryStartMs === 'number')   out.t2Ms = t.victoryStartMs;
  if (typeof t.totalDurationMs === 'number')  out.t3Ms = t.totalDurationMs;
  if (typeof t.totalDurationMs === 'number' && typeof t.victoryModalMs === 'number') {
    out.t4Ms = t.totalDurationMs + t.victoryModalMs;
  }
  if (typeof t.postModalMaxMs === 'number') {
    out.t5Ms = t.postModalMaxMs > 0 && typeof out.t4Ms === 'number' ? out.t4Ms + t.postModalMaxMs : 0;
  }
  // Les anciennes cles (phase1DurationMs, victoryStartMs, etc.) sont
  // intentionnellement abandonnees - elles ne sont plus lues nulle part.
  return out;
}

function loadConfig() {
  const raw = readJson(CONFIG_PATH, null);
  if (raw && raw.timings) raw.timings = migrateTimings(raw.timings);
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

function loadDeletedVideos() {
  return readJson(DELETED_VIDEOS_INDEX_PATH, []);
}

function saveDeletedVideos(list) {
  writeJsonAtomic(DELETED_VIDEOS_INDEX_PATH, list);
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
  const mp3Meta = (cfg.mp3Meta && typeof cfg.mp3Meta === 'object') ? cfg.mp3Meta : {};
  const mp3Files = fs.readdirSync(MP3_DIR)
    .filter(f => f.toLowerCase().endsWith('.mp3'))
    .map(f => ({
      type: 'mp3',
      url: '/uploads/mp3/' + encodeURIComponent(f),
      title: f.replace(/\.mp3$/i, ''),
      filename: f,
      bpm: Number.isFinite(mp3Meta[f] && mp3Meta[f].bpm) ? mp3Meta[f].bpm : 0
    }));
  const ytItems = (cfg.youtube || []).map(y => ({
    type: 'youtube',
    videoId: y.videoId,
    title: y.title || y.videoId,
    startSeconds: Number.isFinite(y.startSeconds) ? y.startSeconds : 0,
    bpm: Number.isFinite(y.bpm) ? y.bpm : 0
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
    texts: cfg.texts || DEFAULT_CONFIG.texts,
    customModals: Array.isArray(cfg.customModals) ? cfg.customModals : [],
    countdownTrick: cfg.countdownTrick || DEFAULT_CONFIG.countdownTrick
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

// Endpoint PUBLIC (pas de Basic Auth) pour le viewer /v.html : retourne
// metadata d'une video par id. Volontairement minimal : pas de leak
// d'autres infos systeme. Comme l'id est un random crypto.randomBytes(6)
// = 48 bits, non-guessable, c'est le meme modele de securite que le
// filename direct dans /uploads/videos/.
app.get('/api/v/:id', (req, res) => {
  const id = req.params.id;
  const v = loadVideos().find(x => x.id === id);
  if (!v) return res.status(404).json({ error: 'not found' });
  res.json({
    id: v.id,
    filename: v.filename,
    music: v.music || '',
    createdAt: v.createdAt,
    size: v.size,
    url: '/uploads/videos/' + encodeURIComponent(v.filename)
  });
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
  if (cfg.emailsEnabled === false) {
    console.log('[mail] disabled by admin toggle, skipping');
    return;
  }
  if (!emails || emails.length === 0) return;
  if (!smtp.host || !smtp.user) {
    console.log('[mail] SMTP not configured, skipping');
    return;
  }
  const base = publicBaseUrl || '';
  // Lien vers la page web publique de visionnage. Le destinataire n'a
  // pas les credentials admin, c'est une route publique non listée.
  const link = `${base}/v.html?id=${encodeURIComponent(meta.id)}`;
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
  if (typeof incoming.emailsEnabled === 'boolean') {
    cur.emailsEnabled = incoming.emailsEnabled;
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
  if (incoming.countdownTrick && typeof incoming.countdownTrick === 'object') {
    cur.countdownTrick = cur.countdownTrick || { ...DEFAULT_CONFIG.countdownTrick };
    const intensity = Number(incoming.countdownTrick.intensity);
    const multiplier = Number(incoming.countdownTrick.multiplier);
    // intensity = % du raccourcissement max théorique [0, 100].
    // multiplier = facteur de gonflage initial [1, 10].
    if (Number.isFinite(intensity)) cur.countdownTrick.intensity = Math.max(0, Math.min(100, intensity));
    if (Number.isFinite(multiplier)) cur.countdownTrick.multiplier = Math.max(1, Math.min(10, multiplier));
  }
  if (Array.isArray(incoming.youtube)) {
    cur.youtube = incoming.youtube
      .map(y => {
        const s = Number(y.startSeconds);
        const b = Number(y.bpm);
        return {
          videoId: String(y.videoId || '').trim(),
          title: String(y.title || '').trim(),
          startSeconds: Number.isFinite(s) && s >= 0 ? Math.floor(s) : 0,
          // BPM réaliste : 30–300. 0 = aucune valeur, animation par défaut.
          bpm: Number.isFinite(b) && b >= 30 && b <= 300 ? Math.round(b) : 0
        };
      })
      .filter(y => y.videoId);
  }
  if (incoming.mp3Meta && typeof incoming.mp3Meta === 'object') {
    // On écrase la map complète. Validation : clé = nom safe, valeur = { bpm }.
    const next = {};
    for (const k of Object.keys(incoming.mp3Meta)) {
      if (!isSafeName(k)) continue;
      const entry = incoming.mp3Meta[k];
      if (!entry || typeof entry !== 'object') continue;
      const b = Number(entry.bpm);
      if (Number.isFinite(b) && b >= 30 && b <= 300) {
        next[k] = { bpm: Math.round(b) };
      }
    }
    cur.mp3Meta = next;
  }
  if (Array.isArray(incoming.customModals)) {
    cur.customModals = incoming.customModals
      .map((m, i) => {
        const t = Number(m.t);
        const d = Number(m.duration);
        return {
          id: String(m.id || ('m' + (i + 1))).trim(),
          t: Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0,
          duration: Number.isFinite(d) && d >= 0 ? Math.floor(d) : 3000,
          title: String(m.title || '').trim(),
          message: String(m.message || '').trim()
        };
      })
      .filter(m => m.title || m.message);
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
  // Nettoie aussi l'entrée mp3Meta orpheline si elle existait.
  const cfg = loadConfig();
  if (cfg.mp3Meta && cfg.mp3Meta[name]) {
    delete cfg.mp3Meta[name];
    saveConfig(cfg);
  }
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

// SOFT DELETE : ne supprime pas le fichier, le deplace dans
// uploads/videos/deleted/ + ajoute a videos-deleted.json. La page
// videoscontrol.html (cachee, sans lien dans la nav) liste/restaure
// ces videos. Le hard-delete se fait depuis videoscontrol.
app.delete('/api/admin/videos/:id', (req, res) => {
  const id = req.params.id;
  const list = loadVideos();
  const idx = list.findIndex(v => v.id === id);
  if (idx < 0) return res.status(404).json({ error: 'introuvable' });
  const [removed] = list.splice(idx, 1);
  saveVideos(list);
  try {
    const src = path.join(VIDEOS_DIR, removed.filename);
    const dst = path.join(DELETED_VIDEOS_DIR, removed.filename);
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  } catch (e) {
    console.warn('[videos] soft-delete move failed:', e.message);
  }
  const trashed = loadDeletedVideos();
  trashed.unshift({ ...removed, deletedAt: new Date().toISOString() });
  saveDeletedVideos(trashed);
  res.json({ ok: true });
});

// Liste des videos soft-supprimees (pour videoscontrol.html).
app.get('/api/admin/videos-deleted', (_req, res) => res.json(loadDeletedVideos()));

// HARD DELETE : retire definitivement le fichier ET l'entree.
app.delete('/api/admin/videos-deleted/:id', (req, res) => {
  const id = req.params.id;
  const list = loadDeletedVideos();
  const idx = list.findIndex(v => v.id === id);
  if (idx < 0) return res.status(404).json({ error: 'introuvable' });
  const [removed] = list.splice(idx, 1);
  saveDeletedVideos(list);
  try {
    const p = path.join(DELETED_VIDEOS_DIR, removed.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.warn('[videos] hard-delete file failed:', e.message);
  }
  res.json({ ok: true });
});

// RESTORE : remet la video dans la liste active.
app.post('/api/admin/videos-deleted/:id/restore', (req, res) => {
  const id = req.params.id;
  const trashed = loadDeletedVideos();
  const idx = trashed.findIndex(v => v.id === id);
  if (idx < 0) return res.status(404).json({ error: 'introuvable' });
  const [restored] = trashed.splice(idx, 1);
  saveDeletedVideos(trashed);
  try {
    const src = path.join(DELETED_VIDEOS_DIR, restored.filename);
    const dst = path.join(VIDEOS_DIR, restored.filename);
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  } catch (e) {
    console.warn('[videos] restore move failed:', e.message);
  }
  const active = loadVideos();
  // Retire deletedAt avant remise en liste active
  const { deletedAt: _drop, ...clean } = restored;
  active.unshift(clean);
  saveVideos(active);
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
