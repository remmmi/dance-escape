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
  const debugChrono = $('debug-chrono');
  const permHint = $('perm-hint');

  let cfg = null;
  let busy = false;

  // ---- audio helpers (Web Audio API) ----
  let audioCtx = null;
  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // AudioBuffer cache. Values are either Promise<AudioBuffer> (in flight)
  // or AudioBuffer (resolved). Used both for MP3 tracks and custom SFX
  // — anything decoded once is instant on playback after that.
  const bufferCache = new Map();

  async function loadBuffer(url) {
    if (!url) return null;
    const cached = bufferCache.get(url);
    if (cached instanceof AudioBuffer) return cached;
    if (cached && typeof cached.then === 'function') return cached;
    const p = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('fetch ' + r.status);
      const arr = await r.arrayBuffer();
      const buf = await ac().decodeAudioData(arr);
      bufferCache.set(url, buf);
      return buf;
    })();
    bufferCache.set(url, p);
    try { return await p; }
    catch (e) { bufferCache.delete(url); throw e; }
  }

  function getCachedBuffer(url) {
    const v = bufferCache.get(url);
    return v instanceof AudioBuffer ? v : null;
  }

  // Custom SFX URLs from the latest config fetch.
  let sfxUrls = { buzzerUrl: null, victoryUrl: null };

  async function preloadFromConfig(cfg) {
    sfxUrls = (cfg && cfg.sfx) || { buzzerUrl: null, victoryUrl: null };
    const tasks = [];
    for (const t of (cfg && cfg.playlist) || []) {
      if (t.type === 'mp3' && t.url) tasks.push(loadBuffer(t.url).catch(e => console.warn('[preload]', t.url, e.message)));
    }
    if (sfxUrls.buzzerUrl)  tasks.push(loadBuffer(sfxUrls.buzzerUrl).catch(e => console.warn('[preload buzzer]', e.message)));
    if (sfxUrls.victoryUrl) tasks.push(loadBuffer(sfxUrls.victoryUrl).catch(e => console.warn('[preload victory]', e.message)));
    return Promise.all(tasks);
  }

  function playCustomSfx(url, peakGain) {
    const buf = getCachedBuffer(url);
    if (!buf) return false;
    const ctx = ac();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = peakGain != null ? peakGain : 1.0;
    src.connect(g).connect(ctx.destination);
    src.start(0);
    return true;
  }

  // One-shot note helper: schedules an oscillator with an exponential
  // attack/release envelope. Used by playBuzzer and playVictory.
  function spawnNote(ctx, freq, start, dur, type, peak, freqEnd) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (freqEnd != null) o.frequency.linearRampToValueAtTime(freqEnd, start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.018);
    g.gain.setValueAtTime(peak, start + Math.max(0.02, dur - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(start);
    o.stop(start + dur + 0.04);
    return { o, g };
  }

  function playBuzzer(durationMs) {
    // If admin uploaded a custom buzzer, play that instead.
    if (sfxUrls.buzzerUrl && playCustomSfx(sfxUrls.buzzerUrl)) return;
    // Game-show "WRONG-WRONG": two short, harsh hits with a clean gap
    // instead of one descending "wawwwh" sweep.
    const ctx = ac();
    const totalSec = Math.max(0.4, durationMs / 1000);
    const hitDur = Math.min(0.42, totalSec * 0.32);
    const gap    = Math.min(0.18, totalSec * 0.11);
    const t0 = ctx.currentTime;
    const hits = [t0, t0 + hitDur + gap];

    for (const ts of hits) {
      // Body: square ~150 Hz that bites down a bit toward the end
      spawnNote(ctx, 150, ts, hitDur, 'square', 0.32, 120);
      // Sub layer: saw at the octave below for chest weight
      spawnNote(ctx, 75,  ts, hitDur, 'sawtooth', 0.22, 58);
      // High harshness: detuned square one octave up, low gain, gives
      // the characteristic "errrnh" bite
      const high = ctx.createOscillator();
      high.type = 'square';
      high.detune.value = -8;
      high.frequency.setValueAtTime(305, ts);
      high.frequency.linearRampToValueAtTime(245, ts + hitDur);
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0.0001, ts);
      hg.gain.exponentialRampToValueAtTime(0.10, ts + 0.012);
      hg.gain.setValueAtTime(0.10, ts + hitDur - 0.05);
      hg.gain.exponentialRampToValueAtTime(0.0001, ts + hitDur);
      high.connect(hg).connect(ctx.destination);
      high.start(ts); high.stop(ts + hitDur);
    }
  }

  function playVictory() {
    // If admin uploaded a custom victory sound, play that instead.
    if (sfxUrls.victoryUrl && playCustomSfx(sfxUrls.victoryUrl)) return;
    // Long, satisfying C-major arpeggio: 7-note rising run across two
    // octaves, then a sustained tonic chord with a final flourish and
    // sparkles riding on top.
    const ctx = ac();
    const t0 = ctx.currentTime;

    const stepDur  = 0.13;     // delay between arpeggio notes
    const noteHold = 0.55;     // each arpeggio note's audible length
    const arpeggio = [
      261.63, // C4
      329.63, // E4
      392.00, // G4
      523.25, // C5
      659.25, // E5
      783.99, // G5
      1046.50 // C6
    ];

    arpeggio.forEach((freq, i) => {
      const start = t0 + i * stepDur;
      spawnNote(ctx, freq, start, noteHold, 'triangle', 0.28);
      // Octave-up sine doubling for shimmer (lower amplitude)
      spawnNote(ctx, freq * 2, start, noteHold * 0.55, 'sine', 0.07);
    });

    // Sustained C-major chord at the top — the payoff
    const chordStart = t0 + arpeggio.length * stepDur + 0.04;
    const chordHold = 1.9;
    [523.25, 659.25, 783.99, 1046.50].forEach((f) => {
      spawnNote(ctx, f, chordStart, chordHold, 'triangle', 0.22);
    });
    // Soft sub-bass root for body
    spawnNote(ctx, 130.81, chordStart, chordHold, 'sine', 0.16);

    // Quick ascending flourish over the chord (G-A-B-C-E)
    [783.99, 880.00, 987.77, 1174.66, 1318.51].forEach((f, i) => {
      spawnNote(ctx, f, chordStart + 0.08 + i * 0.07, 0.32, 'sine', 0.12);
    });

    // Sparkles distributed across the chord tail
    for (let i = 0; i < 16; i++) {
      const t = chordStart + Math.random() * (chordHold * 0.85);
      const f = 1800 + Math.random() * 2800;
      spawnNote(ctx, f, t, 0.26, 'sine', 0.085);
    }
  }

  // ---- music player (BufferSource for preloaded MP3, HTMLAudioElement
  //      fallback, or YouTube iframe API) ----
  let musicEl = null;          // HTMLAudioElement (fallback path)
  let musicSrc = null;         // AudioBufferSourceNode (preloaded path)
  let musicGain = null;        // GainNode for BufferSource volume/fade
  let ytPlayer = null;         // active YT.Player for the current session
  let ytPreparedPlayer = null; // pre-warmed YT.Player for the next session
  let ytReady = null;
  let preparedTrack = null;    // the track picked for the next session
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
      // Prefer the preloaded AudioBuffer (zero-latency, sample-accurate).
      // Fall back to <audio> if the buffer isn't ready (e.g. just-added
      // track that hasn't been decoded yet).
      let buf = getCachedBuffer(track.url);
      if (!buf) {
        try { buf = await loadBuffer(track.url); } catch (e) { console.warn('mp3 decode failed', e); }
      }
      if (buf) {
        const ctx = ac();
        musicSrc = ctx.createBufferSource();
        musicSrc.buffer = buf;
        musicSrc.loop = true;
        musicGain = ctx.createGain();
        musicGain.gain.setValueAtTime(musicTargetVolume, ctx.currentTime);
        musicSrc.connect(musicGain).connect(ctx.destination);
        musicSrc.start(0);
      } else {
        musicEl = new Audio(track.url);
        musicEl.preload = 'auto';
        musicEl.loop = true;
        musicEl.volume = musicTargetVolume;
        try { await musicEl.play(); } catch (e) { console.warn('mp3 play failed', e); }
      }
    } else if (track.type === 'youtube') {
      const start = Number(track.startSeconds) || 0;
      // Warm path: a pre-warmed muted player is already buffering this
      // exact video. Just seek to the right spot, unmute, and let it play.
      if (ytPreparedPlayer && preparedTrack && preparedTrack.videoId === track.videoId
          && typeof ytPreparedPlayer.unMute === 'function') {
        ytPlayer = ytPreparedPlayer;
        ytPreparedPlayer = null;
        try {
          ytPlayer.unMute();
          ytPlayer.setVolume(Math.round(musicTargetVolume * 100));
          ytPlayer.seekTo(start, true);
          ytPlayer.playVideo();
        } catch (e) { console.warn('YT warm-start failed', e); }
        return;
      }
      // Cold path: build the player from scratch (first session before
      // preload finished, or admin changed the playlist mid-flight).
      try {
        await loadYouTubeAPI();
        await new Promise((resolve) => {
          ytPlayer = new YT.Player('yt-host', {
            videoId: track.videoId,
            width: 1, height: 1,
            playerVars: {
              autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1,
              playsinline: 1, fs: 0, iv_load_policy: 3,
              start
            },
            events: {
              onReady: (ev) => {
                ev.target.setVolume(Math.round(musicTargetVolume * 100));
                if (start > 0) {
                  try { ev.target.seekTo(start, true); } catch {}
                }
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

  // Pre-warm everything we can for the next session, so the click→sound
  // path is as close to zero as possible. Called at boot and after each
  // session ends.
  async function prepareNextTrack(cfg) {
    // Tear down any leftover prepared player (e.g. config changed)
    try { if (ytPreparedPlayer && ytPreparedPlayer.destroy) ytPreparedPlayer.destroy(); } catch {}
    ytPreparedPlayer = null;
    if (!document.getElementById('yt-host')) {
      const d = document.createElement('div');
      d.id = 'yt-host'; d.className = 'yt-host'; d.setAttribute('aria-hidden', 'true');
      document.body.appendChild(d);
    }

    const track = pickTrack((cfg && cfg.playlist) || []);
    preparedTrack = track;
    if (!track) return;

    if (track.type === 'mp3') {
      // Buffer is most likely already in cache from preloadFromConfig;
      // make doubly sure by awaiting loadBuffer.
      try { await loadBuffer(track.url); }
      catch (e) { console.warn('[prep mp3]', e.message); }
      return;
    }

    if (track.type === 'youtube') {
      try {
        console.time('[prep youtube]');
        await loadYouTubeAPI();
        const start = Number(track.startSeconds) || 0;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('YT prep timeout')), 12000);
          ytPreparedPlayer = new YT.Player('yt-host', {
            videoId: track.videoId,
            width: 1, height: 1,
            playerVars: {
              autoplay: 1,        // muted autoplay is allowed without gesture
              mute: 1,
              controls: 0, disablekb: 1, modestbranding: 1,
              playsinline: 1, fs: 0, iv_load_policy: 3,
              start
            },
            events: {
              onReady: (ev) => {
                clearTimeout(timeout);
                try { ev.target.mute(); ev.target.setVolume(0); ev.target.playVideo(); } catch {}
                resolve();
              }
            }
          });
        });
        console.timeEnd('[prep youtube]');
      } catch (e) {
        console.warn('[prep youtube] failed:', e.message);
        ytPreparedPlayer = null;
      }
    }
  }

  function setMusicVolume(v) {
    musicTargetVolume = Math.max(0, Math.min(1, v));
    if (musicGain) {
      const ctx = ac();
      musicGain.gain.cancelScheduledValues(ctx.currentTime);
      musicGain.gain.setValueAtTime(musicTargetVolume, ctx.currentTime);
    }
    if (musicEl) musicEl.volume = musicTargetVolume;
    if (ytPlayer && ytPlayer.setVolume) {
      try { ytPlayer.setVolume(Math.round(musicTargetVolume * 100)); } catch {}
    }
  }

  function fadeMusic(targetV, durationMs) {
    targetV = Math.max(0, Math.min(1, targetV));
    // For the BufferSource path use Web Audio's native ramp — sample-accurate.
    if (musicGain) {
      const ctx = ac();
      const t = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(musicGain.gain.value, t);
      musicGain.gain.linearRampToValueAtTime(targetV, t + durationMs / 1000);
      musicTargetVolume = targetV;
      return;
    }
    // <audio>/YT fall back to rAF interpolation.
    const startV = musicEl ? musicEl.volume :
      (ytPlayer && ytPlayer.getVolume ? (ytPlayer.getVolume() / 100) : musicTargetVolume);
    const t0 = performance.now();
    function step(now) {
      const p = Math.min(1, (now - t0) / durationMs);
      setMusicVolume(startV + (targetV - startV) * p);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function stopMusic() {
    try { if (musicSrc) { musicSrc.stop(); } } catch {}
    try { if (musicSrc) { musicSrc.disconnect(); } } catch {}
    try { if (musicGain) { musicGain.disconnect(); } } catch {}
    musicSrc = null; musicGain = null;
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
  let mediaStream = null;   // kept alive between sessions when permissions are granted
  let recorder = null;
  let chunks = [];

  // Audio constraints: disable WebRTC voice-call filters so the mic
  // captures the music + ambient noise faithfully. Default getUserMedia
  // settings (echo cancellation, noise suppression, AGC) are tuned for
  // video calls and aggressively strip anything that isn't speech —
  // including the music playing through the kiosk's speakers.
  const CAM_CONSTRAINTS = {
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  };

  // Pre-open camera + mic at boot when permissions are already granted,
  // so the click→record path skips the ~500-1500 ms hardware init. We
  // only create the MediaRecorder at click time — so the stream is "warm"
  // but no actual recording is in progress.
  async function warmupCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      const [cam, mic] = await Promise.all([
        navigator.permissions.query({ name: 'camera' }),
        navigator.permissions.query({ name: 'microphone' })
      ]);
      if (cam.state !== 'granted' || mic.state !== 'granted') return;
      if (mediaStream) return; // already warm
      console.time('[warmup camera]');
      mediaStream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
      camEl.srcObject = mediaStream;
      console.timeEnd('[warmup camera]');
    } catch (e) {
      console.warn('[warmup camera] failed:', e.message);
      mediaStream = null;
    }
  }

  function teardownStream() {
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
    mediaStream = null;
    try { camEl.srcObject = null; } catch {}
  }

  async function startRecording() {
    // Reuse the warm stream if it's still alive (tracks not ended).
    const tracksAlive = mediaStream && mediaStream.getTracks().every(t => t.readyState === 'live');
    if (!tracksAlive) {
      if (mediaStream) teardownStream();
      mediaStream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
      camEl.srcObject = mediaStream;
    }
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
        // IMPORTANT: keep the stream alive — the next session reuses it
        // for near-zero start latency. Only Shift+Escape or page unload
        // tear it down.
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

  // Debug chrono: tenths of a second since session start, bottom-right.
  // Kept simple — useful for the operator to verify phase timings.
  let chronoRaf = null;
  function startDebugChrono() {
    if (!debugChrono) return;
    const t0 = performance.now();
    debugChrono.classList.add('running');
    let lastTenths = -1;
    function step(now) {
      const tenths = Math.floor((now - t0) / 100);
      if (tenths !== lastTenths) {
        lastTenths = tenths;
        debugChrono.textContent = (tenths / 10).toFixed(1) + ' s';
      }
      chronoRaf = requestAnimationFrame(step);
    }
    chronoRaf = requestAnimationFrame(step);
  }
  function stopDebugChrono() {
    if (chronoRaf) cancelAnimationFrame(chronoRaf);
    chronoRaf = null;
    if (debugChrono) debugChrono.classList.remove('running');
  }
  function resetDebugChrono() {
    stopDebugChrono();
    if (debugChrono) debugChrono.textContent = '0.0 s';
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
      // Refresh SFX URLs (admin may have replaced them since boot) and
      // kick a fresh preload so any new track gets cached before pickTrack.
      preloadFromConfig(cfg);
    } catch (e) {
      showToast("Configuration introuvable");
      busy = false; return;
    }

    const {
      phase1DurationMs, buzzerDurationMs, warningModalMs,
      victoryStartMs, totalDurationMs, victoryModalMs = 30000
    } = cfg.timings;
    secretCodeEl.textContent = cfg.secretCode || '—';

    // 1) Mic/Cam permission
    try {
      console.time('[click→getUserMedia]');
      await startRecording();
      console.timeEnd('[click→getUserMedia]');
      // After a successful capture we know permissions are granted —
      // hide the hint immediately (Permissions API may lag).
      if (permHint) permHint.classList.add('hidden');
    } catch (e) {
      console.error('cam/mic error', e);
      showToast("Caméra/micro refusés. Activez-les pour continuer.");
      busy = false; return;
    }

    // 2) Switch screens, use the pre-prepared track, play music
    startDebugChrono();
    showScreen('dance');
    // Use the track picked + pre-warmed at boot (or after the previous
    // session). Fall back to a fresh pick if preparation hasn't run yet.
    const track = preparedTrack || pickTrack(cfg.playlist);
    if (!track) {
      trackTag.textContent = "Aucune musique configurée";
    }
    setMusicVolume(1.0);
    if (track) {
      console.time('[startMusic]');
      startMusic(track).finally(() => console.timeEnd('[startMusic]')).catch(() => {});
    }

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

    // Phase 5: victory — duck briefly so the victory arpeggio is clear,
    // then bring the music back up and let it carry the celebration
    // through the full modal display time.
    const victoryShownAt = performance.now();
    fadeMusic(0.1, 250);
    playVictory();
    // Bring music back to full ~1.3 s into the arpeggio so it lifts the
    // sustained chord rather than fighting the first notes.
    setTimeout(() => fadeMusic(1.0, 1500), 1300);
    if (window.DanceConfetti) DanceConfetti.launch({ duration: Math.min(8000, totalDurationMs - victoryStartMs + 2000) });
    showModal(modalVictory);

    // Phase 6: keep recording until totalDurationMs
    const remainAfterVictory = Math.max(0, totalDurationMs - victoryStartMs);
    await sleep(remainAfterVictory);

    stopBar();
    // Stop recording — but the MUSIC keeps playing under the victory
    // modal until the modal time elapses. The full reset happens at the
    // very end.
    const blob = await stopRecording();
    if (blob) uploadVideo(blob).catch(() => {});

    // Phase 7: hold the victory modal (and the music) for victoryModalMs
    const modalElapsed = performance.now() - victoryShownAt;
    await sleep(Math.max(0, victoryModalMs - modalElapsed));

    // Final reset: cut the music, hide the modal, back to idle.
    stopMusic();
    hideModal(modalVictory);
    timerFill.style.width = '0%';
    showScreen('idle');
    resetDebugChrono();
    busy = false;

    // Prepare the next session now that yt-host is free (stopMusic
    // destroyed the active YT player and recreated the host).
    prepareNextTrack(cfg).catch(e => console.warn('[prepareNext]', e.message));
  }

  btnStart.addEventListener('click', () => {
    // Unlock audio context on user gesture
    try { ac().resume(); } catch {}
    runSession();
  });

  // Hide the "activate mic/cam" hint once both permissions are granted.
  // Uses the Permissions API where supported; also called after any
  // successful getUserMedia (which implicitly grants permission).
  async function refreshPermHint() {
    if (!permHint) return;
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      const [cam, mic] = await Promise.all([
        navigator.permissions.query({ name: 'camera' }),
        navigator.permissions.query({ name: 'microphone' })
      ]);
      const granted = cam.state === 'granted' && mic.state === 'granted';
      permHint.classList.toggle('hidden', granted);
      // Listen for runtime changes (user revokes from browser settings,
      // or grants on first prompt) so the hint stays in sync.
      const onChange = () => refreshPermHint();
      if (!cam._dwatched) { cam.addEventListener('change', onChange); cam._dwatched = true; }
      if (!mic._dwatched) { mic.addEventListener('change', onChange); mic._dwatched = true; }
    } catch { /* unsupported permission name (e.g. Firefox) — leave hint visible */ }
  }
  refreshPermHint();
  // Warm up the camera at boot too — if permissions are already granted
  // we open the device once and keep it open between sessions, skipping
  // the 500-1500 ms hardware init on the click path.
  warmupCamera();

  // Boot-time preloading: fetch config, decode all MP3 tracks + custom
  // SFX into AudioBuffers, AND pre-warm a YouTube player (muted autoplay)
  // for the next session. Goal: at click-time, all that's left is
  // getUserMedia + unMute. Re-runs every 60 s so admin updates show up
  // without needing a page refresh.
  async function bootstrap({ prepare = true } = {}) {
    try {
      const initial = await fetchConfig();
      cfg = initial;
      preloadFromConfig(initial);
      if (prepare) {
        prepareNextTrack(initial).catch(e => console.warn('[prepareNext]', e.message));
      }
    } catch (e) {
      console.warn('[bootstrap] config fetch failed:', e.message);
    }
  }
  bootstrap();
  // Periodic refresh of MP3 cache + SFX URLs only — do NOT recreate the
  // prepared YT player every minute (it'd cancel the pre-buffer).
  setInterval(() => bootstrap({ prepare: false }), 60000);

  // Keyboard "Escape" to bail out (admin convenience)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.shiftKey) {
      stopMusic();
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
      teardownStream();
      hideModal(modalWarn); hideModal(modalVictory);
      showScreen('idle');
      resetDebugChrono();
      busy = false;
    }
  });
})();
