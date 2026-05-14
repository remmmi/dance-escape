/* Dance Escape — kiosk state machine */
(function () {
  const $ = (id) => document.getElementById(id);
  const screenIdle = $('screen-idle');
  const screenDance = $('screen-dance');
  const btnStart = $('btn-start');
  const modalWarn = $('modal-warning');
  const modalVictory = $('modal-victory');
  const modalCustom = $('modal-custom');
  const customTitle = $('custom-title');
  const customMessage = $('custom-message');
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
  let musicStartCtxTime = 0;   // AudioContext.currentTime at music start (MP3 BufferSource path)
  let currentTrackDurationMs = 0; // length of the playing track in ms (0 if unknown)

  // Hardcoded timeline constants (volontairement non-settables — sans
  // intérêt à toucher pour un kiosk one-shot, et les chiffres ont été
  // calibrés à l'oreille).
  const BUZZER_DURATION_MS = 1500;  // longueur fixe du buzzer asynchrone
  const DUCK_VOLUME = 0.10;         // niveau auquel la musique baisse pendant le buzzer
  const FADE_DURATION_MS = 10000;   // fondu final avant reset

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
        musicSrc.loop = false;   // play start-to-finish, no loop
        musicGain = ctx.createGain();
        musicGain.gain.setValueAtTime(musicTargetVolume, ctx.currentTime);
        musicSrc.connect(musicGain).connect(ctx.destination);
        musicStartCtxTime = ctx.currentTime;
        currentTrackDurationMs = (buf.duration || 0) * 1000;
        musicSrc.start(0);
      } else {
        musicEl = new Audio(track.url);
        musicEl.preload = 'auto';
        musicEl.loop = false;
        musicEl.volume = musicTargetVolume;
        // Capture duration once metadata loads; T5=0 needs it.
        musicEl.addEventListener('loadedmetadata', () => {
          currentTrackDurationMs = (musicEl.duration || 0) * 1000;
        }, { once: true });
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
          // Capture duration (subtract startSeconds). getDuration peut
          // renvoyer 0 sur warm-start, on retente jusqu'a 5 fois.
          const grabDur = (attempt = 0) => {
            try {
              const total = ytPlayer.getDuration();
              if (total > 0) currentTrackDurationMs = Math.max(0, (total - start) * 1000);
              else if (attempt < 5) setTimeout(() => grabDur(attempt + 1), 400);
            } catch {}
          };
          grabDur();
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
                // getDuration() peut renvoyer 0 juste apres onReady (video
                // pas encore parsee). On retente jusqu'a 5 fois.
                const grabDur = (attempt = 0) => {
                  try {
                    const total = ev.target.getDuration();
                    if (total > 0) currentTrackDurationMs = Math.max(0, (total - start) * 1000);
                    else if (attempt < 5) setTimeout(() => grabDur(attempt + 1), 400);
                  } catch {}
                };
                grabDur();
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
    // CRITIQUE : couper le son YT avant destroy() qui est async. Sans
    // ces 3 lignes, l'audio peut continuer pendant 100-500ms apres la
    // commande destroy, le temps que l'iframe soit effectivement retire.
    try { if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(0); } catch {}
    try { if (ytPlayer && ytPlayer.mute) ytPlayer.mute(); } catch {}
    try { if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo(); } catch {}
    try { if (ytPlayer && ytPlayer.destroy) { ytPlayer.destroy(); ytPlayer = null; } } catch {}
    // Re-create yt-host since destroy replaces it
    if (!document.getElementById('yt-host')) {
      const d = document.createElement('div');
      d.id = 'yt-host'; d.className = 'yt-host'; d.setAttribute('aria-hidden', 'true');
      document.body.appendChild(d);
    }
  }

  // Full audio reset between sessions. stopMusic() destroys the ACTIVE
  // player, but the pre-warmed ytPreparedPlayer + the volume tracking
  // state must also be reset, otherwise:
  //   - a fade-to-0 from the previous session leaves musicTargetVolume=0
  //   - the next startMusic() reads 0 and the user hears nothing
  //   - the warm-start path reuses a player that was put in a weird
  //     state by the previous session's destroy()
  // Calling resetAudioState() at end-of-session AND at start-of-session
  // (defensive) gives a clean slate every time.
  function resetAudioState() {
    stopMusic();
    try { if (ytPreparedPlayer && ytPreparedPlayer.destroy) ytPreparedPlayer.destroy(); } catch {}
    ytPreparedPlayer = null;
    preparedTrack = null;
    musicTargetVolume = 1.0;
    musicStartCtxTime = 0;
    currentTrackDurationMs = 0;
    // CRITIQUE : force-remove any leftover yt-host iframe. YT.Player.destroy()
    // est asynchrone et incomplet — l'iframe DOM peut survivre. Si on laisse
    // l'iframe pre-warm (avec mute=1) en place, le cold path suivant
    // adopte cet iframe muet au lieu d'en creer un neuf → "session 2 muette".
    const existing = document.getElementById('yt-host');
    if (existing) existing.remove();
    const d = document.createElement('div');
    d.id = 'yt-host'; d.className = 'yt-host'; d.setAttribute('aria-hidden', 'true');
    document.body.appendChild(d);
  }

  // Compute how many ms remain on the currently-playing track. For MP3 in
  // loop mode we return the remainder of the current loop iteration. For
  // YouTube we use the iframe API. Returns 0 if nothing playing or unknown.
  function remainingMusicMs() {
    try {
      if (musicSrc && musicSrc.buffer) {
        const durSec = musicSrc.buffer.duration;
        const elapsed = ac().currentTime - musicStartCtxTime;
        const inLoop = ((elapsed % durSec) + durSec) % durSec;
        return Math.max(0, (durSec - inLoop) * 1000);
      }
      if (musicEl) {
        const total = Number(musicEl.duration);
        if (isFinite(total) && total > 0) {
          return Math.max(0, (total - musicEl.currentTime) * 1000);
        }
      }
      if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
        const total = ytPlayer.getDuration();
        const pos = ytPlayer.getCurrentTime();
        if (isFinite(total) && total > 0) {
          return Math.max(0, (total - pos) * 1000);
        }
      }
    } catch {}
    return 0;
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
    if (mediaStream) return; // already warm
    // On ne consulte PAS l'API Permissions : avec
    // --use-fake-ui-for-media-stream (mode kiosk Chromium), elle renvoie
    // 'prompt' au boot mais getUserMedia reussit quand meme sans
    // interaction. Sans le flag, getUserMedia echoue silencieusement
    // (pas de prompt sans user gesture) → catch ci-dessous → aucun mal.
    try {
      console.time('[warmup camera]');
      mediaStream = await navigator.mediaDevices.getUserMedia(CAM_CONSTRAINTS);
      camEl.srcObject = mediaStream;
      console.timeEnd('[warmup camera]');
    } catch (e) {
      // Echec attendu sans --use-fake-ui et sans permission persistee.
      // Le clic Start declenchera getUserMedia avec user gesture → prompt
      // ou succes selon les flags. Aucune action a faire ici.
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

  // Apply admin-editable strings to every [data-text] element. Elements
  // marked with data-text-html (only warningBody by default) accept a
  // limited subset of HTML — admin is trusted, no public input here.
  function applyTexts(texts) {
    if (!texts) return;
    for (const el of document.querySelectorAll('[data-text]')) {
      const key = el.dataset.text;
      const val = texts[key];
      if (typeof val !== 'string') continue;
      if (el.hasAttribute('data-text-html')) el.innerHTML = val;
      else el.textContent = val;
    }
  }

  // ---- modales annexes M-1..M-n ----
  // Schedule + show/hide indépendants de la timeline T1-T5. Pas de
  // pause audio, pas d'await — purement fire-and-forget par setTimeout.
  // Si la modale suivante doit pop pendant que la précédente est encore
  // affichée, on remplace : hide d'abord, puis show.
  let customModalTimers = [];
  let activeCustomId = null;

  function showCustomModalEl(m) {
    customTitle.textContent = m.title || '';
    customMessage.textContent = m.message || '';
    activeCustomId = m.id;
    showModal(modalCustom);
  }

  function hideCustomModalIfActive(id) {
    if (activeCustomId === id) {
      hideModal(modalCustom);
      activeCustomId = null;
    }
  }

  function scheduleCustomModals(modals, sessionStartPerf) {
    cancelCustomModals(); // safe re-call
    if (!Array.isArray(modals) || modals.length === 0) return;
    for (const m of modals) {
      if (!m || typeof m.t !== 'number' || !(m.title || m.message)) continue;
      const id = m.id || ('m' + Math.random().toString(36).slice(2, 6));
      const showAt = Math.max(0, m.t);
      const dur = Math.max(0, Number(m.duration) || 0);
      // Show : si une autre modale custom est active, la fermer d'abord
      customModalTimers.push(setTimeout(() => {
        if (activeCustomId) hideModal(modalCustom);
        showCustomModalEl({ id, title: m.title, message: m.message });
      }, Math.max(0, showAt - (performance.now() - sessionStartPerf))));
      // Hide : ne ferme que si CETTE modale est encore active
      customModalTimers.push(setTimeout(() => {
        hideCustomModalIfActive(id);
      }, Math.max(0, (showAt + dur) - (performance.now() - sessionStartPerf))));
    }
  }

  function cancelCustomModals() {
    customModalTimers.forEach(clearTimeout);
    customModalTimers = [];
    if (activeCustomId) {
      hideModal(modalCustom);
      activeCustomId = null;
    }
  }

  // ---- main flow ----
  async function runSession() {
    if (busy) return;
    busy = true;
    // PAS de resetAudioState ici : ca detruirait le ytPreparedPlayer
    // warm-start cree par prepareNextTrack, forcant le cold path
    // (~500-1000ms d'attente avant que la musique demarre). Le reset
    // de fin de session (T5+10) + le iframe.remove() de stopMusic
    // suffisent a garder un etat propre entre sessions.
    try {
      cfg = await fetchConfig();
      // Refresh SFX URLs (admin may have replaced them since boot) and
      // kick a fresh preload so any new track gets cached before pickTrack.
      applyTexts(cfg.texts);
      preloadFromConfig(cfg);
    } catch (e) {
      showToast("Configuration introuvable");
      busy = false; return;
    }

    // ----------------------------------------------------------------
    // Event-driven timeline (tous les temps en ms depuis T0=0).
    //   T0           : start - musique 100% + start enregistrement
    //   T1           : event 1 - modal "Faites mieux" + buzzer 1.5s + duck musique 1.5s
    //   T1 + warning : disparition modal warning
    //   T2           : event 2 - victoire (son + confettis + modal code)
    //   T3           : event 3 - fin enregistrement
    //   T4           : event 4 - disparition modal code
    //   T5           : event 5 - debut fadeout 10s. 0 = auto (song_duration - 10s).
    //   T5 + 10s     : reset complet (audio + UI) - kiosk prêt pour la suite
    // ----------------------------------------------------------------
    const t1 = +cfg.timings.t1Ms || 0;
    const warning = +cfg.timings.warningDurationMs || 0;
    const t2 = +cfg.timings.t2Ms || 0;
    const t3 = +cfg.timings.t3Ms || 0;
    const t4 = +cfg.timings.t4Ms || 0;
    const t5Setting = +cfg.timings.t5Ms || 0;
    secretCodeEl.textContent = cfg.secretCode || '—';

    // Cam/Mic permission - prerequis avant T0
    try {
      console.time('[click→getUserMedia]');
      await startRecording();
      console.timeEnd('[click→getUserMedia]');
      if (permHint) permHint.classList.add('hidden');
    } catch (e) {
      console.error('cam/mic error', e);
      showToast("Caméra/micro refusés. Activez-les pour continuer.");
      busy = false; return;
    }

    // T0 = maintenant. Musique + enregistrement demarrent en parallele.
    startDebugChrono();
    showScreen('dance');
    const track = preparedTrack || pickTrack(cfg.playlist);
    if (!track) {
      trackTag.textContent = "Aucune musique configurée";
    }
    setMusicVolume(1.0);
    if (track) {
      console.time('[startMusic]');
      startMusic(track).finally(() => console.timeEnd('[startMusic]')).catch(() => {});
    }
    const stopBar = startTimer(t3);
    const t0Perf = performance.now();
    const at = (absMs) => sleep(Math.max(0, absMs - (performance.now() - t0Perf)));

    // Modales annexes (M-1..M-n) : declenchement independant par setTimeout.
    scheduleCustomModals(cfg.customModals, t0Perf);

    // ── Event 1 @ T1 : duck + buzzer async + modal warning ──
    await at(t1);
    fadeMusic(DUCK_VOLUME, 300);
    playBuzzer(BUZZER_DURATION_MS); // fire-and-forget, audio scheduled sur AudioContext clock
    showModal(modalWarn);
    const warnStart = performance.now();
    warnCount.textContent = Math.ceil(warning / 1000);
    const warnInterval = setInterval(() => {
      const remain = Math.max(0, Math.ceil((warning - (performance.now() - warnStart)) / 1000));
      warnCount.textContent = remain;
    }, 200);
    // Au bout de 1.5s la musique remonte (independamment de la fin du modal).
    setTimeout(() => fadeMusic(1.0, 500), BUZZER_DURATION_MS);
    // Le modal disparait apres sa duree de countdown.
    await sleep(warning);
    clearInterval(warnInterval);
    hideModal(modalWarn);

    // ── Event 2 @ T2 : victoire ──
    await at(t2);
    fadeMusic(0.1, 250);   // duck pour que l'arpege victory soit clair
    playVictory();
    setTimeout(() => fadeMusic(1.0, 1500), 1300);
    // Confettis : duree etendue (15s par defaut, capee a la moitie de
    // la phase T2 → T4 pour ne jamais deborder sur le reset). Visibles
    // par-dessus le modal victoire grace au z-index 150 (vs modal=50).
    if (window.DanceConfetti) {
      const confettiMs = Math.max(12000, Math.min(15000, Math.floor((t4 - t2) / 2)));
      DanceConfetti.launch({ duration: confettiMs });
    }
    showModal(modalVictory);

    // ── Event 3 @ T3 : fin enregistrement ──
    await at(t3);
    stopBar();
    const blob = await stopRecording();
    // On lance l'upload en parallele mais on garde la promesse pour
    // l'attendre avant le reset T5+10. Sans cela, si l'utilisateur recharge
    // la page ou enchaine vite sur une autre session, le fetch est avorte
    // mid-stream et le fichier video est tronque cote serveur.
    let uploadPromise = null;
    if (blob) {
      uploadPromise = uploadVideo(blob).catch(err => {
        console.warn('[upload] failed:', err && err.message);
      });
    }

    // ── Event 4 @ T4 : disparition modal code ──
    await at(t4);
    hideModal(modalVictory);
    timerFill.style.width = '0%';
    // Entre T4 et T5 : ecran dance avec cam preview, musique a 100%, pas de modal.

    // ── Event 5 @ T5 : debut fadeout ──
    // T5=0 → calcule pour que le fadeout finisse pile en fin de morceau.
    // Clamp >= t4 + 1s pour eviter un fadeout qui demarre avant T4.
    const t5 = t5Setting > 0
      ? t5Setting
      : Math.max(t4 + 1000, currentTrackDurationMs > 0 ? currentTrackDurationMs - FADE_DURATION_MS : t4);
    await at(t5);
    fadeMusic(0, FADE_DURATION_MS);

    // ── T5 + 10s : reset complet (audio + interface) ──
    await sleep(FADE_DURATION_MS);
    // Best-effort wait for the upload to finish before resetting.
    // L'upload a deja eu T3 → T5+10 (≥30s) pour pousser le blob ; on
    // accorde 15s de grace puis on force le reset coute que coute pour
    // ne JAMAIS hanger le kiosk a cause d'un upload lent ou casse.
    if (uploadPromise) {
      await Promise.race([
        uploadPromise,
        new Promise(r => setTimeout(r, 15000))
      ]).catch(() => {});
    }
    cancelCustomModals();
    resetAudioState();
    showScreen('idle');
    resetDebugChrono();
    busy = false;

    // Prepare la prochaine session (le yt-host est frais grace a resetAudioState).
    prepareNextTrack(cfg).catch(e => console.warn('[prepareNext]', e.message));
  }

  btnStart.addEventListener('click', () => {
    // Unlock audio context on user gesture
    try { ac().resume(); } catch {}
    runSession();
  });

  // Touche Entree globale -> equivalent du bouton "Démarrer". Pratique
  // pour les setups kiosk avec clavier sans souris (claviers sans-fil,
  // pointeur presentation). preventDefault() supprime aussi le click
  // natif que Chrome enverrait sur le bouton focuse, evitant tout
  // risque de double-fire (le guard "busy" l'absorberait, mais autant
  // etre propre).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      btnStart.click();
    }
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
      applyTexts(initial.texts);
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
