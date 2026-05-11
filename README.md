# Dance Escape — Épreuve de danse pour mariage

Mini-application web one-shot : un kiosk avec un bouton « Démarrer la danse »
qui enregistre les invités (webcam + micro), joue une musique en shuffle (MP3
ou YouTube), déclenche un buzzer, une fausse alerte, puis un code secret avec
confettis. La vidéo est envoyée par email à une courte liste de destinataires.

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

Toute la configuration (délais, code, SMTP, emails, YouTube) se fait dans
l'interface `/justmarried/admin.html` et est stockée dans `data/config.json`.

## Mode kiosk

Sur la machine qui sert d'écran :

```bash
chromium --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  http://localhost:3000/
```

Sur macOS :

```bash
open -na "Google Chrome" --args --kiosk http://localhost:3000/
```

**Important** : pour que la webcam et le micro fonctionnent en dehors de
`localhost`, le site doit être servi en **HTTPS** (limitation navigateur).
Pour un VPS, utilisez un reverse-proxy (Caddy, nginx) avec Let's Encrypt.

## Déploiement VPS

Copier le dossier, installer, lancer avec un superviseur :

```bash
rsync -av --exclude node_modules ./ user@vps:/srv/dance-escape/
ssh user@vps "cd /srv/dance-escape && npm install --omit=dev && pm2 start server.js --name dance-escape"
```

Reverse-proxy minimal (Caddyfile) :

```
dance.notre-mariage.fr {
  reverse_proxy localhost:3000
}
```

Pensez à renseigner `publicBaseUrl` dans l'admin pour que les liens email
soient corrects.

## Structure

```
data/            # config.json + videos.json (fichiers plats)
uploads/mp3/     # MP3 importés
uploads/videos/  # enregistrements webcam
public/          # kiosk + /justmarried/ (admin non protégé)
server.js        # Express + multer + nodemailer
```

## Sauvegardes

Tout l'état est dans `data/` + `uploads/`. Une simple copie suffit.
