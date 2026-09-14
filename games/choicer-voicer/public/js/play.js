(function () {
  const socket = CV.createSocket();
  const params = new URLSearchParams(location.search);

  const errorEl = document.getElementById('error');
  const btnReturnLobby = document.getElementById('btnReturnLobby');
  const videoError = document.getElementById('videoError');
  const joinCard = document.getElementById('joinCard');
  const gameCard = document.getElementById('gameCard');
  const subtitle = document.getElementById('subtitle');
  const phasePill = document.getElementById('phasePill');
  const statusText = document.getElementById('statusText');
  const castPanel = document.getElementById('castPanel');
  const waitPanel = document.getElementById('waitPanel');
  const dubPanel = document.getElementById('dubPanel');
  const castButtons = document.getElementById('castButtons');
  const playerList = document.getElementById('playerList');
  const mySceneList = document.getElementById('mySceneList');
  const myScenesHeading = document.getElementById('myScenesHeading');
  const btnReady = document.getElementById('btnReady');
  const btnUnready = document.getElementById('btnUnready');
  const readyHint = document.getElementById('readyHint');
  const waitLobbyText = document.getElementById('waitLobbyText');
  const progressSummary = document.getElementById('progressSummary');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressChars = document.getElementById('progressChars');
  const progressClipList = document.getElementById('progressClipList');
  const video = document.getElementById('playerVideo');
  const captionOverlay = document.getElementById('captionOverlay');
  const segmentHint = document.getElementById('segmentHint');
  const sceneCaption = document.getElementById('sceneCaption');
  const sceneMeta = document.getElementById('sceneMeta');
  const btnPlaySeg = document.getElementById('btnPlaySeg');
  const micBtn = document.getElementById('micBtn');
  const micHint = document.getElementById('micHint');
  const micGainRow = document.getElementById('micGainRow');
  const micGainEl = document.getElementById('micGain');
  const micGainVal = document.getElementById('micGainVal');
  const btnSubmit = document.getElementById('btnSubmit');
  const btnRerecord = document.getElementById('btnRerecord');
  const btnRef = document.getElementById('btnRef');
  const btnPlayTake = document.getElementById('btnPlayTake');
  const takeDone = document.getElementById('takeDone');
  const waveCanvas = document.getElementById('waveCanvas');
  const waveHint = document.getElementById('waveHint');
  const waveTimingRow = document.getElementById('waveTimingRow');
  const timingOffsetEl = document.getElementById('timingOffset');
  const timingOffsetVal = document.getElementById('timingOffsetVal');
  const btnTimingMinus = document.getElementById('btnTimingMinus');
  const btnTimingPlus = document.getElementById('btnTimingPlus');
  const btnTimingReset = document.getElementById('btnTimingReset');
  const codeInput = document.getElementById('code');
  const nameInput = document.getElementById('name');
  const btnJoin = document.getElementById('btnJoin');
  const btnStartMp = document.getElementById('btnStartMp');
  const btnPrevScene = document.getElementById('btnPrevScene');
  const btnNextScene = document.getElementById('btnNextScene');
  const myScenesCount = document.getElementById('myScenesCount');
  const hostLobbyMeta = document.getElementById('hostLobbyMeta');
  const lobbyRoomCode = document.getElementById('lobbyRoomCode');
  const lobbyJoinUrl = document.getElementById('lobbyJoinUrl');
  const castIntro = document.getElementById('castIntro');
  const pageEl = document.querySelector('main.page');
  const cinemaBar = document.getElementById('cinemaBar');
  const dubWorkArea = document.getElementById('dubWorkArea');
  const submitPrompt = document.getElementById('submitPrompt');
  const btnConfirmSubmit = document.getElementById('btnConfirmSubmit');
  const btnDismissSubmit = document.getElementById('btnDismissSubmit');
  const btnSubmitFinal = document.getElementById('btnSubmitFinal');
  const btnStartPremiere = document.getElementById('btnStartPremiere');
  const premiereWaitHint = document.getElementById('premiereWaitHint');
  const allDoneBar = document.getElementById('allDoneBar');
  const submitPromptBody = document.getElementById('submitPromptBody');
  const btnPlayMovie = document.getElementById('btnPlayMovie');
  const btnDownloadVideo = document.getElementById('btnDownloadVideo');
  const btnSaveProject = document.getElementById('btnSaveProject');
  const btnBackToClips = document.getElementById('btnBackToClips');
  const cinemaStatus = document.getElementById('cinemaStatus');
  const cinemaIntro = document.getElementById('cinemaIntro');
  const toastEl = document.getElementById('appToast');
  // Optional legacy nodes (removed from UI)
  const btnPauseSeg = document.getElementById('btnPauseSeg');
  const btnStopMovie = document.getElementById('btnStopMovie');
  const btnDownloadWav = document.getElementById('btnDownloadWav');

  let state = null;
  let playerId = null;
  let isRoomHost = false;
  let selectedSceneId = null;
  let isRecording = false;
  let recordPrerollActive = false;
  let recorded = null;
  let savedTake = null;
  let recordStartedAt = 0;
  let recordExactTimer = null;
  let segmentWatcher = null;
  let segmentRaf = null;
  let playGen = 0;
  let mode = 'idle';
  let videoReady = false;
  let waveToken = 0;
  let timingSaveTimer = null;
  let timingDrag = null;
  let submitPromptDismissed = false;
  let movieCtl = null;
  let exportCache = null;
  let premixBuffer = null;
  let premixToken = 0;
  let cinemaCaptionWatcher = null;
  let clockOffsetMs = 0;
  let haveClockOffset = false;
  let clockPingTimer = null;
  let premierePlaySeq = 0;
  let premiereArmRound = 0;
  let activeLocalProjectId = sessionStorage.getItem('cv_localProjectId') || null;

  /** Fester Luft-Vorsatz im Timing-Vergleich (Wellenform startet nie hart am linken Rand). */
  const WAVE_COMPARE_LEAD_SEC = 0.4;
  /** Manueller Take-Shift (± Sekunden). */
  const TIMING_OFFSET_MAX_SEC = 0.6;

  codeInput.value = (params.get('code') || '').toUpperCase();
  nameInput.value = params.get('name') || '';

  const MIC_GAIN_DEFAULT_PCT = 100;

  function currentPlayerName() {
    const fromState = (state?.players || []).find((p) => p.id === playerId)?.name;
    return String(fromState || nameInput?.value || '').trim();
  }

  function micGainStorageKey(name) {
    const n = String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9._-]/gi, '')
      .slice(0, 48);
    return n ? `cv_micGain:${n}` : 'cv_micGain:default';
  }

  function applyMicGainPercent(pct, { save = false } = {}) {
    let value = Math.round(Number(pct));
    if (!Number.isFinite(value)) value = MIC_GAIN_DEFAULT_PCT;
    value = Math.min(200, Math.max(40, Math.round(value / 5) * 5));
    if (micGainEl) micGainEl.value = String(value);
    if (micGainVal) micGainVal.textContent = `${value}%`;
    CVAudio.setMicGain?.(value / 100);
    if (save) {
      try {
        localStorage.setItem(micGainStorageKey(currentPlayerName()), String(value));
      } catch (_) {}
    }
    return value;
  }

  function loadMicGainForUser(name) {
    let pct = MIC_GAIN_DEFAULT_PCT;
    try {
      const raw = localStorage.getItem(micGainStorageKey(name));
      if (raw != null) {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed)) pct = parsed;
      }
    } catch (_) {}
    applyMicGainPercent(pct, { save: false });
  }

  // Restore last used name's mic level early (join form / URL)
  loadMicGainForUser(nameInput?.value || '');

  if (micGainEl) {
    micGainEl.addEventListener('input', () => {
      applyMicGainPercent(micGainEl.value, { save: true });
    });
  }

  function clampTimingOffsetSec(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-TIMING_OFFSET_MAX_SEC, Math.min(TIMING_OFFSET_MAX_SEC, n));
  }

  function formatTimingOffset(sec) {
    const v = clampTimingOffsetSec(sec);
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)} s`;
  }

  function getCurrentTimingOffset() {
    if (recorded && Number.isFinite(recorded.timingOffsetSec)) {
      return clampTimingOffsetSec(recorded.timingOffsetSec);
    }
    if (savedTake && Number.isFinite(savedTake.timingOffsetSec)) {
      return clampTimingOffsetSec(savedTake.timingOffsetSec);
    }
    return 0;
  }

  function syncTimingControls(offsetSec, { hasTake = true } = {}) {
    const v = clampTimingOffsetSec(offsetSec);
    if (timingOffsetEl) timingOffsetEl.value = String(Math.round(v * 1000));
    if (timingOffsetVal) timingOffsetVal.textContent = formatTimingOffset(v);
    if (waveTimingRow) {
      if (hasTake) waveTimingRow.removeAttribute('hidden');
      else waveTimingRow.setAttribute('hidden', '');
    }
    const disabled = !hasTake || isRecording || recordPrerollActive;
    if (timingOffsetEl) timingOffsetEl.disabled = disabled;
    if (btnTimingMinus) btnTimingMinus.disabled = disabled;
    if (btnTimingPlus) btnTimingPlus.disabled = disabled;
    if (btnTimingReset) btnTimingReset.disabled = disabled || Math.abs(v) < 0.005;
  }

  function applyTimingOffsetLocal(nextSec, { persist = true } = {}) {
    const v = clampTimingOffsetSec(nextSec);
    if (recorded) recorded = { ...recorded, timingOffsetSec: v };
    if (savedTake) savedTake = { ...savedTake, timingOffsetSec: v };
    syncTimingControls(v, { hasTake: !!(recorded || savedTake || state?.takeStatus?.[selectedSceneId]) });
    refreshWaveform();
    exportCache = null;
    premixBuffer = null;
    premixToken += 1;
    if (persist) scheduleTimingPersist(v);
  }

  function scheduleTimingPersist(offsetSec) {
    if (timingSaveTimer) clearTimeout(timingSaveTimer);
    timingSaveTimer = setTimeout(() => {
      timingSaveTimer = null;
      void persistTimingOffset(offsetSec);
    }, 350);
  }

  async function persistTimingOffset(offsetSec) {
    const scene = selectedScene();
    if (!scene) return;
    const v = clampTimingOffsetSec(offsetSec);
    let audioBase64 = savedTake?.audioBase64 || null;
    let mimeType = savedTake?.mimeType || recorded?.mimeType || 'audio/wav';
    let durationMs = recorded?.durationMs || savedTake?.durationMs || 0;
    if (!audioBase64 && recorded?.blob) {
      try {
        audioBase64 = await CVAudio.blobToBase64(recorded.blob);
      } catch (_) {
        return;
      }
    }
    if (!audioBase64) return;
    try {
      const res = await CV.emitAck(socket, 'dub:submit-take', {
        sceneId: scene.id,
        audioBase64,
        mimeType,
        durationMs,
        timingOffsetSec: v,
      });
      if (res.error) {
        CV.showError(errorEl, res.error);
        return;
      }
      savedTake = {
        audioBase64,
        mimeType,
        durationMs,
        timingOffsetSec: Number.isFinite(res.timingOffsetSec) ? res.timingOffsetSec : v,
      };
      if (recorded) recorded = { ...recorded, timingOffsetSec: savedTake.timingOffsetSec };
    } catch (err) {
      CV.showError(errorEl, err.message || 'Timing speichern fehlgeschlagen.');
    }
  }

  async function refreshWaveform() {
    if (!waveCanvas || typeof CVWaveform === 'undefined') return;
    const scene = selectedScene();
    const token = ++waveToken;
    if (waveHint) waveHint.textContent = 'Vergleich wird geladen…';

    if (scene) {
      await ensureReferenceDuration(scene);
      if (token !== waveToken) return;
      if (selectedSceneId === scene.id && sceneMeta) {
        sceneMeta.textContent = `${scene.character} · ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s`;
      }
    }

    // Prefer draft, then cached saved take, then fetch from server
    let takeBlob = recorded?.blob || null;
    let takeBase64 = !takeBlob ? savedTake?.audioBase64 : null;
    let takeMime = recorded?.mimeType || savedTake?.mimeType;

    if (!takeBlob && !takeBase64 && scene && state?.takeStatus?.[scene.id]) {
      try {
        const res = await CV.emitAck(socket, 'dub:get-take', { sceneId: scene.id });
        if (res.ok && token === waveToken) {
          savedTake = {
            audioBase64: res.audioBase64,
            mimeType: res.mimeType,
            timingOffsetSec: clampTimingOffsetSec(res.timingOffsetSec),
          };
          takeBase64 = res.audioBase64;
          takeMime = res.mimeType;
        }
      } catch (_) {}
    }

    const timingOffsetSec = getCurrentTimingOffset();
    const hasTake = !!(takeBlob || takeBase64);
    syncTimingControls(timingOffsetSec, { hasTake });

    const speechSec = scene ? Math.max(0.4, sceneEnd(scene) - (scene.timestamp || 0)) : null;
    const leadSec = speechSec != null ? WAVE_COMPARE_LEAD_SEC : 0;
    const timelineSec = speechSec != null ? speechSec + leadSec : null;
    const result = await CVWaveform.refresh(waveCanvas, {
      originalUrl: scene?.referenceUrl || null,
      takeBlob,
      takeBase64,
      takeMime,
      timelineSec,
      audioOffsetSec: leadSec,
      timingOffsetSec,
    });
    if (token !== waveToken) return;

    if (waveHint) {
      if (result.hasOriginal && result.hasTake) {
        const drift =
          Number.isFinite(result.voiceStartSec) && Number.isFinite(result.cueMarkerSec)
            ? result.voiceStartSec - result.cueMarkerSec
            : null;
        const driftTxt =
          drift != null && Math.abs(drift) >= 0.05
            ? ` · Stimme ${drift > 0 ? '+' : ''}${drift.toFixed(2)}s vs REC`
            : '';
        const offTxt =
          Math.abs(timingOffsetSec) >= 0.005 ? ` · Shift ${formatTimingOffset(timingOffsetSec)}` : '';
        waveHint.textContent =
          `Grün = REC · Ziehen = Timing${offTxt}${driftTxt} · Rosa = Original · Violett = Take`;
      } else if (result.hasOriginal) {
        waveHint.textContent = 'Grün = REC-Start — nimm deinen Take auf zum Vergleich.';
      } else if (result.hasTake) {
        waveHint.textContent = 'Dein Take — Original konnte nicht geladen werden. Timing per Slider/Ziehen.';
      } else {
        waveHint.textContent = 'Noch kein Vergleich — Original oder Take aufnehmen.';
      }
    }
  }

  video.addEventListener('error', () => {
    videoReady = false;
    const msg =
      'Video konnte nicht geladen werden. Browser braucht MP4 (nicht OGV). Seite neu laden / Server neu starten.';
    CV.showError(videoError, msg);
    segmentHint.textContent = 'Video-Fehler';
  });

  video.addEventListener('loadeddata', () => {
    videoReady = true;
    CV.showError(videoError, '');
  });

  const AUDIO_PAD_SEC = 0;
  /** Stummer Video-Vorlauf vor dem Sprech-Cue (visuell, kein Timer-Countdown). */
  const VISUAL_PREROLL_SEC = 1.2;
  /** Mindest-Pause vor dem nächsten Cue (Atem/Abstand zwischen Clips). */
  const INTER_CLIP_GAP_SEC = 0.14;
  /** @type {Map<string, number>} sceneId → measured reference MP3 seconds */
  const measuredRefDuration = new Map();

  function sceneSpeechSeconds(scene) {
    if (!scene) return null;
    if (Number.isFinite(scene.referenceDuration) && scene.referenceDuration > 0.05) {
      return scene.referenceDuration;
    }
    const measured = measuredRefDuration.get(scene.id);
    if (Number.isFinite(measured) && measured > 0.05) return measured;
    return null;
  }

  function nextSceneTimestamp(scene) {
    if (!scene) return null;
    const start = Number(scene.timestamp) || 0;
    let next = null;
    for (const s of state?.pack?.scenes || []) {
      const t = Number(s.timestamp) || 0;
      if (t > start + 0.001 && (next == null || t < next)) next = t;
    }
    return next;
  }

  /**
   * Take-Länge = Original-Clip. Nicht die Lücke zum nächsten Cue.
   */
  function sceneTakeDurationSec(scene) {
    if (!scene) return 0.15;
    const speech = sceneSpeechSeconds(scene);
    if (speech != null) return speech;
    return Math.max(0.15, sceneEnd(scene) - (Number(scene.timestamp) || 0));
  }

  function sceneEnd(scene) {
    if (!scene) return 0;
    const start = Number(scene.timestamp) || 0;
    const storedEnd = Number.isFinite(scene.endTimestamp)
      ? scene.endTimestamp
      : start + (scene.duration || 4);
    const speech = sceneSpeechSeconds(scene);
    let end =
      speech != null ? start + speech + AUDIO_PAD_SEC : storedEnd;

    const next = nextSceneTimestamp(scene);
    if (next != null) {
      const capped = next - INTER_CLIP_GAP_SEC;
      if (capped > start + 0.2) end = Math.min(end, capped);
    } else if (storedEnd > start && speech != null && storedEnd < end) {
      end = storedEnd;
    }

    return Math.round(Math.max(start + 0.2, end) * 1000) / 1000;
  }

  /**
   * Measure reference MP3 duration in the browser and patch the in-memory scene.
   */
  async function ensureReferenceDuration(scene) {
    if (!scene?.referenceUrl) return sceneSpeechSeconds(scene);
    const existing = sceneSpeechSeconds(scene);
    if (existing != null) {
      const start = Number(scene.timestamp) || 0;
      const end = sceneEnd(scene);
      scene.duration = Math.round((end - start) * 1000) / 1000;
      scene.endTimestamp = end;
      scene.referenceDuration = existing;
      return existing;
    }
    if (!CVWaveform?.loadOriginal) return null;
    try {
      const buf = await CVWaveform.loadOriginal(scene.referenceUrl);
      const dur = buf?.duration;
      if (!(Number.isFinite(dur) && dur > 0.05)) return null;
      measuredRefDuration.set(scene.id, dur);
      scene.referenceDuration = dur;
      const start = Number(scene.timestamp) || 0;
      const gapEnd = Number.isFinite(scene.endTimestamp)
        ? scene.endTimestamp
        : start + (scene.duration || 4);
      const audioEnd = start + dur;
      scene.endTimestamp =
        gapEnd > start && gapEnd < audioEnd
          ? Math.round(gapEnd * 1000) / 1000
          : Math.round(audioEnd * 1000) / 1000;
      scene.duration = Math.round((scene.endTimestamp - start) * 1000) / 1000;
      return dur;
    } catch (err) {
      console.warn('Referenz-Dauer messen fehlgeschlagen', err);
      return null;
    }
  }

  function myCharacters() {
    return Object.entries(state?.casting || {})
      .filter(([, pid]) => pid === playerId)
      .map(([ch]) => ch);
  }

  function myScenes() {
    const chars = new Set(myCharacters());
    return (state?.pack?.scenes || []).filter((s) => chars.has(s.character));
  }

  function selectedScene() {
    return (state?.pack?.scenes || []).find((s) => s.id === selectedSceneId) || null;
  }

  function clearDraft() {
    recorded = null;
  }

  function stopSegmentWatch() {
    if (segmentWatcher) {
      video.removeEventListener('timeupdate', segmentWatcher);
      segmentWatcher = null;
    }
  }

  function stopSegmentRaf() {
    if (segmentRaf) {
      cancelAnimationFrame(segmentRaf);
      segmentRaf = null;
    }
  }

  function bumpPlayGen() {
    playGen += 1;
    return playGen;
  }

  /** Immer gleicher Vorlauf: Video soweit möglich zurück, Rest als Standbild. */
  function prerollPlan(cueSec) {
    const seekTo = Math.max(0, cueSec - VISUAL_PREROLL_SEC);
    const videoLead = Math.max(0, cueSec - seekTo);
    const holdSec = Math.max(0, VISUAL_PREROLL_SEC - videoLead);
    return { seekTo, videoLead, holdSec };
  }

  function clearRecordExactTimer() {
    if (recordExactTimer) {
      clearTimeout(recordExactTimer);
      recordExactTimer = null;
    }
  }

  let wavePlayheadRaf = null;

  function stopWavePlayhead() {
    if (wavePlayheadRaf) {
      cancelAnimationFrame(wavePlayheadRaf);
      wavePlayheadRaf = null;
    }
  }

  function startWavePlayhead({ start, end, originalUrl, takeKey, getMediaTime }) {
    stopWavePlayhead();
    const speechDur = Math.max(0.2, end - start);
    const lead = WAVE_COMPARE_LEAD_SEC;
    const timingOffsetSec = getCurrentTimingOffset();
    const timelineSec = speechDur + lead;
    const timelineOrigin = start - lead;
    const tick = () => {
      if (!waveCanvas || !CVWaveform?.drawPlayhead) return;
      const t = typeof getMediaTime === 'function' ? getMediaTime() : video.currentTime || timelineOrigin;
      const playhead = Math.max(0, Math.min(1, (t - timelineOrigin) / timelineSec));
      const fromSpeech = t - start;
      CVWaveform.drawPlayhead(waveCanvas, {
        originalUrl: originalUrl || null,
        takeKey: takeKey || null,
        playhead,
        audioOffsetSec: lead,
        timingOffsetSec,
        cueMarkerSec: lead,
        durationLabel:
          fromSpeech < -0.05 ? `−${Math.abs(fromSpeech).toFixed(1)}s` : `${Math.max(0, fromSpeech).toFixed(1)}s`,
        timelineSec,
      });
      if (
        mode === 'take' ||
        mode === 'original' ||
        mode === 'preview' ||
        mode === 'recording' ||
        recordPrerollActive
      ) {
        wavePlayheadRaf = requestAnimationFrame(tick);
      }
    };
    wavePlayheadRaf = requestAnimationFrame(tick);
  }

  function pauseSegment() {
    bumpPlayGen();
    const wasWavePlayback = mode === 'take' || mode === 'original' || mode === 'preview';
    stopSegmentWatch();
    stopSegmentRaf();
    stopWavePlayhead();
    video.pause();
    CVAudio.stopPlayback();
    if (mode === 'preview' || mode === 'original' || mode === 'take') {
      mode = 'idle';
      segmentHint.textContent = 'Pausiert';
    }
    if (wasWavePlayback) refreshWaveform();
  }

  let seekToken = 0;

  function waitSeeked(target) {
    const myToken = ++seekToken;
    return new Promise((resolve) => {
      let settled = false;
      let seekStarted = false;
      const t = Math.max(0, Number(target) || 0);

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onSeeked);
        video.removeEventListener('loadedmetadata', onMeta);
        resolve(ok && myToken === seekToken);
      };

      const onSeeked = () => finish(true);

      const seek = () => {
        if (seekStarted) return;
        seekStarted = true;
        if (myToken !== seekToken) {
          finish(false);
          return;
        }
        if (video.readyState >= 1 && Math.abs((video.currentTime || 0) - t) < 0.04) {
          finish(true);
          return;
        }
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onSeeked);
        try {
          video.currentTime = t;
        } catch (_) {
          finish(false);
          return;
        }
        setTimeout(() => finish(myToken === seekToken), 700);
      };

      const onMeta = () => seek();
      if (video.readyState < 1) {
        video.addEventListener('loadedmetadata', onMeta);
        setTimeout(seek, 2000);
        return;
      }
      seek();
    });
  }

  async function playSegmentOnly({ forRecording = false, beginRecording = null } = {}) {
    return playSegmentSynced({
      modeName: forRecording ? 'recording' : 'preview',
      videoMuted: !!forRecording,
      overlay: 'none',
      forRecording,
      beginRecording,
    });
  }

  /**
   * Scene video + optional original/take audio (video muted when overlay is set).
   */
  async function playSegmentSynced(opts) {
    const scene = selectedScene();
    if (!scene) return;
    if (!video.src) {
      CV.showError(videoError, 'Kein Video geladen.');
      if (opts.forRecording) recordPrerollActive = false;
      return;
    }
    if ((isRecording || recordPrerollActive) && !opts.forRecording) return;

    const gen = bumpPlayGen();
    stopSegmentWatch();
    stopSegmentRaf();
    stopWavePlayhead();
    CVAudio.stopPlayback();

    await ensureReferenceDuration(scene);
    if (gen !== playGen) return;

    const start = Number(scene.timestamp) || 0;
    const end = sceneEnd(scene);
    const takeDur = sceneTakeDurationSec(scene);
    const takeTimingOff = opts.overlay === 'take' ? getCurrentTimingOffset() : 0;
    const stopAt =
      opts.forRecording || opts.overlay === 'take' || opts.overlay === 'original'
        ? start + takeDur + Math.max(0, takeTimingOff)
        : end;
    video.muted = !!opts.videoMuted;
    video.volume = 1;

    const recording = !!(opts.forRecording && typeof opts.beginRecording === 'function');
    // Vorlauf nur beim Aufnehmen — Original/Take/Filmton starten direkt am REC-Cue
    const usePreroll = recording;
    const plan = usePreroll
      ? prerollPlan(start)
      : { seekTo: start, videoLead: 0, holdSec: 0 };

    let takeKey = null;
    let pendingOverlayAudio = null;
    if (opts.overlay === 'original') {
      const url = scene.referenceUrl;
      if (!url) {
        CV.showError(errorEl, 'Kein Original vorhanden.');
        mode = 'idle';
        return;
      }
      if (CVWaveform?.loadOriginal) {
        try {
          await CVWaveform.loadOriginal(url);
        } catch (_) {}
      }
      if (gen !== playGen) return;
      pendingOverlayAudio = () => CVAudio.playUrl(url).catch(() => {});
    } else if (opts.overlay === 'take') {
      try {
        let takeBlob = recorded?.blob || null;
        let takeBase64 = !takeBlob ? savedTake?.audioBase64 : null;
        let takeMime = recorded?.mimeType || savedTake?.mimeType;
        if (!takeBlob && !takeBase64 && state?.takeStatus?.[scene.id]) {
          const res = await CV.emitAck(socket, 'dub:get-take', { sceneId: scene.id });
          if (res.error) {
            CV.showError(errorEl, res.error);
            mode = 'idle';
            return;
          }
          savedTake = {
            audioBase64: res.audioBase64,
            mimeType: res.mimeType,
            timingOffsetSec: clampTimingOffsetSec(res.timingOffsetSec),
          };
          takeBase64 = res.audioBase64;
          takeMime = res.mimeType;
        }
        if (!takeBlob && !takeBase64) {
          CV.showError(errorEl, 'Noch kein Take.');
          mode = 'idle';
          return;
        }
        takeKey = takeBlob
          ? `blob:${takeBlob.size}:${takeBlob.type}`
          : `b64:${String(takeBase64).slice(0, 40)}`;
        if (CVWaveform?.loadOriginal && scene.referenceUrl) {
          try {
            await CVWaveform.loadOriginal(scene.referenceUrl);
          } catch (_) {}
        }
        if (CVWaveform?.loadTake) {
          try {
            await CVWaveform.loadTake({
              takeBlob,
              takeBase64,
              takeMime,
              cacheKey: takeKey,
            });
          } catch (_) {}
        }
        if (gen !== playGen) return;
        const timingOff = getCurrentTimingOffset();
        const playOpts =
          timingOff >= 0
            ? { delaySec: timingOff }
            : { offsetSec: Math.abs(timingOff) };
        pendingOverlayAudio = () => {
          if (takeBlob) CVAudio.playBlob(takeBlob, playOpts).catch(() => {});
          else CVAudio.playBase64(takeBase64, takeMime, playOpts).catch(() => {});
        };
      } catch {
        CV.showError(errorEl, 'Take fehlgeschlagen.');
        mode = 'idle';
        return;
      }
    }

    const seeked = await waitSeeked(plan.seekTo);
    if (!seeked || gen !== playGen) {
      if (recording && gen === playGen) {
        recordPrerollActive = false;
        isRecording = false;
        micBtn.classList.remove('recording');
        updateRecordButtons();
        mode = 'idle';
        segmentHint.textContent = 'Seek fehlgeschlagen — nochmal tippen.';
      }
      return;
    }

    mode = recording ? 'recording' : opts.modeName || 'preview';
    if (recording) {
      recordPrerollActive = true;
      micBtn.classList.add('recording');
      updateRecordButtons();
      if (waveHint) {
        waveHint.textContent = 'Vorlauf — grüne REC-Linie = Start deiner Aufnahme';
      }
    } else if (opts.overlay === 'original') {
      segmentHint.textContent = `Original-Clip (Video stumm) ${start.toFixed(1)}–${end.toFixed(1)}s`;
    } else if (opts.overlay === 'take') {
      segmentHint.textContent = `Dein Take (Video stumm) ${start.toFixed(1)}–${end.toFixed(1)}s`;
    } else {
      segmentHint.textContent = `Filmton ${start.toFixed(1)}–${end.toFixed(1)}s`;
    }

    if (recording) {
      try {
        await CVAudio.startRecording();
        if (gen !== playGen) {
          await CVAudio.cancelRecording();
          return;
        }
        isRecording = true;
        recorded = null;
      } catch (err) {
        recordPrerollActive = false;
        isRecording = false;
        micBtn.classList.remove('recording');
        updateRecordButtons();
        mode = 'idle';
        throw err;
      }
    }

    const prerollOrigin = performance.now();
    const prerollMs = usePreroll ? VISUAL_PREROLL_SEC * 1000 : 0;
    const cueWall = prerollOrigin + prerollMs;
    const playWall = prerollOrigin + plan.holdSec * 1000;
    const clock = { rolling: false, cueWall, start };

    if ((opts.overlay === 'take' || opts.overlay === 'original' || opts.modeName === 'preview') && !recording) {
      startWavePlayhead({
        start,
        end: start + takeDur,
        originalUrl: scene.referenceUrl || null,
        takeKey: opts.overlay === 'take' ? takeKey : null,
        getMediaTime: () => video.currentTime || clock.start,
      });
    } else if (recording) {
      // Vorlauf: Playhead bis Live-Monitor am Cue übernimmt
      startWavePlayhead({
        start,
        end: start + takeDur,
        originalUrl: scene.referenceUrl || null,
        takeKey: null,
        getMediaTime: () => {
          if (!clock.rolling && usePreroll) {
            const untilCue = Math.max(0, (clock.cueWall - performance.now()) / 1000);
            return clock.start - untilCue;
          }
          return video.currentTime || clock.start;
        },
      });
    }

    let cueStarted = false;
    let overlayStarted = false;
    let finished = false;
    let playRequested = false;

    const finish = () => {
      if (finished || gen !== playGen) return;
      finished = true;
      stopSegmentRaf();
      stopSegmentWatch();
      stopWavePlayhead();
      video.pause();
      CVAudio.stopPlayback();
      if (recording && isRecording) {
        stopRec();
      } else if (!recording) {
        mode = 'idle';
        segmentHint.textContent = `Fertig (${start.toFixed(1)}–${end.toFixed(1)}s)`;
        if (opts.overlay === 'take' || opts.overlay === 'original' || opts.modeName === 'preview') {
          refreshWaveform();
        }
      }
    };

    const fireCue = () => {
      if (cueStarted || gen !== playGen) return;
      cueStarted = true;
      const now = performance.now();
      if (recording) {
        recordPrerollActive = false;
        recordStartedAt = now;
        if (typeof CVAudio.markRecordingCue === 'function') {
          CVAudio.markRecordingCue();
        }
        opts.beginRecording().then(() => {
          if (gen !== playGen || !isRecording) return;
          segmentHint.textContent = `Aufnahme… ${start.toFixed(1)}–${end.toFixed(1)}s (Video stumm)`;
        });
      }
      if (pendingOverlayAudio && !overlayStarted) {
        overlayStarted = true;
        pendingOverlayAudio();
        if (opts.overlay === 'original') {
          segmentHint.textContent = `Original-Clip (Video stumm) ${start.toFixed(1)}–${end.toFixed(1)}s`;
        } else if (opts.overlay === 'take') {
          segmentHint.textContent = `Dein Take (Video stumm) ${start.toFixed(1)}–${end.toFixed(1)}s`;
        }
      }
    };

    const tick = () => {
      if (gen !== playGen || finished) {
        stopSegmentRaf();
        return;
      }
      const now = performance.now();
      const untilCueWall = (cueWall - now) / 1000;

      if (!playRequested && now >= playWall - 4) {
        playRequested = true;
        clock.rolling = true;
        video.play().then(() => {
          if (gen !== playGen) video.pause();
        }).catch(() => {
          if (gen !== playGen) return;
          if (recording) {
            recordPrerollActive = false;
            isRecording = false;
            CVAudio.cancelRecording();
            micBtn.classList.remove('recording');
            updateRecordButtons();
          }
          stopWavePlayhead();
          stopSegmentRaf();
          CVAudio.stopPlayback();
          segmentHint.textContent = 'Play blockiert — nochmal tippen.';
          mode = 'idle';
        });
      }

      if (!cueStarted) {
        if (untilCueWall > 0.05) {
          segmentHint.textContent = recording
            ? `Vorlauf — Einsatz in ${untilCueWall.toFixed(1)}s`
            : segmentHint.textContent;
        }
        const t = video.currentTime || 0;
        if (playRequested && t >= start) {
          fireCue();
        }
      } else if ((video.currentTime || 0) >= stopAt) {
        finish();
        return;
      }

      segmentRaf = requestAnimationFrame(tick);
    };
    segmentRaf = requestAnimationFrame(tick);

    segmentWatcher = () => {
      if (gen !== playGen || finished) return;
      if (cueStarted && (video.currentTime || 0) >= stopAt) finish();
    };
    video.addEventListener('timeupdate', segmentWatcher);
  }

  async function cueSceneFrame(scene) {
    if (!scene || !video.src) return;
    if (isRecording || recordPrerollActive) return;
    pauseSegment();
    const gen = playGen;
    video.muted = true;
    const seeked = await waitSeeked(scene.timestamp || 0);
    if (!seeked || gen !== playGen || isRecording || recordPrerollActive) return;
    if (selectedSceneId !== scene.id) return;
    video.pause();
    segmentHint.textContent = `Bereit: ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s — Original oder Filmton`;
  }

  function updateRecordButtons() {
    const scene = selectedScene();
    const hasSaved = !!(scene && state.takeStatus?.[scene.id]);
    if (btnSubmit) btnSubmit.classList.add('hidden');
    if (btnRerecord) btnRerecord.classList.add('hidden');
    btnPlayTake.disabled = !(hasSaved || savedTake || recorded);
    syncTimingControls(getCurrentTimingOffset(), {
      hasTake: !!(hasSaved || savedTake || recorded),
    });

    if (isRecording) {
      micHint.textContent = 'Aufnahme läuft — Stop oder Abschnittsende speichert automatisch';
      takeDone.textContent = '';
    } else if (hasSaved) {
      takeDone.textContent = 'Gespeichert ✓';
      micHint.textContent = '🎙️ nochmal = ersetzen · ◀ ▶ = anderer Clip · Timing verschieben';
    } else {
      takeDone.textContent = '';
      micHint.textContent = '🎙️ aufnehmen — speichert automatisch';
    }
  }

  async function autoSaveTake(draft) {
    const scene = selectedScene();
    if (!draft?.blob || !scene) return false;
    try {
      const audioBase64 = await CVAudio.blobToBase64(draft.blob);
      const timingOffsetSec = clampTimingOffsetSec(
        draft.timingOffsetSec ?? savedTake?.timingOffsetSec ?? 0
      );
      const res = await CV.emitAck(socket, 'dub:submit-take', {
        sceneId: scene.id,
        audioBase64,
        mimeType: draft.mimeType,
        durationMs: draft.durationMs,
        timingOffsetSec,
      });
      if (res.error) {
        CV.showError(errorEl, res.error);
        return false;
      }
      savedTake = {
        audioBase64,
        mimeType: draft.mimeType,
        durationMs: draft.durationMs,
        timingOffsetSec: Number.isFinite(res.timingOffsetSec)
          ? res.timingOffsetSec
          : timingOffsetSec,
      };
      recorded = null;
      exportCache = null;
      premixBuffer = null;
      premixToken += 1;
      takeDone.textContent = 'Gespeichert ✓';
      segmentHint.textContent = 'Take gespeichert — Timing ziehen oder nächster Clip';
      updateRecordButtons();
      refreshWaveform();
      renderMyScenes();
      return true;
    } catch (err) {
      CV.showError(errorEl, err.message || 'Speichern fehlgeschlagen.');
      return false;
    }
  }

  function selectScene(sceneId) {
    const scene = (state?.pack?.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return;
    if (!myCharacters().includes(scene.character)) return;
    if (isRecording || recordPrerollActive) return;

    if (selectedSceneId !== sceneId) {
      clearDraft();
      savedTake = null;
      CVAudio.stopPlayback();
    }
    selectedSceneId = sceneId;
    sceneCaption.textContent = scene.caption;
    sceneMeta.textContent = `${scene.character} · ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s`;
    captionOverlay.textContent = `${scene.character}: ${scene.caption}`;
    renderMyScenes();
    updateRecordButtons();
    cueSceneFrame(scene);
    // Measure MP3 length first so recording window matches the spoken line
    ensureReferenceDuration(scene)
      .catch(() => null)
      .finally(() => {
        if (selectedSceneId !== scene.id) return;
        if (isRecording || recordPrerollActive || (mode !== 'idle' && mode !== 'recording')) return;
        sceneMeta.textContent = `${scene.character} · ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s`;
        if (mode === 'idle') {
          segmentHint.textContent = `Bereit: ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s — Original oder Filmton`;
        }
        updateRecordButtons();
        refreshWaveform();
      });
  }

  function renderProgressBoard() {
    if (!progressClipList) return;
    const percent = state.percentDone || 0;
    const done = state.doneCount || 0;
    const total = state.totalScenes || 0;
    if (progressSummary) {
      progressSummary.textContent = `${done}/${total} · ${percent}%`;
    }
    if (progressBarFill) {
      progressBarFill.style.width = `${percent}%`;
    }
    if (progressChars) {
      progressChars.innerHTML = '';
      Object.entries(state.byCharacter || {}).forEach(([ch, info]) => {
        const pill = document.createElement('span');
        pill.className = 'progress-char-pill' + (info.done >= info.total ? ' done' : '');
        pill.textContent = `${ch} ${info.done}/${info.total}`;
        progressChars.appendChild(pill);
      });
    }
    progressClipList.innerHTML = '';
    (state.progressBoard || []).forEach((clip) => {
      const li = document.createElement('li');
      if (clip.done) li.classList.add('done');
      const check = clip.done ? '<span class="clip-check">✓</span>' : '<span class="clip-check" style="opacity:.25">○</span>';
      const who = clip.done
        ? `<span class="clip-who">${clip.playerName || '?'}</span>`
        : `<span class="clip-who">${clip.character}</span>`;
      li.innerHTML = `<span>${check}${clip.timestamp.toFixed(1)}s · ${clip.caption}</span>${who}`;
      progressClipList.appendChild(li);
    });
  }

  function me() {
    return (state?.players || []).find((p) => p.id === playerId);
  }

  function isHost() {
    return isRoomHost || (playerId && state && playerId === state.hostId);
  }

  function setCinemaStatus(text) {
    if (cinemaStatus) cinemaStatus.textContent = text || '';
  }

  let toastTimer = null;
  function showToast(message, ms = 3200) {
    if (!toastEl || !message) return;
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    // force reflow for transition
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => toastEl.classList.add('hidden'), 220);
    }, ms);
  }

  function stopCinemaCaptionWatch() {
    if (cinemaCaptionWatcher) {
      video.removeEventListener('timeupdate', cinemaCaptionWatcher);
      cinemaCaptionWatcher = null;
    }
  }

  function startCinemaCaptionWatch() {
    stopCinemaCaptionWatch();
    cinemaCaptionWatcher = () => {
      const t = video.currentTime || 0;
      const scenes = state?.pack?.scenes || [];
      let active = null;
      for (const scene of scenes) {
        if (t >= (scene.timestamp || 0) && t < sceneEnd(scene)) active = scene;
      }
      if (captionOverlay) {
        captionOverlay.textContent = active
          ? `${active.character}: ${active.caption}`
          : '';
      }
    };
    video.addEventListener('timeupdate', cinemaCaptionWatcher);
  }

  async function stopMoviePlayback() {
    stopCinemaCaptionWatch();
    if (movieCtl) {
      const ctl = movieCtl;
      movieCtl = null;
      try {
        await ctl.stop();
      } catch (_) {}
    }
  }

  async function pingServerOnce(timeoutMs = 1200) {
    const t0 = Date.now();
    const res = await Promise.race([
      CV.emitAck(socket, 'time:ping', {}),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    const t1 = Date.now();
    if (!res?.serverNow) return null;
    const rtt = Math.max(0, t1 - t0);
    return {
      offset: res.serverNow - (t0 + rtt / 2),
      rtt,
    };
  }

  async function refreshClockOffset({ samples = 5 } = {}) {
    const results = [];
    const n = Math.max(1, samples);
    for (let i = 0; i < n; i++) {
      try {
        const sample = await pingServerOnce();
        if (sample && sample.rtt < 900) results.push(sample);
      } catch (_) {}
    }
    if (!results.length) return clockOffsetMs;
    results.sort((a, b) => a.rtt - b.rtt);
    const best = results.slice(0, Math.max(1, Math.ceil(results.length / 2)));
    best.sort((a, b) => a.offset - b.offset);
    clockOffsetMs = best[Math.floor(best.length / 2)].offset;
    haveClockOffset = true;
    return clockOffsetMs;
  }

  function startClockKeepalive() {
    stopClockKeepalive();
    refreshClockOffset({ samples: 6 }).catch(() => {});
    clockPingTimer = setInterval(() => {
      refreshClockOffset({ samples: 1 }).catch(() => {});
    }, 2500);
  }

  function stopClockKeepalive() {
    if (clockPingTimer) {
      clearInterval(clockPingTimer);
      clockPingTimer = null;
    }
  }

  async function loadExportData(force) {
    if (!force && exportCache) return exportCache;
    const res = await CV.emitAck(socket, 'dub:export', {});
    if (res.error) throw new Error(res.error);
    exportCache = res.export;
    return exportCache;
  }

  async function ensurePremix() {
    if (typeof CVExport === 'undefined') return null;
    const token = ++premixToken;
    setCinemaStatus('Film wird vorbereitet…');
    try {
      await CVExport.unlockAudio();
      const data = await loadExportData(true);
      const minDuration = Number.isFinite(video.duration) ? video.duration : 0;
      const buf = await CVExport.mixExport(data, { minDuration });
      if (token !== premixToken) return premixBuffer;
      premixBuffer = buf;
      setCinemaStatus('Bereit — Film ansehen startet bei allen gleichzeitig.');
      return buf;
    } catch (err) {
      if (token === premixToken) {
        setCinemaStatus('');
        console.warn('Premix failed', err);
      }
      return null;
    }
  }

  function hideSubmitPrompt() {
    if (submitPrompt) submitPrompt.classList.add('hidden');
  }

  function showSubmitPrompt() {
    if (submitPrompt) submitPrompt.classList.remove('hidden');
  }

  function maybeOfferSubmit(next) {
    const allDone = !!next?.allDone;
    const inDubbing = next?.phase === 'dubbing';
    const premiere = next?.premiere || {};
    const iAmReady = !!me()?.premiereReady;

    if (!allDone || !inDubbing) {
      hideSubmitPrompt();
      if (!allDone) submitPromptDismissed = false;
      if (allDoneBar) allDoneBar.style.display = 'none';
      return;
    }

    if (allDoneBar) allDoneBar.style.display = '';

    if (btnSubmitFinal) {
      btnSubmitFinal.classList.toggle('hidden', iAmReady);
      btnSubmitFinal.textContent = 'Ich bin fertig';
    }
    if (btnStartPremiere) {
      const canHostStart = isHost() && !!premiere.canStart;
      btnStartPremiere.classList.toggle('hidden', !canHostStart);
    }
    if (premiereWaitHint) {
      if (!iAmReady) {
        premiereWaitHint.textContent = 'Bestätige, wenn du fertig bist — alle müssen zustimmen.';
      } else if (!premiere.allReady) {
        const waiting = (premiere.waitingFor || []).join(', ') || '…';
        premiereWaitHint.textContent = `Du bist bereit (${premiere.readyCount || 0}/${premiere.playerCount || 0}) — warte auf: ${waiting}`;
      } else if (isHost()) {
        premiereWaitHint.textContent = 'Alle bereit — Premiere starten.';
      } else {
        premiereWaitHint.textContent = 'Alle bereit — Host startet die Premiere.';
      }
    }

    // Ask every player who hasn't confirmed yet
    if (!iAmReady && !submitPromptDismissed) {
      if (submitPromptBody) {
        submitPromptBody.textContent = next.solo
          ? 'Bist du mit deinen Takes zufrieden und bereit für die Premiere?'
          : 'Bist du fertig? Die Premiere startet erst, wenn alle Spieler zustimmen.';
      }
      showSubmitPrompt();
    } else {
      hideSubmitPrompt();
    }
  }

  async function confirmPremiereReady() {
    hideSubmitPrompt();
    submitPromptDismissed = true;
    if (typeof CVExport !== 'undefined') CVExport.unlockAudio();
    const res = await CV.emitAck(socket, 'dub:premiere-ready', { ready: true });
    if (res.error) {
      CV.showError(errorEl, res.error);
      submitPromptDismissed = false;
      return;
    }
    // Solo: after self-ready, host can start immediately (same person)
    if (state?.solo && res.premiere?.allReady) {
      await startPremiere();
    }
  }

  async function startPremiere() {
    hideSubmitPrompt();
    if (typeof CVExport !== 'undefined') CVExport.unlockAudio();
    const res = await CV.emitAck(socket, 'dub:review', {});
    if (res.error) {
      CV.showError(errorEl, res.error);
    }
  }

  async function requestSyncedMoviePlay() {
    if (typeof CVExport !== 'undefined') await CVExport.unlockAudio();
    setCinemaStatus('Alle Geräte vorbereiten…');
    const res = await CV.emitAck(socket, 'dub:premiere-play', {});
    if (res.error) {
      setCinemaStatus('');
      CV.showError(errorEl, res.error);
    }
  }

  async function requestSyncedMovieStop() {
    const res = await CV.emitAck(socket, 'dub:premiere-stop', {});
    if (res.error) CV.showError(errorEl, res.error);
  }

  async function armPremiere(msg) {
    const round = msg?.round;
    if (!round || state?.phase !== 'review') return;
    premiereArmRound = round;
    await stopMoviePlayback();
    pauseSegment();
    setCinemaStatus('Geräte synchronisieren…');
    try {
      if (typeof CVExport !== 'undefined') await CVExport.unlockAudio();
      await refreshClockOffset({ samples: 6 });
      if (premiereArmRound !== round) return;
      if (!premixBuffer) await ensurePremix();
      if (premiereArmRound !== round) return;
      video.muted = true;
      video.playsInline = true;
      try {
        video.currentTime = 0;
        await video.play();
        video.pause();
        video.currentTime = 0;
      } catch (_) {}
      if (premiereArmRound !== round) return;
      socket.emit('dub:premiere-armed', { round });
      if (premiereArmRound === round && !movieCtl) {
        setCinemaStatus('Warte auf gemeinsamen Start…');
      }
    } catch (err) {
      if (premiereArmRound === round) {
        socket.emit('dub:premiere-armed', { round });
        setCinemaStatus('Bereit — Start folgt.');
        console.warn('Premiere-Arm', err);
      }
    }
  }

  async function beginSyncedMovie(msg) {
    const seq = ++premierePlaySeq;
    if (typeof CVExport === 'undefined') {
      CV.showError(errorEl, 'Export-Modul fehlt — Seite neu laden.');
      return;
    }
    await stopMoviePlayback();
    pauseSegment();
    try {
      await CVExport.unlockAudio();
      if (!premixBuffer) await ensurePremix();
      if (seq !== premierePlaySeq) return;
      if (!haveClockOffset) await refreshClockOffset({ samples: 3 });
      if (seq !== premierePlaySeq) return;
      const data = exportCache || (await loadExportData(true));
      const skew = haveClockOffset
        ? clockOffsetMs
        : Number.isFinite(msg?.serverNow)
          ? msg.serverNow - Date.now()
          : 0;

      movieCtl = await CVExport.playMixedMovie(video, data, {
        mixedBuffer: premixBuffer || undefined,
        startAtServerMs: msg.startAt,
        clockOffsetMs: skew,
        onCountdown: (leftMs) => {
          if (seq !== premierePlaySeq) return;
          const sec = Math.ceil(leftMs / 1000);
          setCinemaStatus(sec > 0 ? `Startet gleichzeitig in ${sec}…` : 'Los!');
        },
        onProgress: (p) => {
          if (seq !== premierePlaySeq) return;
          setCinemaStatus(`Spielt… ${Math.round(p * 100)}%`);
        },
        onEnded: () => {
          if (seq !== premierePlaySeq) return;
          movieCtl = null;
          stopCinemaCaptionWatch();
          setCinemaStatus('Ende — nochmal ansehen oder herunterladen.');
        },
      });
      if (seq !== premierePlaySeq) {
        await movieCtl?.stop();
        movieCtl = null;
        return;
      }
      startCinemaCaptionWatch();
    } catch (err) {
      if (seq === premierePlaySeq) {
        setCinemaStatus('');
        CV.showError(errorEl, err.message || 'Film konnte nicht gestartet werden.');
      }
    }
  }

  async function playFinalMovie() {
    await requestSyncedMoviePlay();
  }

  async function saveLocalProject({ quiet = false } = {}) {
    if (typeof CVProjects === 'undefined') {
      if (!quiet) {
        showToast('Projekt-Modul fehlt — Seite neu laden.');
        CV.showError(errorEl, 'Projekt-Modul fehlt — Seite neu laden.');
      }
      return null;
    }
    if (!quiet) setCinemaStatus('Speichere Projekt lokal…');
    try {
      const data = await loadExportData(true);
      const takeCount = Object.keys(data.takes || {}).length;
      if (!takeCount) {
        if (!quiet) {
          showToast('Keine Takes zum Speichern.');
          CV.showError(errorEl, 'Keine Takes zum Speichern.');
        }
        setCinemaStatus('');
        return null;
      }
      const existing =
        activeLocalProjectId && typeof CVProjects !== 'undefined'
          ? await CVProjects.getProject(activeLocalProjectId)
          : null;
      const id =
        activeLocalProjectId ||
        (globalThis.crypto?.randomUUID?.() || `proj-${Date.now()}`);
      const when = new Date().toLocaleString('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
      const row = await CVProjects.saveProject({
        id,
        packId: data.packId,
        title: data.title || data.packId,
        name: existing?.name || `${data.title || 'Dub'} · ${when}`,
        mode: state?.solo ? 'solo' : 'multiplayer',
        casting: data.casting || {},
        takes: data.takes || {},
        savedAt: new Date().toISOString(),
      });
      activeLocalProjectId = id;
      sessionStorage.setItem('cv_localProjectId', id);
      setCinemaStatus('');
      if (!quiet) {
        showToast(`Projekt gespeichert: „${row.name}“`);
      }
      return row;
    } catch (err) {
      setCinemaStatus('');
      if (!quiet) {
        showToast(err.message || 'Speichern fehlgeschlagen.');
        CV.showError(errorEl, err.message || 'Speichern fehlgeschlagen.');
      }
      return null;
    }
  }

  async function openLocalProject(projectId) {
    if (typeof CVProjects === 'undefined') {
      CV.showError(errorEl, 'Projekt-Modul fehlt.');
      return;
    }
    const project = await CVProjects.getProject(projectId);
    if (!project?.packId) {
      CV.showError(errorEl, 'Projekt nicht gefunden.');
      return;
    }
    joinCard.classList.add('hidden');
    gameCard.classList.remove('hidden');
    subtitle.textContent = 'Lokales Projekt wird geladen…';
    const name = (params.get('name') || 'Solo').trim() || 'Solo';
    const res = await CV.emitAck(socket, 'room:create-solo', {
      packId: project.packId,
      name,
    });
    if (res.error) {
      joinCard.classList.remove('hidden');
      gameCard.classList.add('hidden');
      CV.showError(errorEl, res.error);
      return;
    }
    playerId = res.playerId;
    isRoomHost = true;
    activeLocalProjectId = project.id;
    sessionStorage.setItem('cv_localProjectId', project.id);
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    loadMicGainForUser(name);

    const imp = await CV.emitAck(socket, 'dub:import-project', {
      takes: project.takes || {},
      phase: params.get('edit') === '1' ? 'dubbing' : 'review',
    });
    if (imp.error) {
      CV.showError(errorEl, imp.error);
      applyState(res.state);
      return;
    }
    applyState(imp.state || res.state);
    setCinemaStatus(
      params.get('edit') === '1'
        ? 'Projekt geladen — Clips bearbeiten.'
        : 'Projekt geladen — Premiere bereit.'
    );
  }

  async function downloadFinal(kind) {
    if (typeof CVExport === 'undefined') {
      CV.showError(errorEl, 'Export-Modul fehlt — Seite neu laden.');
      return;
    }
    await stopMoviePlayback();
    setCinemaStatus(kind === 'video' ? 'Rendere Video…' : 'Mische Audio…');
    try {
      const data = await loadExportData(true);
      if (kind === 'video') {
        await CVExport.exportVideoWebm(video, data, (p) => {
          setCinemaStatus(`Rendere Video… ${Math.round(p * 100)}%`);
        });
        setCinemaStatus('Video heruntergeladen.');
      } else {
        await CVExport.exportWav(data);
        setCinemaStatus('WAV heruntergeladen.');
      }
    } catch (err) {
      setCinemaStatus('');
      CV.showError(errorEl, err.message || 'Download fehlgeschlagen.');
    }
  }

  async function backToClips() {
    await stopMoviePlayback();
    const res = await CV.emitAck(socket, 'dub:edit', {});
    if (res.error) CV.showError(errorEl, res.error);
  }

  function renderCast() {
    castButtons.innerHTML = '';
    (state.pack?.characters || []).forEach((ch) => {
      const taken = state.casting?.[ch];
      const mine = taken === playerId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'btn' + (mine ? '' : taken ? ' btn-ghost' : ' btn-secondary');
      const count = (state.pack.scenes || []).filter((s) => s.character === ch).length;
      if (mine) btn.textContent = `✓ ${ch} (${count})`;
      else if (taken) btn.textContent = `${ch} (weg)`;
      else btn.textContent = `${ch} (${count})`;
      btn.disabled = !!(taken && !mine);
      btn.addEventListener('click', async () => {
        const res = await CV.emitAck(socket, 'cast:claim', { character: ch });
        if (res.error) CV.showError(errorEl, res.error);
      });
      castButtons.appendChild(btn);
    });

    playerList.innerHTML = '';
    (state.players || []).forEach((p) => {
      const li = document.createElement('li');
      const ready = p.ready
        ? '<span class="ready-tag ready-on">READY</span>'
        : '<span class="ready-tag">…</span>';
      const hostTag = p.id === state.hostId ? ' · Host' : '';
      const offline = p.connected === false ? ' · offline' : '';
      li.innerHTML = `<span>${p.name}${p.id === playerId ? ' (du)' : ''}${hostTag}${offline} · ${(p.characters || []).join(', ') || '—'}</span>${ready}`;
      if (p.connected === false) li.style.opacity = '0.55';
      playerList.appendChild(li);
    });

    const hasChar = myCharacters().length > 0;
    const amReady = !!me()?.ready;
    if (btnReady) {
      btnReady.disabled = !hasChar || amReady;
      btnReady.textContent = amReady ? 'Ready ✓' : 'Ready';
    }
    if (btnStartMp) {
      const canStart = isHost() && !!state.lobby?.canStart;
      btnStartMp.classList.toggle('hidden', !isHost());
      btnStartMp.disabled = !canStart;
    }
    if (readyHint) {
      const unassigned = state.lobby?.unassignedChars || [];
      if (!hasChar) {
        readyHint.textContent = 'Wähle einen oder mehrere Charaktere (Tippen = an/aus).';
      } else if (unassigned.length) {
        readyHint.textContent = `Noch nicht verteilt: ${unassigned.join(', ')}`;
      } else if (amReady && isHost()) {
        readyHint.textContent = state.lobby?.canStart
          ? 'Alle Charaktere verteilt & ready — Start drücken.'
          : `Warte auf andere… (${state.lobby?.waitingFor?.join(', ') || ''})`;
      } else if (amReady) {
        readyHint.textContent = 'Ready — warte auf den Host.';
      } else {
        readyHint.textContent = `Gewählt: ${myCharacters().join(', ')} — tippe Ready.`;
      }
    }

    if (hostLobbyMeta && isHost() && state.code) {
      hostLobbyMeta.classList.remove('hidden');
      if (lobbyRoomCode) lobbyRoomCode.textContent = state.code;
      if (lobbyJoinUrl) {
        lobbyJoinUrl.textContent = `${location.origin}/play.html?code=${encodeURIComponent(state.code)}`;
      }
      if (castIntro) {
        castIntro.textContent =
          'Charaktere wählen (mehrere ok) · Ready · wenn alle ready: Start';
      }
    } else if (hostLobbyMeta) {
      hostLobbyMeta.classList.add('hidden');
    }
  }

  function renderMyScenes() {
    mySceneList.innerHTML = '';
    const mine = myScenes();
    const chars = myCharacters();
    const doneMine = mine.filter((s) => state.takeStatus?.[s.id]).length;
    if (myScenesHeading) {
      myScenesHeading.textContent = chars.length === 1 ? chars[0] : 'Meine Clips';
    }
    if (myScenesCount) {
      myScenesCount.textContent = `${doneMine}/${mine.length}`;
    }
    if (mine.length === 0) {
      const li = document.createElement('li');
      li.innerHTML = '<span>Keine Clips</span>';
      mySceneList.appendChild(li);
      return;
    }
    mine.forEach((scene) => {
      const li = document.createElement('li');
      const done = state.takeStatus?.[scene.id];
      li.className = scene.id === selectedSceneId ? 'active' : '';
      if (done) li.classList.add('done');
      li.innerHTML = `<span>${done ? '<span class="clip-check">✓</span>' : ''}${scene.timestamp.toFixed(1)}s · ${scene.caption}</span>`;
      li.style.cursor = isRecording || recordPrerollActive ? 'default' : 'pointer';
      li.addEventListener('click', () => {
        if (!isRecording && !recordPrerollActive) selectScene(scene.id);
      });
      mySceneList.appendChild(li);
    });
  }

  function stepScene(delta) {
    if (isRecording || recordPrerollActive) return;
    const mine = myScenes();
    if (!mine.length) return;
    let idx = mine.findIndex((s) => s.id === selectedSceneId);
    if (idx < 0) idx = 0;
    else idx = (idx + delta + mine.length) % mine.length;
    selectScene(mine[idx].id);
  }

  function bindVideo() {
    const url = state?.pack?.videoUrl;
    if (!url || !video) return;
    // Bust cache when switching ogv→mp4
    const full = url.includes('?') ? url : `${url}?v=mp4audio`;
    if (video.dataset.src === full) return;
    video.dataset.src = full;
    videoReady = false;
    video.src = full;
    video.muted = true;
    video.playsInline = true;
    video.load();
  }

  function applyState(next) {
    const wasReview = state?.phase === 'review';
    state = next;
    isRoomHost = isRoomHost || (playerId && playerId === state.hostId);
    phasePill.textContent =
      state.phase === 'review' ? 'Premiere' : state.phase;
    subtitle.textContent = `Raum ${state.code} · ${state.pack?.title || ''}`;
    bindVideo();

    if (wasReview && state.phase !== 'review') {
      premierePlaySeq += 1;
      premiereArmRound = 0;
      stopClockKeepalive();
      stopMoviePlayback();
      exportCache = null;
      premixBuffer = null;
      premixToken += 1;
    }

    if (!wasReview && state.phase === 'review') {
      if (typeof CVExport !== 'undefined') CVExport.unlockAudio();
      startClockKeepalive();
      ensurePremix();
      // Kein Auto-Save in die Projektliste — nur manuell über „Projekt speichern“
    }

    const dubbing = state.phase === 'dubbing';
    const review = state.phase === 'review';
    const showStage = dubbing || review;
    if (pageEl) {
      pageEl.classList.toggle('page-wide', showStage);
      pageEl.classList.toggle('dubbing-wide', showStage);
    }

    castPanel.classList.add('hidden');
    if (waitPanel) waitPanel.classList.add('hidden');
    dubPanel.classList.add('hidden');
    if (cinemaBar) cinemaBar.classList.add('hidden');
    if (dubWorkArea) dubWorkArea.classList.remove('hidden');
    if (dubPanel) dubPanel.classList.remove('is-cinema');
    hideSubmitPrompt();

    if (state.phase === 'lobby' || state.phase === 'casting') {
      const amReady = !!me()?.ready;
      // Host stays in cast panel (needs Start); guests go to wait panel when ready
      if (amReady && waitPanel && !isHost()) {
        waitPanel.classList.remove('hidden');
        if (waitLobbyText) {
          const lobby = state.lobby || {};
          waitLobbyText.textContent = lobby.allReady
            ? 'Alle ready — Host kann starten.'
            : `Warte auf Host… (${lobby.readyCount || 0}/${lobby.playerCount || 0} ready)`;
        }
      } else {
        castPanel.classList.remove('hidden');
        renderCast();
      }
      statusText.textContent = amReady
        ? isHost()
          ? state.lobby?.canStart
            ? 'Alle ready — Start!'
            : 'Ready — warte auf Mitspieler'
          : 'Ready — warte auf Start'
        : myCharacters().length
          ? `Du bist ${myCharacters().join(', ')} — tippe Ready`
          : 'Charakter(e) wählen, dann Ready';
    } else if (dubbing || review) {
      dubPanel.classList.remove('hidden');
      const scenesDrawer = document.getElementById('scenesDrawer');
      if (scenesDrawer && window.matchMedia('(min-width: 960px)').matches) {
        scenesDrawer.open = true;
      }
      renderMyScenes();
      renderProgressBoard();
      const mine = myScenes();
      if (!selectedSceneId && mine[0]) selectScene(mine[0].id);
      else if (selectedSceneId) {
        const scene = selectedScene();
        if (scene) {
          sceneCaption.textContent = scene.caption;
          sceneMeta.textContent = `${scene.character} · ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s`;
        }
        updateRecordButtons();
      }
      const doneMine = mine.filter((s) => state.takeStatus?.[s.id]).length;
      const who = myCharacters().join(', ') || '?';

      if (review) {
        if (dubWorkArea) dubWorkArea.classList.add('hidden');
        if (cinemaBar) cinemaBar.classList.remove('hidden');
        if (dubPanel) dubPanel.classList.add('is-cinema');
        if (allDoneBar) allDoneBar.style.display = 'none';
        if (btnBackToClips) {
          btnBackToClips.classList.toggle('hidden', !isHost());
        }
        if (cinemaIntro) {
          cinemaIntro.textContent = state.solo
            ? 'Dein fertiger Dub — ansehen und herunterladen'
            : 'Team-Premiere: „Film ansehen“ startet bei allen gleichzeitig';
        }
        statusText.textContent = state.solo
          ? 'Premiere — Film ansehen oder laden'
          : 'Premiere — Team-Film ansehen oder laden';
        phasePill.textContent = 'Premiere';
      } else {
        statusText.textContent = state.allDone
          ? (() => {
              const prem = state.premiere || {};
              if (prem.allReady) {
                return isHost()
                  ? 'Alle bereit — Premiere starten'
                  : 'Alle bereit — Host startet Premiere';
              }
              if (me()?.premiereReady) {
                return `Bereit für Premiere (${prem.readyCount || 0}/${prem.playerCount || 0})`;
              }
              return 'Alle Clips fertig — bist du bereit für die Premiere?';
            })()
          : `${who}: ${doneMine}/${mine.length} · Team ${state.doneCount || 0}/${state.totalScenes || 0}`;
        maybeOfferSubmit(state);
      }
    }

    CV.showError(errorEl, '');
  }

  async function joinRoom(code, name) {
    const res = await CV.emitAck(socket, 'room:join', { code, name });
    if (res.error) {
      CV.showError(errorEl, res.error);
      return false;
    }
    playerId = res.playerId;
    isRoomHost = res.state?.hostId === playerId;
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    loadMicGainForUser(name);
    joinCard.classList.add('hidden');
    gameCard.classList.remove('hidden');
    applyState(res.state);
    return true;
  }

  async function tryReconnect() {
    if (params.get('solo') === '1' || params.get('mp') === '1' || params.get('project')) {
      return false;
    }
    const code = sessionStorage.getItem('cv_roomCode');
    const pid = sessionStorage.getItem('cv_playerId');
    if (!code || !pid) return false;
    const res = await CV.emitAck(socket, 'room:reconnect', {
      code,
      playerId: pid,
    });
    if (res.error) return false;
    playerId = res.playerId;
    isRoomHost = !!res.isHost || res.state?.hostId === playerId;
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    const reconnectName =
      (res.state?.players || []).find((p) => p.id === playerId)?.name || nameInput.value;
    loadMicGainForUser(reconnectName);
    joinCard.classList.add('hidden');
    gameCard.classList.remove('hidden');
    applyState(res.state);
    return true;
  }

  
  async function startPartySession(partyId, memberId) {
    const packId = params.get('pack');
    const name = (params.get('name') || '').trim();
    if (!partyId) {
      CV.showError(errorEl, 'Party-ID fehlt.');
      return;
    }
    if (!name) {
      CV.showError(errorEl, 'Name nötig — über die Hub-Party starten.');
      return;
    }
    activeLocalProjectId = null;
    sessionStorage.removeItem('cv_localProjectId');
    joinCard.classList.add('hidden');
    gameCard.classList.remove('hidden');
    subtitle.textContent = `Party ${partyId}…`;
    const res = await CV.emitAck(socket, 'session:join-party', {
      partyId,
      memberId: memberId || undefined,
      name,
      packId: packId || undefined,
    });
    if (res.error) {
      joinCard.classList.remove('hidden');
      gameCard.classList.add('hidden');
      CV.showError(errorEl, res.error);
      return;
    }
    playerId = res.playerId;
    isRoomHost = !!res.isHost || res.state?.hostId === playerId;
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    sessionStorage.setItem('cv_partyId', partyId);
    loadMicGainForUser(name);
    applyState(res.state);
    if (btnReturnLobby) btnReturnLobby.classList.remove('hidden');
  }

async function startMultiplayer() {
    const packId = params.get('pack');
    const name = (params.get('name') || '').trim();
    if (!packId || !name) {
      CV.showError(errorEl, 'Name und Pack nötig. Zurück zum Dashboard.');
      return;
    }
    activeLocalProjectId = null;
    sessionStorage.removeItem('cv_localProjectId');
    joinCard.classList.add('hidden');
    gameCard.classList.remove('hidden');
    const res = await CV.emitAck(socket, 'room:create-multiplayer', { packId, name });
    if (res.error) {
      joinCard.classList.remove('hidden');
      gameCard.classList.add('hidden');
      CV.showError(errorEl, res.error);
      return;
    }
    playerId = res.playerId;
    isRoomHost = true;
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    loadMicGainForUser(name);
    applyState(res.state);
  }

  async function startSolo() {
    const packId = params.get('pack');
    if (!packId) {
      CV.showError(errorEl, 'Kein Pack gewählt. Zurück zum Dashboard.');
      return;
    }
    activeLocalProjectId = null;
    sessionStorage.removeItem('cv_localProjectId');
    const name = (params.get('name') || nameInput.value || 'Solo').trim() || 'Solo';
    joinCard.classList.add('hidden');
    gameCard.classList.remove('hidden');
    subtitle.textContent = 'Solo — alle Charaktere';
    const res = await CV.emitAck(socket, 'room:create-solo', { packId, name });
    if (res.error) {
      joinCard.classList.remove('hidden');
      gameCard.classList.add('hidden');
      CV.showError(errorEl, res.error);
      return;
    }
    playerId = res.playerId;
    isRoomHost = true;
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    loadMicGainForUser(name);
    applyState(res.state);
  }

  btnJoin.addEventListener('click', async () => {
    const code = codeInput.value.trim().toUpperCase();
    const name = nameInput.value.trim();
    if (!code || !name) {
      CV.showError(errorEl, 'Code und Name nötig.');
      return;
    }
    await joinRoom(code, name);
  });

  if (btnReady) {
    btnReady.addEventListener('click', async () => {
      const res = await CV.emitAck(socket, 'lobby:ready', { ready: true });
      if (res.error) CV.showError(errorEl, res.error);
    });
  }
  if (btnUnready) {
    btnUnready.addEventListener('click', async () => {
      const res = await CV.emitAck(socket, 'lobby:ready', { ready: false });
      if (res.error) CV.showError(errorEl, res.error);
    });
  }
  if (btnStartMp) {
    btnStartMp.addEventListener('click', async () => {
      const res = await CV.emitAck(socket, 'dub:start', {});
      if (res.error) CV.showError(errorEl, res.error);
    });
  }
  if (btnPrevScene) {
    btnPrevScene.addEventListener('click', () => stepScene(-1));
  }
  if (btnNextScene) {
    btnNextScene.addEventListener('click', () => stepScene(1));
  }

  btnPlaySeg.addEventListener('click', async () => {
    if (!selectedScene()) {
      CV.showError(errorEl, 'Bitte eine deiner Szenen wählen.');
      return;
    }
    if (isRecording || recordPrerollActive) return;
    await playSegmentOnly({ forRecording: false });
  });

  if (btnPauseSeg) {
    btnPauseSeg.addEventListener('click', async () => {
      // Pause im Editor absichtlich deaktiviert
    });
  }

  btnRef.addEventListener('click', async () => {
    if (!selectedScene()) {
      CV.showError(errorEl, 'Bitte eine Szene wählen.');
      return;
    }
    if (isRecording || recordPrerollActive) return;
    if (!selectedScene()?.referenceUrl) {
      CV.showError(errorEl, 'Kein Original vorhanden.');
      return;
    }
    await playSegmentSynced({
      modeName: 'original',
      videoMuted: true,
      overlay: 'original',
    });
  });

  btnPlayTake.addEventListener('click', async () => {
    if (!selectedScene()) return;
    if (isRecording || recordPrerollActive) return;
    await playSegmentSynced({
      modeName: 'take',
      videoMuted: true,
      overlay: 'take',
    });
  });

  async function startRec() {
    const scene = selectedScene();
    if (!scene) {
      CV.showError(errorEl, 'Bitte zuerst eine deiner Szenen wählen.');
      return;
    }
    if (isRecording || recordPrerollActive) return;
    recordPrerollActive = true;
    try {
      CVAudio.stopPlayback();
      await CVAudio.ensureMic();
      if (typeof CVAudio.prepareRecordContext === 'function') {
        await CVAudio.prepareRecordContext();
      }

      // Measure spoken line length so recording stops with the text, not a silent gap
      await ensureReferenceDuration(scene);
      sceneMeta.textContent = `${scene.character} · ${scene.timestamp.toFixed(1)}–${sceneEnd(scene).toFixed(1)}s`;

      // Preload original so live overlay can compare immediately
      if (scene.referenceUrl && CVWaveform?.loadOriginal) {
        try {
          await CVWaveform.loadOriginal(scene.referenceUrl);
        } catch (_) {}
      }

      await playSegmentOnly({
        forRecording: true,
        beginRecording: async () => {
          if (waveHint) {
            waveHint.textContent = 'LIVE — Grün = REC-Start · Violett = deine Stimme · Rosa = Original';
          }

          const windowSec = sceneTakeDurationSec(scene);
          const expectedMs = Math.max(800, windowSec * 1000);
          clearRecordExactTimer();
          recordExactTimer = setTimeout(() => {
            if (isRecording && !recordPrerollActive) stopRec();
          }, Math.round(windowSec * 1000 + 80));

          stopWavePlayhead();
          await CVAudio.startLiveMonitor((peaks, elapsedMs) => {
            if (!isRecording || !waveCanvas || !CVWaveform?.drawLive) return;
            const lead = WAVE_COMPARE_LEAD_SEC;
            const speechSec = Math.max(0.15, sceneEnd(scene) - (scene.timestamp || 0));
            const timelineSec = lead + speechSec;
            const origin = (scene.timestamp || 0) - lead;
            const t = video.currentTime || scene.timestamp || 0;
            const progress = Math.max(0, Math.min(1.05, (t - origin) / timelineSec));
            CVWaveform.drawLive(waveCanvas, {
              originalUrl: scene.referenceUrl || null,
              livePeaks: peaks,
              elapsedMs,
              expectedMs,
              timelineSec,
              audioOffsetSec: lead,
              cueMarkerSec: lead,
              recordingActive: true,
              progress,
              playhead: progress,
            });
          });
        },
      });
    } catch {
      recordPrerollActive = false;
      isRecording = false;
      CVAudio.stopLiveMonitor?.();
      CVAudio.cancelRecording?.();
      micBtn.classList.remove('recording');
      updateRecordButtons();
      CV.showError(errorEl, 'Mikrofon-Zugriff fehlgeschlagen (HTTPS/localhost).');
    }
  }

  async function cancelRec() {
    bumpPlayGen();
    recordPrerollActive = false;
    isRecording = false;
    clearRecordExactTimer();
    stopSegmentWatch();
    stopSegmentRaf();
    stopWavePlayhead();
    video.pause();
    CVAudio.stopPlayback();
    try {
      await CVAudio.cancelRecording();
    } catch (_) {}
    micBtn.classList.remove('recording');
    mode = 'idle';
    updateRecordButtons();
    segmentHint.textContent = 'Abgebrochen';
    refreshWaveform();
  }

  async function stopRec() {
    if (!isRecording && !recordPrerollActive) return;
    if (recordPrerollActive && isRecording) {
      await cancelRec();
      return;
    }
    if (!isRecording) {
      await cancelRec();
      return;
    }
    bumpPlayGen();
    recordPrerollActive = false;
    isRecording = false;
    clearRecordExactTimer();
    stopSegmentWatch();
    stopSegmentRaf();
    stopWavePlayhead();
    video.pause();
    CVAudio.stopPlayback();
    const scene = selectedScene();
    const targetDurationSec = scene ? sceneTakeDurationSec(scene) : null;
    try {
      const result = await CVAudio.stopRecording({
        referenceUrl: scene?.referenceUrl || null,
        targetDurationSec,
      });
      const durationMs = Number.isFinite(result.durationSec)
        ? Math.round(result.durationSec * 1000)
        : Math.round(performance.now() - recordStartedAt);
      // Neue Aufnahme: Timing-Offset zurücksetzen (Feintuning danach)
      const draft = { ...result, durationMs, timingOffsetSec: 0 };
      recorded = draft;
      mode = 'idle';
      micBtn.classList.remove('recording');
      segmentHint.textContent = 'Speichere Take…';
      updateRecordButtons();
      await autoSaveTake(draft);
    } catch (err) {
      CVAudio.stopLiveMonitor?.();
      micBtn.classList.remove('recording');
      updateRecordButtons();
      CV.showError(errorEl, err.message || 'Aufnahme fehlgeschlagen.');
    }
  }

  micBtn.addEventListener('click', async () => {
    if (state?.phase !== 'dubbing') return;
    if (!selectedScene()) return;
    if (recordPrerollActive) {
      await cancelRec();
      return;
    }
    if (!isRecording) await startRec();
    else await stopRec();
  });

  // Legacy buttons kept hidden — no separate save/rerecord flow
  if (btnRerecord) {
    btnRerecord.addEventListener('click', async () => {
      if (isRecording) await stopRec();
      else await startRec();
    });
  }
  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      if (recorded) await autoSaveTake(recorded);
    });
  }

  if (btnConfirmSubmit) {
    btnConfirmSubmit.addEventListener('click', () => confirmPremiereReady());
  }
  if (btnDismissSubmit) {
    btnDismissSubmit.addEventListener('click', () => {
      submitPromptDismissed = true;
      hideSubmitPrompt();
    });
  }
  if (btnSubmitFinal) {
    btnSubmitFinal.addEventListener('click', () => {
      submitPromptDismissed = false;
      confirmPremiereReady();
    });
  }
  if (btnStartPremiere) {
    btnStartPremiere.addEventListener('click', () => startPremiere());
  }
  if (btnPlayMovie) {
    btnPlayMovie.addEventListener('click', () => playFinalMovie());
  }
  if (btnStopMovie) {
    btnStopMovie.addEventListener('click', () => requestSyncedMovieStop());
  }
  if (btnDownloadVideo) {
    btnDownloadVideo.addEventListener('click', () => downloadFinal('video'));
  }
  // WAV-Download entfernt
  if (btnSaveProject) {
    btnSaveProject.addEventListener('click', () => saveLocalProject({ quiet: false }));
  }
  if (btnBackToClips) {
    btnBackToClips.addEventListener('click', () => backToClips());
  }

  
  socket.on('session:returned', () => {
    location.href = '/';
  });

socket.on('state:update', (next) => {
    if (!playerId) return;
    applyState(next);
  });

  socket.on('dub:premiere-arm', (msg) => {
    if (!playerId || state?.phase !== 'review') return;
    armPremiere(msg || {});
  });

  socket.on('dub:premiere-play', (msg) => {
    if (!playerId || state?.phase !== 'review') return;
    beginSyncedMovie(msg || {});
  });

  socket.on('dub:premiere-stop', async () => {
    if (!playerId) return;
    premierePlaySeq += 1;
    premiereArmRound = 0;
    await stopMoviePlayback();
    setCinemaStatus('Pausiert.');
  });

  socket.on('dub:take-ready', ({ sceneId, audioBase64, mimeType, timingOffsetSec }) => {
    if (sceneId === selectedSceneId) {
      savedTake = {
        audioBase64,
        mimeType,
        timingOffsetSec: clampTimingOffsetSec(timingOffsetSec),
      };
      updateRecordButtons();
      refreshWaveform();
    }
    renderMyScenes();
  });

  function timingPxToSec(dxPx) {
    const scene = selectedScene();
    if (!scene || !waveCanvas) return 0;
    const speechSec = Math.max(0.4, sceneEnd(scene) - (scene.timestamp || 0));
    const timelineSec = speechSec + WAVE_COMPARE_LEAD_SEC;
    const w = waveCanvas.clientWidth || 1;
    return (dxPx / w) * timelineSec;
  }

  function onTimingPointerDown(e) {
    if (!waveCanvas || isRecording || recordPrerollActive) return;
    if (!(recorded || savedTake || state?.takeStatus?.[selectedSceneId])) return;
    e.preventDefault();
    waveCanvas.setPointerCapture?.(e.pointerId);
    timingDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      origin: getCurrentTimingOffset(),
    };
    waveCanvas.classList.add('is-dragging');
  }

  function onTimingPointerMove(e) {
    if (!timingDrag || e.pointerId !== timingDrag.pointerId) return;
    const next = clampTimingOffsetSec(timingDrag.origin + timingPxToSec(e.clientX - timingDrag.startX));
    applyTimingOffsetLocal(next, { persist: false });
  }

  function onTimingPointerUp(e) {
    if (!timingDrag || e.pointerId !== timingDrag.pointerId) return;
    const next = clampTimingOffsetSec(timingDrag.origin + timingPxToSec(e.clientX - timingDrag.startX));
    timingDrag = null;
    waveCanvas?.classList.remove('is-dragging');
    applyTimingOffsetLocal(next, { persist: true });
  }

  if (waveCanvas) {
    waveCanvas.addEventListener('pointerdown', onTimingPointerDown);
    waveCanvas.addEventListener('pointermove', onTimingPointerMove);
    waveCanvas.addEventListener('pointerup', onTimingPointerUp);
    waveCanvas.addEventListener('pointercancel', onTimingPointerUp);
  }

  if (timingOffsetEl) {
    timingOffsetEl.addEventListener('input', () => {
      const ms = Number(timingOffsetEl.value) || 0;
      applyTimingOffsetLocal(ms / 1000, { persist: false });
    });
    timingOffsetEl.addEventListener('change', () => {
      const ms = Number(timingOffsetEl.value) || 0;
      applyTimingOffsetLocal(ms / 1000, { persist: true });
    });
  }
  if (btnTimingMinus) {
    btnTimingMinus.addEventListener('click', () => {
      applyTimingOffsetLocal(getCurrentTimingOffset() - 0.01, { persist: true });
    });
  }
  if (btnTimingPlus) {
    btnTimingPlus.addEventListener('click', () => {
      applyTimingOffsetLocal(getCurrentTimingOffset() + 0.01, { persist: true });
    });
  }
  if (btnTimingReset) {
    btnTimingReset.addEventListener('click', () => {
      applyTimingOffsetLocal(0, { persist: true });
    });
  }

  if (btnReturnLobby) {
    btnReturnLobby.addEventListener('click', async () => {
      const res = await CV.emitAck(socket, 'session:return-to-lobby', {});
      if (res.error) {
        CV.showError(errorEl, res.error);
        return;
      }
      location.href = '/';
    });
  }

  window.addEventListener('resize', () => {
    if (selectedSceneId) refreshWaveform();
  });

  // Party context from hub launch URL
  const partyId = (params.get('party') || '').toUpperCase();
  const partyMemberId = params.get('member') || '';

  if (partyId && params.get('solo') === '1') {
    CV.showError(errorEl, 'In einer Party ist Solo gesperrt.');
  } else if (params.get('project')) {
    if (partyId) {
      CV.showError(errorEl, 'Projekte sind in der Party gesperrt — nur Multiplayer-Session.');
    } else {
      openLocalProject(params.get('project'));
    }
  } else if (partyId) {
    startPartySession(partyId, partyMemberId);
  } else if (params.get('solo') === '1') {
    startSolo();
  } else {
    tryReconnect().then((ok) => {
      if (!ok) {
        CV.showError(
          errorEl,
          'Kein Solo- und kein Party-Kontext. Starte Solo vom Dashboard oder tritt einer Hub-Party bei.'
        );
      }
    });
  }
})();
