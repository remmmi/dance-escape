# Dance Escape

> Une épreuve de danse en kiosk plein-écran pour animer un mariage.
> L'invité clique, danse, panique sur un faux échec, savoure une victoire à
> confettis et reçoit un code secret. La vidéo de son passage atterrit dans la
> boîte mail des mariés.

---

## L'idée

Un écran posé sur un coin de la salle. Un gros bouton « Démarrer la danse ».
Quelqu'un appuie. La musique part, la caméra tourne, l'invité se lance. À
mi-parcours un buzzer sonne et un « Pas encore ça ! » apparaît : faux échec,
juste pour rire. La danse reprend. Vers la fin, confettis, sonnerie de victoire,
et le **code secret** s'affiche en grand. L'invité le note, passe à l'épreuve
suivante. Sa danse est envoyée par email à une liste de destinataires que vous
choisissez.

Pas de compte, pas d'app à installer. Juste un PC, un écran, une webcam, des
enceintes.

---

## Ce que vit l'invité

```
   T0 ──── T1 ──── T2 ──── T3 ──── T4 ──── T5 ────→ reset
   │       │       │       │       │       │
   │       │       │       │       │       └── fondu musique 10 s, retour à l'idle
   │       │       │       │       └── le modal du code se ferme
   │       │       │       └── fin de l'enregistrement vidéo
   │       │       └── confettis + son de victoire + code secret affiché
   │       └── buzzer 1.5 s + modal « Faites mieux ! » (musique duck/un-duck)
   └── click sur le bouton (ou touche Entrée) → musique 100 % + caméra ON
```

Tous les T1–T5 sont **réglables à la seconde près** depuis l'admin, valeurs
par défaut 10 s / 40 s / 60 s / 90 s / auto (auto = fondu calé pour finir
pile à la fin du morceau).

Bonus : **modales annexes M-1..M-n**. Vous pouvez glisser un message
supplémentaire à n'importe quel moment de la session (par exemple
« Plus fort ! » à T=30 s) sans toucher au son ni à la timeline.

---

## Côté admin

Une seule page `/justmarried/admin.html` regroupe tous les réglages :

- **Code secret** affiché à la fin
- **Textes du front** — chaque ligne du kiosk (overline, titre, sous-titre,
  appels à danser, modal warning, modal victoire) est éditable au texte près
  pour personnaliser au nom du couple
- **Sons personnalisés** — buzzer et son de victoire au choix par upload
  (sinon des versions synthétisées en Web Audio sont jouées par défaut)
- **Délais** — la timeline T1 à T5 + durée du compte à rebours du modal
- **Modales annexes** — ajouter autant de messages que voulu avec leur
  timestamp et durée
- **URL publique** — utilisée dans le lien d'email
- **Destinataires email** — la liste qui reçoit chaque vidéo
- **SMTP** — host, port, user, pass, expéditeur, avec un bouton de test
  d'envoi

Pages séparées dans la même section admin :

- **Musiques** (`/justmarried/mp3.html`) — upload de MP3 et liens YouTube
  avec timecode de départ. La playlist est tirée au sort à chaque session.
- **Vidéos** (`/justmarried/videos.html`) — toutes les danses enregistrées
  avec miniature, date, musique jouée, bouton télécharger, bouton supprimer

Une **corbeille** vit à `/justmarried/videoscontrol.html` (hors menu) :
restaurer ou purger définitivement les vidéos supprimées.

---

## Démarrage rapide

```bash
npm install
npm start
# → kiosk : http://localhost:3000/
# → admin : http://localhost:3000/justmarried/
```

Variables d'environnement :

- `PORT` (défaut `3000`)
- `HOST` (défaut `0.0.0.0`)

Pré-requis : **Node ≥ 18**. Dépendances minimales : `express`, `multer`,
`nodemailer`. Pas de base de données — toute la config et les métadonnées
vivent en JSON plat dans `data/`.

---

## Mode kiosk Chromium

Sur le PC qui sert d'écran :

```bash
chromium --kiosk --incognito --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream \
  --disk-cache-size=1 --media-cache-size=1 \
  https://votre-domaine.example/
```

- `--use-fake-ui-for-media-stream` : Chromium accepte automatiquement
  webcam et micro sans pop-up de permission
- `--incognito` : profil neuf à chaque lancement, aucune trace résiduelle
- `--autoplay-policy=no-user-gesture-required` : permet à la musique de
  démarrer dès le clic

