window.Admin = (() => {
  function toast(msg, danger = false, ms = 3500) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.className = 'toast' + (danger ? ' danger' : '');
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), ms);
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const u = ['o', 'Ko', 'Mo', 'Go'];
    let n = bytes; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  }
  async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!r.ok) {
      let msg = 'Erreur ' + r.status;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    if (r.status === 204) return null;
    return r.json();
  }
  function confirmDelete(msg = 'Confirmer la suppression ?') { return window.confirm(msg); }
  // Durations: stored in ms, displayed in seconds with 1 decimal
  function msToSec(ms) {
    const n = Number(ms) || 0;
    return Math.round(n / 100) / 10;
  }
  function secToMs(sec) {
    const n = Number(sec) || 0;
    return Math.round(n * 1000);
  }
  function fmtSec(ms) {
    return msToSec(ms).toFixed(1) + ' s';
  }
  // MediaRecorder WebM duration fix : les fichiers .webm enregistres par
  // MediaRecorder ont une duree "Infinity" dans le header car le format
  // permet un stream non finalise. Pour debloquer la progress bar du
  // player, on seek tout au bout du fichier, ce qui force le navigateur
  // a lire le timestamp du dernier frame et corriger video.duration.
  // Ensuite on revient a 0.
  function fixVideoDuration(videoEl) {
    if (!videoEl) return;
    const ready = () => {
      if (!isFinite(videoEl.duration) || isNaN(videoEl.duration)) {
        const onTime = () => {
          videoEl.removeEventListener('timeupdate', onTime);
          try { videoEl.currentTime = 0; } catch {}
        };
        videoEl.addEventListener('timeupdate', onTime);
        try { videoEl.currentTime = 1e10; } catch {}
      }
    };
    if (videoEl.readyState >= 1) ready();
    else videoEl.addEventListener('loadedmetadata', ready, { once: true });
  }
  return { toast, fmtDate, fmtSize, api, confirmDelete, msToSec, secToMs, fmtSec, fixVideoDuration };
})();
