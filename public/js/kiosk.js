/* Dance Escape — kiosk state machine */
(function () {
  const $ = (id) => document.getElementById(id);
  const screenIdle = $('screen-idle');
  const screenDance = $('screen-dance');
  const btnStart = $('btn-start');
  const modalWarn = $('modal-warning');
  const modalVictory = $('modal-victory');
  const warnCount = $('warn-count');
  const secretCodeEl = $('secret-code');
  const trackTag = $('track-tag');
  const timerFill = $('timer-fill');
  const ytHost = $('yt-host');
  const camEl = $('cam');

  let cfg = null;
  let busy = false;

  // ---- audio helpers (Web Audio API) ----
  let audioCtx = null;
  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function playBuzzer(durationMs) {
    const ctx = ac();
    const dur = durationMs / 1000;
    const t0 = ctx.currentTime;
    // Square wave going down — classic "wrong!" buzzer
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.linearRampToValueAtTime(90, t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.05);
    gain.gain.setValueAtTime(0.35, t0 + dur - 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    // Add a harsh sub
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(85, t0);
    osc2.frequency.linearRampToValueAtTime(60, t0 + dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    osc.connect(gain).connect(ctx.destination);
    osc2.connect(g2).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur);
    osc2.start(t0); osc2.stop(t0 + dur);
  }

  function playVictory() {
    const ctx = ac();
    const now = ctx.currentTime;
    const notes = [
      [523.25, 0.00, 0.18], // C5
      [659.25, 0.15, 0.18], // E5
      [783.99, 0.30, 0.22], // G5
      [1046.5, 0.50, 0.55]  // C6
    ];
    for (const [f, t, d] of notes) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.3, now + t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + d);
      o.connect(g).connect(ctx.destination);
      o.start(now + t);
      o.stop(now + t + d + 0.05);
    }
    // sparkle
    for (let i = 0; i < 6; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 1500 + Math.random() * 2000;
      const g = ctx.createGain();
      const t = now + 0.6 + i * 0.08;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.3);
    }
  }

  // ---- music player (MP3 audio element OR YouTube iframe API) ----
  let musicEl = null; // HTMLAudioElement
  let ytPlayer = null;
  let ytReady = null;
  let currentTrack = null;
  let musicTargetVolume = 1.0;

  function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('YouTube API timeout')), 8000);
      window.onYouTubeIframeAPIReady = () => { clearTimeout(t); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { clearTimeout(t); reject(new Error('YouTube API failed to load')); };
      document.head.appendChild(s);
    });
    return ytReady;
  }

  function pickTrack(playlist) {
    if (!playlist || playlist.length === 0) return null;
    return playlist[Math.floor(Math.random() * playlist.length)];
  }

  async function startMusic(track) {
    currentTrack = track;
    if (!track) return;
    trackTag.textContent = '♪ ' + (track.title || '');
    if (track.type === 'mp3') {
      musicEl = new Audio(track.url);
      musicEl.preload = 'auto';
      musicEl.loop = true;
      musicEl.volume = musicTargetVolume;
      try { await musicEl.play(); } catch (e) { console.warn('mp3 play failed', e); }
    } else if (track.type === 'youtube') {
      try {
        await loadYouTubeAPI();
        await new Promise((resolve) => {
          ytPlayer = new YT.Player('yt-host', {
            videoId: track.videoId,
            width: 1, height: 1,
            playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, playsinline: 1, fs: 0, iv_load_policy: 3 },
            events: {
              onReady: (ev) => {
                ev.target.setVolume(Math.round(musicTargetVolume * 100));
                ev.target.playVideo();
                resolve();
              }
            }
          });
        });
      } catch (e) {
        console.warn('YouTube failed', e);
        showToast("YouTube indisponible — vérifiez la connexion");
      }
    }
  }

  function setMusicVolume(v) {
    musicTargetVolume = Math.max(0, Math.min(1, v));
    if (musicEl) musicEl.volume = musicTargetVolume;
    if (ytPlayer && ytPlayer.setVolume) {
      try { ytPlayer.setVolume(Math.round(musicTargetVolume * 100)); } catch {}
    }
  }

  function fadeMusic(targetV, durationMs) {
    const startV = musicEl ? musicEl.volume : (ytPlayer && ytPlayer.getVolume ? (ytPlayer.getVolume() / 100) : musicTargetVolume);
    const t0 = performance.now();
    function step(now) {
      const p = Math.min(1, (now - t0) / durationMs);
      const v = startV + (targetV - startV) * p;
      setMusicVolume(v);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function stopMusic() {
    try { if (musicEl) { musicEl.pause(); musicEl.src = ''; musicEl = null; } } catch {}
    try { if (ytPlayer && ytPlayer.destroy) { ytPlayer.destroy(); ytPlayer = null; } } catch {}
    // Re-create yt-host since destroy replaces it
    if (!document.getElementById('yt-host')) {
      const d = document.createElement('div');
      d.id = 'yt-host'; d.className = 'yt-host'; d.setAttribute('aria-hidden', 'true');
      document.body.appendChild(d);
    }
  }

  // ---- recording ----
  let mediaStream = null;
  let recorder = null;
  let chunks = [];

  async function startRecording() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true
    });
    camEl.srcObject = mediaStream;
    chunks = [];
    const mime = pickSupportedMime();
    recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(1000);
  }

  function pickSupportedMime() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4'
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function stopRecording() {
    return new Promise((resolve) => {
      if (!recorder) return resolve(null);
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
        try { mediaStream.getTracks().forEach(t => t.stop()); } catch {}
        mediaStream = null;
        resolve(blob);
      };
      try { recorder.stop(); } catch { resolve(null); }
    });
  }

  async function uploadVideo(blob) {
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const fd = new FormData();
    fd.append('video', blob, `dance-${Date.now()}.${ext}`);
    fd.append('music', (currentTrack && currentTrack.title) || '');
    fd.append('musicType', (currentTrack && currentTrack.type) || '');
    try {
      const r = await fetch('/api/session/upload', { method: 'POST', body: fd });
      if (!r.ok) throw new Error('upload http ' + r.status);
    } catch (e) {
      console.warn('upload failed', e);
      showToast("Envoi vidéo échoué (réessayez ?)");
    }
  }

  // ---- screen helpers ----
  function showScreen(name) {
    for (const el of document.querySelectorAll('.screen')) el.classList.remove('visible');
    if (name === 'idle') screenIdle.classList.add('visible');
    if (name === 'dance') screenDance.classList.add('visible');
  }

  function showModal(modal) { modal.classList.add('visible'); modal.setAttribute('aria-hidden', 'false'); }
  function hideModal(modal) { modal.classList.remove('visible'); modal.setAttribute('aria-hidden', 'true'); }

  function showToast(msg, ms = 4200) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.remove(), ms);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function startTimer(total) {
    const t0 = performance.now();
    let raf;
    function step(now) {
      const p = Math.min(1, (now - t0) / total);
      timerFill.style.width = (p * 100) + '%';
      if (p < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }

  async function fetchConfig() {
    const r = await fetch('/api/session/config');
    if (!r.ok) throw new Error('config http ' + r.status);
    return r.json();
  }

  // ---- main flow ----
  async function runSession() {
    if (busy) return;
    busy = true;
    try {
      cfg = await fetchConfig();
    } catch (e) {
      showToast("Configuration introuvable");
      busy = false; return;
    }

    const { phase1DurationMs, buzzerDurationMs, warningModalMs, victoryStartMs, totalDurationMs } = cfg.timings;
    secretCodeEl.textContent = cfg.secretCode || '—';

    // 1) Mic/Cam permission
    try {
      await startRecording();
    } catch (e) {
      console.error('cam/mic error', e);
      showToast("Caméra/micro refusés. Activez-les pour continuer.");
      busy = false; return;
    }

    // 2) Switch screens, pick track, play music
    showScreen('dance');
    const track = pickTrack(cfg.playlist);
    if (!track) {
      trackTag.textContent = "Aucune musique configurée";
    }
    setMusicVolume(1.0);
    if (track) startMusic(track).catch(() => {});

    const stopBar = startTimer(totalDurationMs);

    // Phase 1: dance
    await sleep(phase1DurationMs);

    // Phase 2: lower music, buzzer
    fadeMusic(0.15, 300);
    playBuzzer(buzzerDurationMs);
    await sleep(buzzerDurationMs);

    // Phase 3: warning modal countdown
    showModal(modalWarn);
    fadeMusic(0.85, 600);
    const warnStart = performance.now();
    const initial = Math.ceil(warningModalMs / 1000);
    warnCount.textContent = initial;
    const warnInterval = setInterval(() => {
      const remain = Math.max(0, Math.ceil((warningModalMs - (performance.now() - warnStart)) / 1000));
      warnCount.textContent = remain;
    }, 200);
    await sleep(warningModalMs);
    clearInterval(warnInterval);
    hideModal(modalWarn);
    fadeMusic(1.0, 400);

    // Phase 4: dance again until victoryStartMs
    const elapsed = phase1DurationMs + buzzerDurationMs + warningModalMs;
    const waitToVictory = Math.max(0, victoryStartMs - elapsed);
    await sleep(waitToVictory);

    // Phase 5: victory
    fadeMusic(0.1, 400);
    playVictory();
    if (window.DanceConfetti) DanceConfetti.launch({ duration: Math.min(8000, totalDurationMs - victoryStartMs + 2000) });
    showModal(modalVictory);

    // Phase 6: continue recording until total
    const remainAfterVictory = Math.max(0, totalDurationMs - victoryStartMs);
    await sleep(remainAfterVictory);

    stopBar();
    // Stop recording + music
    const blob = await stopRecording();
    stopMusic();
    if (blob) uploadVideo(blob).catch(() => {});

    // Keep victory modal a few seconds, then return to idle
    await sleep(4500);
    hideModal(modalVictory);
    timerFill.style.width = '0%';
    showScreen('idle');
    busy = false;
  }

  btnStart.addEventListener('click', () => {
    // Unlock audio context on user gesture
    try { ac().resume(); } catch {}
    runSession();
  });

  // Keyboard "Escape" to bail out (admin convenience)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.shiftKey) {
      stopMusic();
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
      try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
      hideModal(modalWarn); hideModal(modalVictory);
      showScreen('idle');
      busy = false;
    }
  });
})();