La commande exacte calée sur votre URL publique est affichée sur la page
d'accueil admin avec un bouton « Copier ».

Sur place, une session peut aussi être déclenchée par la **touche Entrée**
(clavier sans-fil, pointeur de présentation, etc.).

---

## Déploiement VPS (HTTPS obligatoire)

La webcam et le micro nécessitent **HTTPS** dès qu'on n'est plus sur
`localhost` (limitation navigateur). Mettre Apache, Nginx ou Caddy
devant en reverse-proxy avec Let's Encrypt.

Exemple minimal Caddyfile :

```caddy
dance.notre-mariage.fr {
  reverse_proxy localhost:3000
}
```

Une fois en HTTPS public, mettre `publicBaseUrl` dans l'admin à
`https://dance.notre-mariage.fr` pour que les liens email pointent vers la
bonne URL.

Pour empêcher l'indexation par les moteurs sur tout le sous-domaine,
ajouter au vhost :

```apache
Header always set X-Robots-Tag "noindex, nofollow, noarchive, nosnippet"
```

---

## Email envoyé aux mariés

Chaque fin de session déclenche un envoi nodemailer **asynchrone** à la
liste de destinataires de l'admin. En cas d'échec : log côté serveur,
pas d'erreur remontée au kiosk — la session reste fluide.

Le lien dans l'email pointe vers une **page de visionnage publique**
(`/v.html?id=...`) au design assorti, avec un player vidéo, les
métadonnées (date, musique, poids), et un bouton « Télécharger » qui
déclenche un vrai download (pas une ouverture d'onglet).

Cette page applique automatiquement un correctif de durée pour les
vidéos WebM enregistrées par MediaRecorder, dont l'en-tête de fichier
ne contient pas la durée totale (résultat : progress bar fonctionnelle
au lieu d'un `Infinity:NaN`).

---

## Charte visuelle

Direction artistique **Art Nouveau délicat** type pivoine vintage :

- Palette sauge + rose pâle + or, fond crème dégradé
- Lettrage **Marcellus** (serif art nouveau, moderne et lisible à 2 m)
  pour les titres décoratifs, **Cormorant Garamond** pour le corps,
  **Inter** pour l'UI admin
- Ornements floraux SVG outlinés dans les quatre coins + paires miroir
  en bord haut/bas (mêmes couleurs que la palette)
- Anneaux concentriques sauge / rose alternés autour de la danseuse
  pendant la phase dance
- Confettis canvas multi-salves avec palette pastel + accents saturés
  pour rester visibles sur fond crème, affichés **par-dessus** le modal
  victoire

L'ensemble est entièrement statique côté front : pas de framework, pas
de build, pas de bundler.

---

## Stockage

Tout est sur disque, pas de base de données :

```
data/
  config.json          ← réglages admin
  videos.json          ← index des vidéos actives
  videos-deleted.json  ← index de la corbeille
uploads/
  mp3/                 ← MP3 uploadés
  videos/              ← vidéos enregistrées
  videos/deleted/      ← vidéos soft-supprimées
  sfx/                 ← buzzer/victoire personnalisés
```

Pour sauvegarder : copier `data/` et `uploads/`.

---

## Limites assumées

- **Application one-shot** — pensée pour un mariage, pas pour un usage
  permanent multi-événements. Pas de multi-tenant, pas de migrations
  DB, pas de tests automatisés.
- **Pas de protection forte sur les liens email** — l'ID vidéo est un
  random `crypto.randomBytes(6)` (48 bits), non-guessable mais
  quiconque l'a peut voir la vidéo. Modèle "secret link" suffisant pour
  un usage privé entre invités.
- **Admin sans login applicatif** — la protection vient du chemin
  obscur `/justmarried/` + Basic Auth recommandée au niveau du
  reverse-proxy.
- **Capture vidéo dépendante du navigateur** — MediaRecorder choisit le
  premier format supporté parmi `video/webm` (VP9, VP8, générique) puis
  `video/mp4` en dernier recours. La page de visionnage applique un fix
  de durée spécifique au WebM (sans effet sur le MP4).

---

## Réutilisation

Code privé fait pour un mariage en particulier. Réutilisable librement
pour un autre événement — recopier le dossier, changer `publicBaseUrl`,
les textes (dans l'admin), la playlist, le code secret, c'est prêt.
