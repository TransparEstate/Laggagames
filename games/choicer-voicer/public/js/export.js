(function (global) {
  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function decodeAudio(ctx, base64, mimeType) {
    const buffer = base64ToArrayBuffer(base64);
    // Some browsers need a copy
    const copy = buffer.slice(0);
    try {
      return await ctx.decodeAudioData(copy);
    } catch (err) {
      console.warn('decode failed', mimeType, err);
      throw err;
    }
  }

  async function fetchAudioBuffer(ctx, url) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return ctx.decodeAudioData(arr);
  }

  /**
   * Peak of an AudioBuffer (max abs sample across channels).
   */
  function measurePeak(buffer) {
    if (global.CVAudio?.measurePeak) return global.CVAudio.measurePeak(buffer);
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  /** Gain toward original loudness (or mild peak fallback). */
  function takeMixGain(takeBuffer, refBuffer) {
    if (global.CVAudio?.computeMatchGain) {
      return global.CVAudio.computeMatchGain(takeBuffer, refBuffer, {
        matchStrength: 0.65,
        maxPeak: 0.93,
        minGain: 0.5,
        maxGain: 4,
      }).gain;
    }
    const peak = measurePeak(takeBuffer);
    if (peak < 0.0008) return 1;
    return Math.min(6, Math.max(1, 0.85 / peak));
  }

  /**
   * Mix backing track + takes at scene timestamps into one AudioBuffer.
   * Takes are matched toward each scene's original loudness; backing is ducked.
   * opts.minDuration — pad to at least this many seconds (e.g. video length).
   */
  async function mixExport(exportData, opts = {}) {
    const BACKING_GAIN = 0.4;
    const BACKING_DUCK = 0.18;
    const EDGE_FADE_SEC = 0.028;
    const CROSSFADE_SEC = 0.035;
    const TIMING_OFFSET_MAX = 0.6;

    const clampOffset = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      return Math.max(-TIMING_OFFSET_MAX, Math.min(TIMING_OFFSET_MAX, n));
    };

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = ctx.sampleRate;

    let backing = null;
    let durationSec = Math.max(1, Number(opts.minDuration) || 0);
    if (exportData.backingTrackUrl) {
      try {
        backing = await fetchAudioBuffer(ctx, exportData.backingTrackUrl);
        durationSec = Math.max(durationSec, backing.duration);
      } catch (err) {
        console.warn('Backing track load failed', err);
      }
    }

    const decodedTakes = [];
    for (const scene of exportData.scenes || []) {
      const take = exportData.takes?.[scene.id];
      if (!take?.audioBase64) continue;
      try {
        const buf = await decodeAudio(ctx, take.audioBase64, take.mimeType);
        let refBuffer = null;
        if (scene.referenceUrl) {
          try {
            refBuffer = await fetchAudioBuffer(ctx, scene.referenceUrl);
          } catch (_) {}
        }
        const timingOffsetSec = clampOffset(take.timingOffsetSec);
        const t0 = Math.max(0, (scene.timestamp || 0) + timingOffsetSec);
        decodedTakes.push({
          timestamp: t0,
          buffer: buf,
          refBuffer,
          timingOffsetSec,
        });
        durationSec = Math.max(durationSec, t0 + buf.duration + 0.5);
      } catch (err) {
        console.warn('Skip take', scene.id, err);
      }
    }
    if (durationSec < 1) durationSec = 90;

    decodedTakes.sort((a, b) => a.timestamp - b.timestamp);

    const length = Math.ceil(durationSec * sampleRate);
    const offline = new OfflineAudioContext(2, length, sampleRate);

    if (backing) {
      const src = offline.createBufferSource();
      src.buffer = backing;
      const g = offline.createGain();
      g.gain.value = BACKING_GAIN;
      src.connect(g);
      g.connect(offline.destination);
      src.start(0);

      for (const item of decodedTakes) {
        const t0 = Math.max(0, item.timestamp);
        const t1 = t0 + Math.max(0.2, item.buffer.duration);
        const fadeIn = Math.max(0, t0 - 0.06);
        try {
          g.gain.setValueAtTime(BACKING_GAIN, fadeIn);
          g.gain.linearRampToValueAtTime(BACKING_DUCK, t0 + 0.05);
          g.gain.setValueAtTime(BACKING_DUCK, t1);
          g.gain.linearRampToValueAtTime(BACKING_GAIN, t1 + 0.18);
        } catch (_) {
          /* overlapping automation — still better than unity mix */
        }
      }
    }

    for (let i = 0; i < decodedTakes.length; i++) {
      const item = decodedTakes[i];
      const src = offline.createBufferSource();
      src.buffer = item.buffer;
      const g = offline.createGain();
      const peakGain = takeMixGain(item.buffer, item.refBuffer);
      const t0 = Math.max(0, item.timestamp);
      const dur = Math.max(0.05, item.buffer.duration);
      let t1 = t0 + dur;

      // Soft crossfade when this take overlaps the next
      const next = decodedTakes[i + 1];
      let releaseSec = EDGE_FADE_SEC;
      if (next) {
        const overlap = t1 - next.timestamp;
        if (overlap > 0.008) {
          const xf = Math.min(CROSSFADE_SEC, Math.max(EDGE_FADE_SEC, overlap * 0.85));
          t1 = Math.max(t0 + EDGE_FADE_SEC * 2, next.timestamp + xf);
          releaseSec = Math.min(xf, Math.max(EDGE_FADE_SEC, t1 - next.timestamp));
        }
      }

      const attack = Math.min(EDGE_FADE_SEC, dur * 0.22);
      const release = Math.min(releaseSec, Math.max(0.012, (t1 - t0) * 0.35));
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peakGain, t0 + attack);
      g.gain.setValueAtTime(peakGain, Math.max(t0 + attack, t1 - release));
      g.gain.linearRampToValueAtTime(0.0001, t1);
      src.connect(g);
      g.connect(offline.destination);
      src.start(t0);
    }

    const rendered = await offline.startRendering();
    await ctx.close();
    return rendered;
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    const samples = buffer.length;
    const blockAlign = (numChannels * bitDepth) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    const channels = [];
    for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));
    for (let i = 0; i < samples; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportWav(exportData, filename) {
    const mixed = await mixExport(exportData);
    const wav = audioBufferToWav(mixed);
    downloadBlob(wav, filename || `${exportData.title || 'dub'}.wav`);
    return wav;
  }

  async function exportProjectJson(exportData, filename) {
    // Lightweight timeline without huge audio for sharing structure;
    // full export keeps audio in a second file set.
    const slim = {
      title: exportData.title,
      packId: exportData.packId,
      videoUrl: exportData.videoUrl,
      backingTrackUrl: exportData.backingTrackUrl,
      scenes: exportData.scenes,
      casting: exportData.casting,
      takes: Object.fromEntries(
        Object.entries(exportData.takes || {}).map(([id, t]) => [
          id,
          {
            playerName: t.playerName,
            mimeType: t.mimeType,
            durationMs: t.durationMs,
            timingOffsetSec: Number(t.timingOffsetSec) || 0,
            audioBase64: t.audioBase64,
          },
        ])
      ),
      exportedAt: exportData.exportedAt,
    };
    const blob = new Blob([JSON.stringify(slim)], { type: 'application/json' });
    downloadBlob(blob, filename || `${exportData.title || 'dub'}-project.json`);
    return blob;
  }

  let unlockedCtx = null;

  /** Call from a user gesture so later socket-triggered playback can make sound. */
  async function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!unlockedCtx || unlockedCtx.state === 'closed') {
      unlockedCtx = new AC();
    }
    if (unlockedCtx.state === 'suspended') {
      try {
        await unlockedCtx.resume();
      } catch (_) {}
    }
    return unlockedCtx;
  }

  function waitVideoSeeked(videoEl, timeSec) {
    const t = Math.max(0, Number(timeSec) || 0);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        videoEl.removeEventListener('seeked', finish);
        resolve();
      };
      if (videoEl.readyState >= 2 && Math.abs((videoEl.currentTime || 0) - t) < 0.05) {
        finish();
        return;
      }
      videoEl.addEventListener('seeked', finish);
      try {
        videoEl.currentTime = t;
      } catch (_) {
        finish();
        return;
      }
      setTimeout(finish, 700);
    });
  }

  /**
   * Play muted video synced with mixed dub audio.
   * opts.startAtServerMs + opts.clockOffsetMs → simultaneous start across clients
   *   (localStart = startAtServerMs - clockOffsetMs; clockOffset ≈ serverNow - localNow)
   * AudioContext is the master clock; video is rate-corrected onto it.
   */
  async function playMixedMovie(videoEl, exportData, {
    onProgress,
    onEnded,
    onCountdown,
    startAtServerMs,
    clockOffsetMs = 0,
    mixedBuffer,
  } = {}) {
    if (!videoEl) throw new Error('Kein Video.');
    const minDuration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    const mixed = mixedBuffer || (await mixExport(exportData, { minDuration }));

    const actx = (await unlockAudio()) || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') await actx.resume();

    const src = actx.createBufferSource();
    src.buffer = mixed;
    src.connect(actx.destination);

    let stopped = false;
    let raf = null;
    let waitTimer = null;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (waitTimer) clearTimeout(waitTimer);
      try {
        videoEl.playbackRate = 1;
      } catch (_) {}
      try {
        src.stop();
      } catch (_) {}
      try {
        videoEl.pause();
      } catch (_) {}
      try {
        src.disconnect();
      } catch (_) {}
    };

    videoEl.muted = true;
    videoEl.playsInline = true;
    await new Promise((resolve) => {
      if (videoEl.readyState >= 1) resolve();
      else videoEl.addEventListener('loadedmetadata', resolve, { once: true });
    });

    const localStartAt =
      Number.isFinite(startAtServerMs)
        ? startAtServerMs - (Number(clockOffsetMs) || 0)
        : Date.now() + 280;
    const localStartPerf = performance.now() + (localStartAt - Date.now());

    await waitVideoSeeked(videoEl, 0);
    if (stopped) return { stop, duration: mixed.duration };

    // Decoder warm-up so play() at T0 isn't a cold start
    if (localStartPerf - performance.now() > 450) {
      try {
        await videoEl.play();
        videoEl.pause();
        await waitVideoSeeked(videoEl, 0);
      } catch (_) {}
    }
    if (stopped) return { stop, duration: mixed.duration };

    await new Promise((resolve) => {
      const tick = () => {
        if (stopped) {
          resolve();
          return;
        }
        const left = localStartPerf - performance.now();
        if (onCountdown) onCountdown(Math.max(0, left));
        if (left <= 70) {
          resolve();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    });
    raf = null;
    if (stopped) return { stop, duration: mixed.duration };

    const remainingMs = localStartPerf - performance.now();
    const remainingSec = remainingMs / 1000;
    let audioOffset = 0;
    let audioWhen = actx.currentTime + 0.012;
    if (remainingSec > 0.012) {
      audioWhen = actx.currentTime + remainingSec;
      audioOffset = 0;
    } else {
      audioOffset = Math.min(Math.max(0, -remainingSec), Math.max(0, mixed.duration - 0.05));
    }

    try {
      src.start(audioWhen, audioOffset);
    } catch (err) {
      await stop();
      throw err;
    }

    const kickVideo = () => {
      if (stopped) return;
      try {
        if (audioOffset > 0.03) videoEl.currentTime = audioOffset;
      } catch (_) {}
      videoEl.play().catch(() => {});
    };
    if (remainingMs > 24) {
      waitTimer = setTimeout(kickVideo, Math.max(0, remainingMs - 10));
    } else {
      kickVideo();
    }

    const audioStartCtx = audioWhen;
    const durationMs = mixed.duration * 1000;
    const syncVideo = () => {
      if (stopped) return;
      const elapsed = actx.currentTime - audioStartCtx;
      const expected = audioOffset + Math.max(0, elapsed);
      if (expected >= mixed.duration - 0.03) {
        stop().then(() => onEnded && onEnded());
        return;
      }
      const vt = videoEl.currentTime || 0;
      const drift = vt - expected;
      if (videoEl.paused) videoEl.play().catch(() => {});
      if (Math.abs(drift) > 0.22) {
        try {
          videoEl.currentTime = Math.max(0, expected);
        } catch (_) {}
        try {
          videoEl.playbackRate = 1;
        } catch (_) {}
      } else if (Math.abs(drift) > 0.035) {
        try {
          videoEl.playbackRate = Math.max(0.94, Math.min(1.06, 1 - drift * 0.7));
        } catch (_) {}
      } else if (videoEl.playbackRate !== 1) {
        try {
          videoEl.playbackRate = 1;
        } catch (_) {}
      }
      if (onProgress) onProgress(Math.min(1, (expected * 1000) / durationMs));
      raf = requestAnimationFrame(syncVideo);
    };
    raf = requestAnimationFrame(syncVideo);

    src.onended = () => {
      if (!stopped) stop().then(() => onEnded && onEnded());
    };
    return { stop, duration: mixed.duration, lateSec: audioOffset };
  }

  /** Record muted video + mixed audio into a downloadable WebM (no audible preview). */
  async function exportVideoWebm(videoEl, exportData, onProgress) {
    const mixed = await mixExport(exportData, {
      minDuration: Number.isFinite(videoEl?.duration) ? videoEl.duration : 0,
    });
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = actx.createMediaStreamDestination();
    const src = actx.createBufferSource();
    src.buffer = mixed;
    // Nur in den Recorder — nicht an Lautsprecher (sonst „spielt nochmal ab“)
    src.connect(dest);

    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx2d = canvas.getContext('2d');
    const canvasStream = canvas.captureStream(30);

    const combined = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    const chunks = [];
    const recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 2500000 });
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };

    const done = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
      recorder.onerror = () => reject(new Error('Video-Export fehlgeschlagen.'));
    });

    const prevTime = videoEl.currentTime || 0;
    videoEl.muted = true;
    videoEl.currentTime = 0;
    await videoEl.play();
    src.start(0);
    recorder.start(200);

    const duration = mixed.duration;
    const start = performance.now();
    let raf;
    const draw = () => {
      if (!videoEl.paused && !videoEl.ended) {
        ctx2d.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      }
      if (onProgress) onProgress(Math.min(1, (performance.now() - start) / (duration * 1000)));
      raf = requestAnimationFrame(draw);
    };
    draw();

    await new Promise((resolve) => {
      const t = setTimeout(resolve, duration * 1000 + 400);
      videoEl.onended = () => {
        clearTimeout(t);
        resolve();
      };
    });

    cancelAnimationFrame(raf);
    recorder.stop();
    videoEl.pause();
    try {
      videoEl.currentTime = prevTime;
    } catch (_) {}
    try {
      src.stop();
    } catch (_) {}
    await actx.close();
    const blob = await done;
    downloadBlob(blob, `${exportData.title || 'dub'}.webm`);
    return blob;
  }

  global.CVExport = {
    mixExport,
    playMixedMovie,
    unlockAudio,
    exportWav,
    exportProjectJson,
    exportVideoWebm,
    downloadBlob,
  };
})(window);
