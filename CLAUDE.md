# CLAUDE.md — Dance Escape

Ce fichier fournit des directives à Claude Code (claude.ai/code) lorsqu'il
travaille dans ce dépôt. Lis-le d'abord : il décrit ce qu'est l'app, son
architecture, sa direction artistique et comment la lancer.

## 1. Le projet

**Dance Escape** est une mini-app web *one-shot* pour une épreuve d'escape
room le jour d'un mariage. Les invités arrivent devant un PC en mode
kiosk, cliquent sur « Démarrer la danse », sont filmés pendant 40 s
pendant qu'une musique joue, déclenchent un faux échec (buzzer + modal
« faites mieux »), puis obtiennent un code secret accompagné de
confettis. La vidéo est envoyée par email aux mariés.

- Usage **éphémère** (un seul mariage) — ne pas sur-architecturer.
- Doit être **portable** : `git clone && npm install && npm start`
  marche en local, sur un VPS, ou dans Codespaces.
- Stockage **fichier plat** (JSON + fichiers). Pas de base de données.
- L'admin sur `/justmarried/` n'est **pas protégé** (chemin obscur
  suffit pour la durée d'un mariage).

## 2. Stack & dépendances

- **Node ≥ 18** (testé en 22).
- `express` — serveur HTTP + statique
- `multer` (v2) — uploads multipart (MP3, vidéos, **SFX**)
- `nodemailer` — envoi email SMTP configuré par l'admin
- Front : **vanilla JS / HTML / CSS** (zéro build, zéro framework). Web
  Audio API pour synth buzzer/victoire + **AudioBuffer cache** pour
  MP3 préchargés et SFX custom, canvas pour confettis, YouTube iframe
  API pour audio YouTube avec **pre-warming muted-autoplay**.

Pas de bundler, pas de TypeScript, pas de tests. Pas de Docker
(volontaire — trop lourd pour du one-shot).

## 3. Démarrer

```bash
npm install
npm start             # PORT=3000 par défaut
# ou
npm run dev           # node --watch
```

- Kiosk : http://localhost:3000/
- Admin : http://localhost:3000/justmarried/

Variables d'env : `PORT`, `HOST`.

### Pour la webcam

`getUserMedia` exige **HTTPS** ou **localhost**. En dev local, ouvre
`http://localhost:3000/`. Sur Codespaces, l'URL forwardée est
automatiquement en HTTPS. Sur un VPS, mets Caddy/nginx + Let's Encrypt
devant.

### Codespaces

`.devcontainer/devcontainer.json` lance `npm install` puis `npm start`
automatiquement et forwarde le port 3000.

## 4. Architecture

```
server.js                # tout le backend (Express + routes)
data/
  config.json            # config persistée (créé au 1er démarrage)
  videos.json            # index des vidéos enregistrées
uploads/
  mp3/                   # MP3 importés via /justmarried/mp3.html
  videos/                # enregistrements WebM/MP4
  sfx/                   # buzzer.<ext> et victory.<ext> uploadés
public/
  index.html             # KIOSK (SPA single-page : sections cachées)
  css/style.css          # thème principal — palette sauge feutrée
  js/
    kiosk.js             # machine d'états + préchargement + audio mix
    confetti.js          # confettis canvas (maison, ~100 lignes)
  justmarried/           # ADMIN (non protégé)
    index.html           # dashboard
    mp3.html             # gestion MP3 + YouTube + timecode départ
    videos.html          # grille + lightbox
    admin.html           # réglages (délais, SMTP, emails, code, SFX)
    css/admin.css        # thème admin
    js/admin-common.js   # helpers (toast, api, ms<->sec)
```

### Modèle de config (`data/config.json`)

Voir `DEFAULT_CONFIG` dans `server.js`. Toutes les **durées sont en
millisecondes** côté serveur, mais affichées en **secondes (1
décimale)** côté admin via les helpers `msToSec` / `secToMs` /
`fmtSec` de `admin-common.js`.

```js
{
  timings: {
    phase1DurationMs: 10000,   // danse initiale avant buzzer
    buzzerDurationMs: 2500,    // durée du son buzzer
    warningModalMs:   8000,    // modal "fais mieux" + countdown
    victoryStartMs:   30000,   // t où la victoire démarre
    totalDurationMs:  40000,   // t où l'enregistrement s'arrête
    victoryModalMs:   30000    // durée d'affichage du modal code
  },
  emails: ["…"],               // destinataires
  smtp:   { host, port, secure, user, pass, from },
  secretCode: "MARIES-2026",
  publicBaseUrl: "https://…",  // sert à construire les liens email
  youtube: [{ videoId, title, startSeconds }]
}
```

Les fichiers SFX (buzzer + victory) ne sont **pas** dans `config.json` —
on regarde simplement la présence d'un fichier `buzzer.<ext>` /
`victory.<ext>` dans `uploads/sfx/`. C'est la fonction `sfxUrl()` du
serveur qui les expose dans `/api/session/config.sfx`.

### API

Publique (depuis le kiosk) :

- `GET  /api/session/config` → `{ timings, secretCode, playlist, sfx }`
  où `playlist` est MP3 + YouTube fusionnés (chaque YouTube a son
  `startSeconds`) et `sfx = { buzzerUrl, victoryUrl }` (chacun `null`
  si pas de fichier custom).
- `POST /api/session/upload` (multipart `video`, champs `music`,
  `musicType`) → enregistre, indexe, déclenche l'email.

Admin (sous `/api/admin/*`, non protégé) :

- `GET  /config`  `POST /config` (whitelist d'update — inclut
  `youtube[].startSeconds`)
- `POST /smtp-test`
- `GET  /mp3`  `POST /mp3` (multi-upload)  `DELETE /mp3/:name`
- `GET  /videos`  `DELETE /videos/:id` (supprime aussi le fichier)
- `GET  /sfx/:kind`  `POST /sfx/:kind` (single file)
  `DELETE /sfx/:kind`  où `kind ∈ {buzzer, victory}`.

### Pipeline de préchargement (kiosk.js — critique pour la latence)

Goal : que le clic « Démarrer » → début effectif de la musique +
enregistrement soit < 200 ms. Atteint par trois mécanismes lancés au
**boot** de la page (pas au clic) :

1. **MP3 → `AudioBuffer` cache** : `preloadFromConfig(cfg)` fait
   `fetch + decodeAudioData` pour chaque MP3 + SFX custom au boot.
   `startMusic` joue alors un `AudioBufferSourceNode` (sample-accurate,
   ~0 ms d'attaque). Fallback `<audio>` si le buffer n'est pas prêt.
   Re-fetch toutes les 60 s (sans recréer le YT player) pour suivre les
   changements admin.
2. **YouTube → pre-warmed `YT.Player` muté** : `prepareNextTrack(cfg)`
   tire un track au sort, crée un `YT.Player` invisible avec
   `autoplay=1, mute=1` (autoplay muet est autorisé sans gesture). Le
   player bufferise pendant l'idle. Au clic Start, code chaud :
   `unMute() + seekTo(startSeconds) + playVideo()`. Re-préparé à la fin
   de chaque session.
3. **Caméra/micro warm-up** : `warmupCamera()` n'ouvre `getUserMedia`
   que si `Permissions API` confirme `camera+microphone = granted` (pour
   ne pas allumer la LED sans raison à la 1re visite). Le `MediaStream`
   est gardé entre sessions ; `MediaRecorder` est créé/détruit à chaque
   session, le stream non. Seul `Shift+Échap` détruit le stream.

Contraintes audio importantes (`CAM_CONSTRAINTS`) :
`echoCancellation: false, noiseSuppression: false, autoGainControl: false`
— sinon WebRTC filtre la musique des enceintes (traitée comme « écho »)
et l'enregistrement n'a plus de son ambiant.

Instrumentation `console.time` à laisser : `[warmup camera]`,
`[prep youtube]`, `[click→getUserMedia]`, `[startMusic]`. Ouvrir la
console DevTools pour mesurer les vrais temps en prod.

### Machine d'états du kiosk (`public/js/kiosk.js`)

**Au boot de la page** : `bootstrap()` → fetch config, `preloadFromConfig`
(MP3 + SFX en AudioBuffer), `prepareNextTrack` (track tiré au sort +
`YT.Player` pre-warmed muté si YouTube), `warmupCamera` (stream ouvert
si permissions déjà accordées).

**Au clic « Démarrer »** :

1. `startRecording` — réutilise le `mediaStream` warm si dispo, sinon
   `getUserMedia`. Crée un nouveau `MediaRecorder`.
2. Switch sur l'écran « Dansez ! ». `startDebugChrono()` lance le chrono
   visible bas-droite (0.1 s).
3. `startMusic(preparedTrack)` — réutilise le YT.Player pre-warmed
   (`unMute + seekTo + playVideo`) ou crée un `AudioBufferSourceNode`
   depuis le cache. Cold path si rien n'est prêt.
4. À `phase1DurationMs` : `fadeMusic(0.15)` (Web Audio ramp natif sur
   le `GainNode` pour le path BufferSource, rAF sinon) + `playBuzzer`.
   Le buzzer joue le SFX custom si présent ; sinon synth "WRONG-WRONG"
   (2 hits secs game-show, pas un sweep "wawwwh").
5. Pendant `warningModalMs` : modal `.warn` avec countdown.
6. Continue la danse jusqu'à `victoryStartMs`.
7. `fadeMusic(0.1, 250)` puis `playVictory()` (SFX custom OU arpège
   long 2 octaves + accord tenu + sparkles), puis **`fadeMusic(1.0)`
   1.3 s plus tard** pour que la musique reprenne sous le modal.
   `DanceConfetti.launch()` + modal `.victory` avec `secretCode`.
8. À `totalDurationMs` : `stopRecording()` → upload async. **La musique
   continue à jouer** sous le modal.
9. Au bout de `victoryModalMs` (depuis le début de la victoire) :
   `stopMusic()`, hide modal, retour idle, `resetDebugChrono()`. Puis
   `prepareNextTrack` pour la session suivante (yt-host libéré).

**Sortie d'urgence** : `Shift+Échap` arrête tout, détruit le stream
caméra, réinitialise. Utile pour réautoriser les permissions ou
recharger le code après un déploiement.

## 5. Direction artistique

Thème **Art Nouveau délicat, esthétique mariage** — inspiration Mucha
épurée. Lignes organiques (whiplash curves), motifs floraux, palette
sauge + rose pâle + or. Lettrage **moderne et lisible** (pas de polices
décoratives de l'époque), pour rester immédiatement lisible à 1–2 m
en mode kiosk. À respecter scrupuleusement si tu touches au front.

### Palette (variables CSS dans `style.css` / `admin.css`)

| Var          | Hex      | Usage                                  |
|--------------|----------|----------------------------------------|
| `--sage-400` | `#8DA078`| accent clair, hover bouton             |
| `--sage-500` | `#7B8D69`| sauge « vrai » — boutons, bordures     |
| `--sage-600` | `#5F6F4F`| labels secondaires, tiges arabesques   |
| `--sage-700` | `#475437`| titres, accents marqués                |
| `--sage-800` | `#34402A`| haut-contraste réserve                 |
| `--cream`    | `#FBF8F1`| fond clair                             |
| `--cream-2`  | `#F5EFE3`| fond dégradé                           |
| `--rose`     | `#E6C9C0`| pétales rose pâle, accent doux         |
| `--rose-2`   | `#A86A5C`| terre-cuite, cœur de rose, warning     |
| `--gold`     | `#8A6A1F`| doré encre, accents victoire           |
| `--ink`      | `#3A4730`| texte principal (vert sauge foncé)     |

### Typographie

- **Marcellus** (serif display, all-caps friendly) : titres décoratifs.
  Elégance Art Nouveau, parfaitement lisible, sans la calligraphie
  surchargée des polices d'époque.
- **Cormorant Garamond** (serif) : corps de texte, sous-titres,
  helpers. Conservé pour sa lisibilité à distance.
- **Inter** (sans) : UI admin, boutons utilitaires, badges.

Toutes via Google Fonts. **Pas d'Italianno** (script trop rustique,
incompatible avec la direction art nouveau moderne).

### Ornements SVG

Deux ressources réutilisables dans `public/img/` :

- `ornament-corner.svg` : whiplash curve sauge + rose pâle stylisée.
  Vocation **angles de page** (kiosk : 4 coins via rotation CSS).
  Couleurs codées en dur (compatible `background-image: url()`).
- `ornament-divider.svg` : séparateur horizontal sinueux avec rose
  centrale et bourgeons aux extrémités. Pour cloisonner des sections
  d'admin sans rompre la verticalité.

Pour ajouter d'autres motifs : garder la même charte (whiplash curves,
opacités < .75, palette identique), au format SVG monochrome ou
multi-couleurs codées en dur. Pas de PNG raster.

### Esthétique

- Fonds : crème uni + halos radiaux sauge/rose très subtils
  (`radial-gradient` flouté dans `body`).
- Cartes : `border-radius: 18–28px`, `box-shadow` doux, bordure
  `rgba(95,111,79,.22)`. Possibilité d'ajouter un `ornament-corner.svg`
  en `background-image` ancré dans un coin.
- Boutons « start » : pilule, gradient sauge, micro-ornement floral
  (`✿` ou SVG inline).
- Texte : `text-shadow` léger style « papier mat ».
- Animations : `pulse` (anneaux), `shimmy` (danseuse), `fade` (modaux).
  Confettis = canvas maison, palette sage/gold/rose, `z-index: 150`
  pour passer **par-dessus** la modale et son overlay.

## 6. Conventions

- **Pas de framework front.** Pas de build. Ne pas ajouter Webpack /
  Vite / React.
- **Pas de DB.** Reste en JSON plat. Si besoin d'index plus rapide,
  reste en mémoire au boot.
- **Durées** : stockées en **ms**, affichées en **secondes** (helpers
  `msToSec` / `secToMs` / `fmtSec`).
- **Sécurité** : on whitelist les champs en POST config (voir
  `server.js`), on valide les noms de fichiers avec `safeNameRe`. Ne
  pas accepter de chemins arbitraires.
- **Emails** : asynchrones après upload, échec n'invalide pas la
  session (on log mais on ne renvoie pas d'erreur au client).
- **Erreurs front** : afficher un `toast` plutôt qu'une alerte
  bloquante — l'expérience doit rester fluide.

## 7. Tests rapides

Pas de suite de tests. Smoke test serveur :

```bash
PORT=3033 node server.js &
curl -s http://localhost:3033/api/admin/config | jq
curl -s -X POST http://localhost:3033/api/admin/config \
  -H 'Content-Type: application/json' \
  -d '{"secretCode":"TEST"}' | jq
```

Pour tester la séquence sans attendre 40 s, baisse les délais dans
`/justmarried/admin.html`.

### Vulnérabilités npm

`npm audit` remonte 1 vuln **high** sur `nodemailer` (4 CVE confondues :
DoS `addressparser`, SMTP command injection via `envelope.size` / `name`
EHLO, interpretation conflict sur destinataires). **Décision** : on
**reste** sur `nodemailer@^6.9.13`. Tous les vecteurs nécessitent une
entrée non-fiable passée à nodemailer ; dans Dance Escape la config
SMTP, la liste d'emails et le `from` viennent **uniquement** de l'admin
(personne de confiance), et le corps des emails est généré côté
serveur. Le fix `nodemailer@8.x` est un saut **major** et l'app est
**one-shot** — pas la peine de risquer une régression la veille du
mariage. Ne pas faire `npm audit fix --force`.

## 8. Déploiement VPS

### Ce qui est dans git

- Tout le code (`server.js`, `public/`, `package*.json`)
- **La config admin** (`data/config.json`, `data/videos.json`) — donc
  le clone reprend la playlist YouTube + délais + SMTP du dev box.
- **Les sons custom** (`uploads/sfx/buzzer.wav`, `victory.wav`) — pour
  démarrer le VPS avec les bons SFX sans avoir à les re-uploader.
- **Les MP3** (`uploads/mp3/*.mp3`) versionnés s'il y en a — partie de
  la playlist.

### Ce qui n'est PAS dans git

- `node_modules/` — recréé par `npm install`.
- `.env`, `*.log`, `.DS_Store`.

Note RGPD : les vidéos invités (`uploads/videos/*`) **sont versionnées
pour l'instant** (volonté du dev box pour clone-and-go). Si ça devient
un souci de poids ou de privacy, sortir l'historique avec
`git-filter-repo` / Git LFS — un simple `.gitignore` ne purgerait pas
ce qui est déjà commit.

### Méthode recommandée : `git clone` direct sur le VPS

```bash
# Sur le VPS :
git clone https://github.com/remmmi/dance-escape.git /srv/dance-escape
cd /srv/dance-escape
npm install --omit=dev
pm2 start server.js --name dance-escape   # ou systemd, voir ci-dessous
pm2 save && pm2 startup                    # persistance après reboot
```

Mises à jour ensuite : `cd /srv/dance-escape && git pull && pm2 restart dance-escape`.

### Reverse-proxy HTTPS (obligatoire pour la webcam hors localhost)

Caddyfile une ligne :

```
dance.notre-mariage.fr {
  reverse_proxy localhost:3000
}
```

Caddy gère le cert Let's Encrypt automatiquement. Alternative : nginx +
certbot.

### Après le déploiement, à faire dans l'admin

1. `publicBaseUrl` → l'URL HTTPS publique du VPS (pour les liens
   email).
2. Configurer le SMTP (host, user, pass) + tester avec « Envoyer un
   email de test ».
3. Ajouter / ajuster les destinataires email.
4. Vérifier les délais (par défaut 10 / 2.5 / 8 / 30 / 40 / 30 s).
5. Tester un parcours complet et regarder la console DevTools (F12)
   pour les timings `[warmup camera]`, `[prep youtube]`,
   `[click→getUserMedia]`, `[startMusic]`. Si `[startMusic]` est
   supérieur à 200 ms après le 1er clic, vérifier que la playlist
   contient bien des tracks pré-buffer-isables (les YT sont préparés
   au boot et après chaque session).

### Vérifications côté Claude sur le VPS

Si tu es Claude Code et qu'on te demande de redémarrer / vérifier :

```bash
# Process up
pm2 status dance-escape
# Logs
pm2 logs dance-escape --lines 50
# Health
curl -s http://localhost:3000/api/session/config | jq .
# Reverse-proxy
curl -sI https://dance.notre-mariage.fr/
```

Le SFX peut être uploadé/remplacé sans redémarrer (le serveur lit le
dossier `uploads/sfx/` à chaque requête `/api/session/config`). La
config (timings, code, SMTP, YouTube) est modifiable à chaud via
l'admin — pas besoin de toucher `data/config.json` à la main.

### Sortie kiosk (sur l'écran d'expo)

```bash
chromium --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  https://dance.notre-mariage.fr/
```

À la 1re ouverture, autoriser caméra + micro dans l'invite Chrome.
Les sessions suivantes auront tout le pipeline de pre-warming actif
(LED caméra allumée pendant l'idle = c'est volontaire).

## 9. Modifications fréquentes (ce qu'on te demandera sans doute)

- **Changer les délais par défaut** → `DEFAULT_CONFIG.timings` dans
  `server.js` (penser que les configs existantes les écrasent : un
  `rm data/config.json` peut être nécessaire).
- **Ajouter une étape dans le parcours** → modifier la séquence dans
  `runSession()` de `kiosk.js`. Garder l'invariant : `victoryStartMs <=
  totalDurationMs`.
- **Changer la palette / typo** → variables CSS en haut de
  `public/css/style.css` et `public/justmarried/css/admin.css`.
- **Ajouter une option d'admin** → 3 endroits : `DEFAULT_CONFIG` dans
  `server.js`, whitelist dans `POST /api/admin/config`, champ dans
  `admin.html` (`load()` + payload du `save`).

## 10. Ce qu'il ne faut PAS faire

- Ajouter une DB / un ORM.
- Introduire un framework front (React, Vue, Svelte…).
- Ajouter un Dockerfile / docker-compose (sauf demande explicite).
- Ajouter de nouveaux emojis ou caractères Unicode décoratifs. Seuls
  les pictos UI déjà présents (`💃 ▶ ♪ ✿`) sont autorisés — ils font
  partie du design, ne pas les retirer mais ne pas en ajouter d'autres.
- Casser la portabilité : tout doit marcher en `npm install && npm
  start`.
