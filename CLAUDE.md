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
- `multer` (v2) — uploads multipart (MP3, vidéos)
- `nodemailer` — envoi email SMTP configuré par l'admin
- Front : **vanilla JS / HTML / CSS** (zéro build, zéro framework). Web
  Audio API pour buzzer & victoire, canvas pour confettis, YouTube
  iframe API pour audio YouTube.

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
public/
  index.html             # KIOSK
  css/style.css          # thème principal
  js/
    kiosk.js             # machine d'états du parcours
    confetti.js          # confettis canvas (maison, ~100 lignes)
  justmarried/           # ADMIN (non protégé)
    index.html           # dashboard
    mp3.html             # gestion MP3 + YouTube
    videos.html          # grille + lightbox
    admin.html           # réglages (délais, SMTP, emails, code)
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
  youtube: [{ videoId, title }]
}
```

### API

Publique (depuis le kiosk) :

- `GET  /api/session/config` → timings + playlist (MP3 + YouTube
  fusionnés) + code
- `POST /api/session/upload` (multipart `video`, champs `music`,
  `musicType`) → enregistre, indexe, déclenche l'email

Admin (sous `/api/admin/*`, non protégé) :

- `GET  /config`  `POST /config` (whitelist d'update)
- `POST /smtp-test`
- `GET  /mp3`  `POST /mp3` (multi-upload)  `DELETE /mp3/:name`
- `GET  /videos`  `DELETE /videos/:id` (supprime aussi le fichier)

### Machine d'états du kiosk (`public/js/kiosk.js`)

Quand le bouton est cliqué :

1. Demande caméra/micro (`getUserMedia`), démarre `MediaRecorder`.
2. Charge config + playlist, tire un titre au sort
   (`pickTrack` — MP3 audio element OU `YT.Player` masqué).
3. Affiche l'écran « Dansez ! » (anneaux pulsés + danseuse animée).
4. À `phase1DurationMs` : `fadeMusic(0.15)` + `playBuzzer()`
   (oscillateurs Web Audio).
5. Pendant `warningModalMs` : modal `.warn` avec countdown.
6. Continue la danse jusqu'à `victoryStartMs`.
7. `playVictory()` (arpège C-E-G-C + sparkle) + `DanceConfetti.launch()`
   + modal `.victory` avec `secretCode`.
8. À `totalDurationMs` : `stopRecording()` → upload async.
9. Modal reste affiché jusqu'à `victoryModalMs` écoulées depuis le
   début de la victoire, puis retour à l'écran d'accueil.

**Sortie d'urgence** : `Shift+Échap` réinitialise tout.

## 5. Direction artistique

Thème **shabby chic vert sauge printanier**, esthétique mariage. À
respecter scrupuleusement si tu touches au front.

### Palette (variables CSS dans `style.css` / `admin.css`)

| Var          | Hex      | Usage                          |
|--------------|----------|--------------------------------|
| `--sage-400` | `#9CAF88`| accent principal, boutons      |
| `--sage-500` | `#7E926A`| boutons hover, sage profond    |
| `--sage-700` | `#4B5A40`| texte sage foncé, titres       |
| `--cream`    | `#FBF8F1`| fond clair, texte sur sage     |
| `--cream-2`  | `#F5EFE3`| fond dégradé                   |
| `--rose`     | `#E6C9C0`| accent doux                    |
| `--rose-2`   | `#D9A89C`| accent buzzer/warning          |
| `--gold`     | `#C9A961`| accent victoire, dorure        |
| `--ink`      | `#3A4030`| texte principal                |

### Typographie

- **Cormorant Garamond** (serif) : titres et corps.
- **Italianno** (script) : grands titres décoratifs (« Dance Escape »,
  « Dansez ! », countdown).
- **Inter** (sans) : UI admin, badges, helpers.

Toutes chargées via Google Fonts. Ne pas remplacer sans raison.

### Esthétique

- Fonds : dégradés crème + halos radiaux sauge/rose floutés
  (`radial-gradient` dans `body`).
- Cartes : `border-radius: 18–28px`, `box-shadow` doux, bordure
  `rgba(156,175,136,.35)`.
- Boutons « start » : pilule, gradient sauge, ornement `✿`.
- Texte : `text-shadow` léger style « gravé sur papier mat ».
- Animations : `pulse` (anneaux), `shimmy` (danseuse), `fade`
  (modaux). Confettis = canvas maison avec palette ci-dessus.

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

Voir `README.md`. En résumé :

```bash
rsync -av --exclude node_modules ./ user@vps:/srv/dance-escape/
ssh user@vps "cd /srv/dance-escape && npm install --omit=dev \
  && pm2 start server.js --name dance-escape"
```

Puis reverse-proxy HTTPS (Caddy une ligne, ou nginx + certbot).
Renseigner `publicBaseUrl` dans l'admin pour que les liens email
pointent vers la bonne URL.

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
