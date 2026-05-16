#!/usr/bin/env bash
# Restart Dance Escape server.
#
# Le serveur a été démarré comme orphelin détaché (reparenté à systemd PID 1)
# en tant qu'utilisateur `sauge`. Pas de PM2, pas d'unit systemd. On le tue
# proprement puis on le relance avec les mêmes paramètres (user sauge,
# PORT=3033 par défaut). À lancer en sudo (kilorem a NOPASSWD sur ce VPS).
#
#   sudo /opt/sauge/restart.sh
#
set -euo pipefail

PORT="${PORT:-3033}"
LOG=/tmp/dance-escape.log
PIDFILE=/tmp/dance-escape.pid
APP_DIR=/opt/sauge

# 1. Tuer toute instance existante owned par sauge
PIDS=$(pgrep -u sauge -f "node server.js" || true)
if [ -n "$PIDS" ]; then
  echo "→ Kill anciennes instances: $PIDS"
  kill $PIDS || true
  sleep 0.5
  REMAIN=$(pgrep -u sauge -f "node server.js" || true)
  if [ -n "$REMAIN" ]; then
    echo "→ Force-kill survivants: $REMAIN"
    kill -9 $REMAIN || true
  fi
else
  echo "→ Aucune instance précédente."
fi

# 2. Relancer comme `sauge` en arrière-plan, détaché du terminal courant.
#    Le `setsid` détache la session pour qu'un Ctrl+C du shell appelant
#    ne tombe pas sur le serveur (et qu'un close terminal le garde vivant).
sudo -u sauge bash -c "
  cd $APP_DIR
  setsid env PORT=$PORT nohup node server.js > $LOG 2>&1 < /dev/null &
  echo \$! > $PIDFILE
"

sleep 1
NEW_PID=$(cat "$PIDFILE" 2>/dev/null || echo '?')
echo "→ Nouveau PID: $NEW_PID  port=$PORT  log=$LOG"

# 3. Healthcheck
for i in 1 2 3 4 5; do
  if curl -sf "http://localhost:$PORT/api/session/config" > /dev/null; then
    echo "✓ Serveur répond sur http://localhost:$PORT"
    exit 0
  fi
  sleep 0.4
done

echo "✗ Serveur ne répond pas après 3s. Dernières lignes du log :"
tail -20 "$LOG" 2>/dev/null || true
exit 1
