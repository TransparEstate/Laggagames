(function (global) {
  let audioCtx = null;

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  async function decodeUrl(url) {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return getCtx().decodeAudioData(buf.slice(0));
  }

  async function decodeBlob(blob) {
    const buf = await blob.arrayBuffer();
    return getCtx().decodeAudioData(buf.slice(0));
  }

  async function decodeBase64(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType || 'audio/webm' });
    return decodeBlob(blob);
  }

  /** Downsample to peaks for drawing (min/max per bucket). */
  function peaksFromBuffer(audioBuffer, buckets) {
    const data = audioBuffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / buckets));
    const peaks = new Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let min = 0;
      let max = 0;
      const start = i * block;
      const end = Math.min(data.length, start + block);
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[i] = { min, max };
    }
    return peaks;
  }

  /**
   * Peaks aligned to a shared timeline (seconds). Shorter audio only fills its span;
   * optional offsetSec leaves empty lead-in (or shifts earlier when negative).
   */
  function peaksOnTimeline(audioBuffer, buckets, timelineSec, offsetSec = 0) {
    if (!audioBuffer || !buckets) return null;
    const timeline = Math.max(0.2, Number(timelineSec) || audioBuffer.duration || 0.2);
    const offset = Number(offsetSec) || 0;
    const offsetBuckets = Math.round((offset / timeline) * buckets);
    const usedBuckets = Math.max(
      1,
      Math.min(buckets, Math.round((audioBuffer.duration / timeline) * buckets))
    );
    const partial = peaksFromBuffer(audioBuffer, usedBuckets);
    const peaks = new Array(buckets);
    for (let i = 0; i < buckets; i++) {
      const j = i - offsetBuckets;
      peaks[i] = j >= 0 && j < usedBuckets ? partial[j] : { min: 0, max: 0 };
    }
    return peaks;
  }

  function drawWavePath(ctx, peaks, midY, amp, mirror) {
    const n = peaks.length;
    if (!n) return;
    const w = ctx.canvas.width / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * w + w / 2;
      const y = midY - peaks[i].max * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (mirror) {
      for (let i = n - 1; i >= 0; i--) {
        const x = i * w + w / 2;
        const y = midY - peaks[i].min * amp;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }

  /**
   * Render overlapped original + take waveforms on a shared time axis.
   * @param {HTMLCanvasElement} canvas
   * @param {{ original?: AudioBuffer|null, take?: AudioBuffer|null, durationLabel?: string, timelineSec?: number }} opts
   */
  function drawOverlap(canvas, opts = {}) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 160;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW;
    const h = cssH;

    // Background
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, 'rgba(26, 18, 48, 0.95)');
    bg.addColorStop(1, 'rgba(15, 10, 26, 0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Soft grid
    ctx.strokeStyle = 'rgba(168, 155, 196, 0.12)';
    ctx.lineWidth = 1;
    const rows = 4;
    const cols = 8;
    for (let i = 1; i < rows; i++) {
      const y = (h * i) / rows;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    for (let i = 1; i < cols; i++) {
      const x = (w * i) / cols;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Center line
    ctx.strokeStyle = 'rgba(245, 240, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const buckets = Math.max(80, Math.floor(w / 3));
    const amp = h * 0.38;
    const mid = h / 2;

    const original = opts.original;
    const take = opts.take;
    let timelineSec = Number(opts.timelineSec);
    if (!(timelineSec > 0.05)) {
      timelineSec = Math.max(original?.duration || 0, take?.duration || 0, 0.4);
    }

    const audioOffsetSec = Math.max(0, Number(opts.audioOffsetSec) || 0);
    const timingOffsetSec = Number(opts.timingOffsetSec) || 0;
    const takeOffsetSec = audioOffsetSec + timingOffsetSec;

    if (original) {
      const peaks = peaksOnTimeline(original, buckets, timelineSec, audioOffsetSec);
      ctx.fillStyle = 'rgba(255, 77, 141, 0.28)';
      ctx.strokeStyle = 'rgba(255, 77, 141, 0.85)';
      ctx.lineWidth = 1.5;
      drawWavePath(ctx, peaks, mid, amp, true);
      ctx.fill();
      ctx.stroke();
    }

    if (take) {
      const peaks = peaksOnTimeline(take, buckets, timelineSec, takeOffsetSec);
      ctx.fillStyle = 'rgba(124, 92, 255, 0.32)';
      ctx.strokeStyle = 'rgba(167, 139, 255, 0.95)';
      ctx.lineWidth = 1.75;
      drawWavePath(ctx, peaks, mid, amp, true);
      ctx.fill();
      ctx.stroke();
    }

    if (!original && !take && !(opts.livePeaks && opts.livePeaks.length)) {
      ctx.fillStyle = 'rgba(168, 155, 196, 0.7)';
      ctx.font = '600 13px Outfit, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Noch kein Vergleich — Original oder Take aufnehmen', w / 2, h / 2 + 4);
    }

    // REC = clip/mic start on timeline; Stimme = where take energy actually begins
    const cueSec = Number.isFinite(opts.cueMarkerSec)
      ? opts.cueMarkerSec
      : audioOffsetSec > 0.04
        ? audioOffsetSec
        : null;
    if (Number.isFinite(cueSec) && timelineSec > 0.05) {
      const cueX = w * Math.max(0, Math.min(0.98, cueSec / timelineSec));
      ctx.save();
      ctx.strokeStyle = 'rgba(80, 220, 160, 0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cueX, 16);
      ctx.lineTo(cueX, h - 10);
      ctx.stroke();
      ctx.fillStyle = 'rgba(80, 220, 160, 0.95)';
      ctx.font = '700 10px Outfit, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(opts.cueMarkerLabel || 'REC', cueX, 12);
      ctx.restore();
    }

    const voiceSec = Number(opts.voiceStartSec);
    if (Number.isFinite(voiceSec) && voiceSec >= 0 && timelineSec > 0.05) {
      const voiceX = w * Math.max(0, Math.min(0.98, voiceSec / timelineSec));
      const cueX =
        Number.isFinite(cueSec) && timelineSec > 0.05
          ? w * Math.max(0, Math.min(0.98, cueSec / timelineSec))
          : null;
      if (cueX == null || Math.abs(voiceX - cueX) > 6) {
        ctx.save();
        ctx.strokeStyle = 'rgba(120, 200, 255, 0.95)';
        ctx.lineWidth = 1.75;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(voiceX, 16);
        ctx.lineTo(voiceX, h - 10);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(120, 200, 255, 0.95)';
        ctx.font = '700 10px Outfit, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(opts.voiceStartLabel || 'Stimme', voiceX, 12);
        ctx.restore();
      }
    }

    // Drag handle at take buffer start (REC + timing offset)
    if (take && timelineSec > 0.05 && opts.showTakeHandle !== false) {
      const handleSec = Math.max(0, Math.min(timelineSec * 0.98, takeOffsetSec));
      const hx = w * (handleSec / timelineSec);
      ctx.save();
      ctx.strokeStyle = 'rgba(196, 181, 255, 0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, 14);
      ctx.lineTo(hx, h - 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(196, 181, 255, 0.9)';
      ctx.font = '700 10px Outfit, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(opts.takeHandleLabel || 'Take', hx, h - 12);
      ctx.restore();
    }

    // Live take while recording — time-aligned to expected duration (with optional lead-in)
    const livePeaks = opts.livePeaks;
    const progress = Math.max(0, Math.min(1.05, Number(opts.progress) || 0));
    if (livePeaks && livePeaks.length) {
      const offsetX = w * Math.max(0, Math.min(1, audioOffsetSec / Math.max(timelineSec, 0.2)));
      const endX = Math.max(offsetX + 2, w * Math.min(1, progress || 0));
      const liveWidth = Math.max(2, endX - offsetX);
      ctx.save();
      ctx.beginPath();
      ctx.rect(offsetX, 0, liveWidth, h);
      ctx.clip();

      const n = livePeaks.length;
      const step = liveWidth / Math.max(1, n);
      ctx.fillStyle = 'rgba(124, 92, 255, 0.38)';
      ctx.strokeStyle = 'rgba(196, 181, 255, 1)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = offsetX + i * step + step / 2;
        const y = mid - livePeaks[i].max * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= 0; i--) {
        const x = offsetX + i * step + step / 2;
        const y = mid - livePeaks[i].min * amp;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // White playhead (recording live tip OR playback position)
    let headX = null;
    if (livePeaks && livePeaks.length) {
      headX = Math.min(w - 1, Math.max(2, w * Math.min(1, progress || 0)));
    } else if (Number.isFinite(opts.playhead)) {
      headX = Math.min(w - 1, Math.max(0, w * Math.max(0, Math.min(1, opts.playhead))));
    }
    if (headX != null) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(headX, 8);
      ctx.lineTo(headX, h - 8);
      ctx.stroke();
    }

    // Edge labels
    ctx.fillStyle = 'rgba(168, 155, 196, 0.55)';
    ctx.font = '600 11px Outfit, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('0.0', 10, h - 10);
    ctx.textAlign = 'right';
    const label = opts.durationLabel || `${timelineSec.toFixed(1)}s`;
    ctx.fillText(label, w - 10, h - 10);
  }

  /** Cache decoded originals by URL for live recording redraws. */
  const originalCache = new Map();
  const takeCache = new Map();

  async function loadOriginal(url) {
    if (!url) return null;
    if (originalCache.has(url)) return originalCache.get(url);
    const buf = await decodeUrl(url);
    originalCache.set(url, buf);
    return buf;
  }

  async function loadTake({ takeBlob, takeBase64, takeMime, cacheKey } = {}) {
    const key = cacheKey || (takeBlob ? `blob:${takeBlob.size}` : takeBase64 ? `b64:${takeBase64.slice(0, 32)}` : null);
    if (!key) return null;
    if (takeCache.has(key)) return takeCache.get(key);
    let buf = null;
    if (takeBlob) buf = await decodeBlob(takeBlob);
    else if (takeBase64) buf = await decodeBase64(takeBase64, takeMime);
    if (buf) takeCache.set(key, buf);
    return buf;
  }

  /**
   * Sync redraw from caches (for playhead during take/original playback).
   */
  function drawPlayhead(
    canvas,
    {
      originalUrl,
      takeKey,
      playhead,
      durationLabel,
      timelineSec,
      audioOffsetSec,
      timingOffsetSec,
      cueMarkerSec,
      voiceStartSec,
    } = {}
  ) {
    if (!canvas) return;
    const original = originalUrl ? originalCache.get(originalUrl) || null : null;
    const take = takeKey ? takeCache.get(takeKey) || null : null;
    drawOverlap(canvas, {
      original,
      take,
      playhead,
      durationLabel: durationLabel || '—',
      timelineSec,
      audioOffsetSec,
      timingOffsetSec,
      cueMarkerSec: cueMarkerSec ?? audioOffsetSec,
      voiceStartSec,
    });
  }

  /**
   * Draw live comparison during recording (uses cached original — preload via loadOriginal).
   */
  function drawLive(
    canvas,
    {
      originalUrl,
      livePeaks,
      elapsedMs,
      expectedMs,
      timelineSec,
      audioOffsetSec,
      progress: progressOpt,
      playhead: playheadOpt,
      cueMarkerSec,
      recordingActive,
    } = {}
  ) {
    if (!canvas) return;
    const original = originalUrl ? originalCache.get(originalUrl) || null : null;
    const expected = Math.max(800, Number(expectedMs) || 4000);
    const progress =
      Number.isFinite(progressOpt)
        ? Math.max(0, Math.min(1.05, progressOpt))
        : Math.max(0, (Number(elapsedMs) || 0) / expected);
    drawOverlap(canvas, {
      original,
      take: null,
      livePeaks: livePeaks || [],
      progress,
      playhead: Number.isFinite(playheadOpt) ? playheadOpt : progress,
      audioOffsetSec,
      cueMarkerSec: cueMarkerSec ?? audioOffsetSec,
      cueMarkerLabel: recordingActive ? 'REC ●' : 'REC',
      durationLabel: `${((Number(elapsedMs) || 0) / 1000).toFixed(1)}s / ${(expected / 1000).toFixed(1)}s LIVE`,
      timelineSec: timelineSec || expected / 1000,
    });
  }

  /**
   * High-level refresh for the play UI.
   */
  async function refresh(
    canvas,
    { originalUrl, takeBlob, takeBase64, takeMime, timelineSec, audioOffsetSec, timingOffsetSec } = {}
  ) {
    if (!canvas) return { ok: false };
    let original = null;
    let take = null;
    let duration = 0;
    let takeKey = null;

    try {
      if (originalUrl) original = await loadOriginal(originalUrl);
    } catch (err) {
      console.warn('Original waveform decode failed', err);
    }

    try {
      if (takeBlob || takeBase64) {
        takeKey = takeBlob ? `blob:${takeBlob.size}:${takeBlob.type}` : `b64:${String(takeBase64).slice(0, 40)}`;
        take = await loadTake({ takeBlob, takeBase64, takeMime, cacheKey: takeKey });
      }
    } catch (err) {
      console.warn('Take waveform decode failed', err);
    }

    if (original) duration = Math.max(duration, original.duration);
    if (take) duration = Math.max(duration, take.duration);
    const lead = Math.max(0, Number(audioOffsetSec) || 0);
    const timing = Number(timingOffsetSec) || 0;
    const speechAxis = Number(timelineSec) > 0.05 ? Number(timelineSec) : duration + lead;
    const axis = speechAxis;

    let voiceStartSec = null;
    if (take && global.CVAudio?.measureSpeechOnsetSec) {
      const onset = global.CVAudio.measureSpeechOnsetSec(take);
      if (Number.isFinite(onset)) voiceStartSec = lead + timing + onset;
    }

    drawOverlap(canvas, {
      original,
      take,
      timelineSec: axis,
      audioOffsetSec: lead,
      timingOffsetSec: timing,
      cueMarkerSec: lead > 0.04 ? lead : 0,
      cueMarkerLabel: 'REC',
      voiceStartSec,
      voiceStartLabel: 'Stimme',
      durationLabel: axis ? `${Math.max(0, axis - lead).toFixed(1)}s` : '—',
    });

    return {
      ok: true,
      hasOriginal: !!original,
      hasTake: !!take,
      duration: axis || duration,
      takeKey,
      voiceStartSec,
      cueMarkerSec: lead,
      timingOffsetSec: timing,
    };
  }

  global.CVWaveform = {
    refresh,
    drawOverlap,
    drawLive,
    drawPlayhead,
    loadOriginal,
    loadTake,
  };
})(window);
