(function (global) {
  let audioCtx = null;

  /** AudioBuffer → Map(buckets → peaks[]) */
  const peakCache = new WeakMap();
  /** Canvas → last sized { cssW, cssH, dpr } */
  const canvasSizeCache = new WeakMap();

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

  function getBufferPeaks(audioBuffer, buckets) {
    if (!audioBuffer || !buckets) return null;
    let byBuckets = peakCache.get(audioBuffer);
    if (!byBuckets) {
      byBuckets = new Map();
      peakCache.set(audioBuffer, byBuckets);
    }
    if (byBuckets.has(buckets)) return byBuckets.get(buckets);
    const peaks = peaksFromBuffer(audioBuffer, buckets);
    byBuckets.set(buckets, peaks);
    return peaks;
  }

  /**
   * Cached peaks for the audio's span on a timeline (no offset applied — draw with translate).
   */
  function peaksForTimelineSpan(audioBuffer, buckets, timelineSec) {
    if (!audioBuffer || !buckets) return null;
    const timeline = Math.max(0.2, Number(timelineSec) || audioBuffer.duration || 0.2);
    const usedBuckets = Math.max(
      1,
      Math.min(buckets, Math.round((audioBuffer.duration / timeline) * buckets))
    );
    return {
      peaks: getBufferPeaks(audioBuffer, usedBuckets),
      usedBuckets,
      timeline,
      duration: audioBuffer.duration,
    };
  }

  function drawWavePath(ctx, peaks, midY, amp, mirror, totalWidth) {
    const n = peaks.length;
    if (!n) return;
    const span = Math.max(1, Number(totalWidth) || 1);
    const step = span / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * step + step / 2;
      const y = midY - peaks[i].max * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (mirror) {
      for (let i = n - 1; i >= 0; i--) {
        const x = i * step + step / 2;
        const y = midY - peaks[i].min * amp;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }

  function ensureCanvasSize(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 160;
    const prev = canvasSizeCache.get(canvas);
    const needResize =
      !prev || prev.cssW !== cssW || prev.cssH !== cssH || prev.dpr !== dpr;
    if (needResize) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvasSizeCache.set(canvas, { cssW, cssH, dpr });
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH, dpr, resized: needResize };
  }

    function drawBufferedWave(
      ctx,
      audioBuffer,
      buckets,
      timelineSec,
      offsetSec,
      w,
      mid,
      amp,
      fill,
      stroke,
      lineWidth = 1.5
    ) {
    const span = peaksForTimelineSpan(audioBuffer, buckets, timelineSec);
    if (!span?.peaks?.length) return;
    const timeline = span.timeline;
    const offsetPx = ((Number(offsetSec) || 0) / timeline) * w;
    const usedWidth = Math.max(2, (span.duration / timeline) * w);
    ctx.save();
    ctx.translate(offsetPx, 0);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    drawWavePath(ctx, span.peaks, mid, amp, true, usedWidth);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Render overlapped original + take waveforms on a shared time axis.
   * @param {HTMLCanvasElement} canvas
   * @param {{ original?: AudioBuffer|null, take?: AudioBuffer|null, durationLabel?: string, timelineSec?: number }} opts
   */
  function drawOverlap(canvas, opts = {}) {
    const { ctx, w, h } = ensureCanvasSize(canvas);

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
      drawBufferedWave(
        ctx,
        original,
        buckets,
        timelineSec,
        audioOffsetSec,
        w,
        mid,
        amp,
        'rgba(255, 77, 141, 0.28)',
        'rgba(255, 77, 141, 0.85)',
        1.5
      );
    }

    if (take) {
      drawBufferedWave(
        ctx,
        take,
        buckets,
        timelineSec,
        takeOffsetSec,
        w,
        mid,
        amp,
        'rgba(124, 92, 255, 0.32)',
        'rgba(167, 139, 255, 0.95)',
        1.75
      );
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

    // Live take while recording — fixed-time buckets from PCM (not stretched)
    const livePeaks = opts.livePeaks;
    const liveBucketSec = Math.max(0.008, Number(opts.liveBucketSec) || 0.02);
    const progress = Math.max(0, Math.min(1.05, Number(opts.progress) || 0));
    if (livePeaks && livePeaks.length) {
      const n = livePeaks.length;
      ctx.save();
      ctx.fillStyle = 'rgba(124, 92, 255, 0.38)';
      ctx.strokeStyle = 'rgba(196, 181, 255, 1)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const t = audioOffsetSec + i * liveBucketSec;
        const x = w * Math.max(0, Math.min(1, t / Math.max(timelineSec, 0.2)));
        const y = mid - livePeaks[i].max * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= 0; i--) {
        const t = audioOffsetSec + i * liveBucketSec;
        const x = w * Math.max(0, Math.min(1, t / Math.max(timelineSec, 0.2)));
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

  /** Last drawn take/original buffers for fast timing drag (no re-decode). */
  let lastDrawBuffers = { original: null, take: null, takeKey: null, originalUrl: null };

  async function loadOriginal(url) {
    if (!url) return null;
    if (originalCache.has(url)) return originalCache.get(url);
    const buf = await decodeUrl(url);
    originalCache.set(url, buf);
    return buf;
  }

  async function loadTake({ takeBlob, takeBase64, takeMime, cacheKey } = {}) {
    const key =
      cacheKey || (takeBlob ? `blob:${takeBlob.size}` : takeBase64 ? `b64:${takeBase64.slice(0, 32)}` : null);
    if (!key) return null;
    if (takeCache.has(key)) return takeCache.get(key);
    let buf = null;
    if (takeBlob) buf = await decodeBlob(takeBlob);
    else if (takeBase64) buf = await decodeBase64(takeBase64, takeMime);
    if (buf) takeCache.set(key, buf);
    return buf;
  }

  function getCachedDrawState() {
    return lastDrawBuffers;
  }

  /**
   * Sync redraw with cached buffers + new timing offset (drag hotpath).
   */
  function drawTiming(
    canvas,
    {
      timingOffsetSec,
      timelineSec,
      audioOffsetSec,
      durationLabel,
      cueMarkerSec,
      voiceStartSec,
      playhead,
    } = {}
  ) {
    if (!canvas) return false;
    const { original, take } = lastDrawBuffers;
    if (!original && !take) return false;
    const lead = Math.max(0, Number(audioOffsetSec) || 0);
    const timing = Number(timingOffsetSec) || 0;
    let voice = voiceStartSec;
    if (take && voice == null && global.CVAudio?.measureSpeechOnsetSec) {
      const onset = global.CVAudio.measureSpeechOnsetSec(take);
      if (Number.isFinite(onset)) voice = lead + timing + onset;
    }
    drawOverlap(canvas, {
      original,
      take,
      timelineSec,
      audioOffsetSec: lead,
      timingOffsetSec: timing,
      cueMarkerSec: cueMarkerSec ?? (lead > 0.04 ? lead : 0),
      voiceStartSec: voice,
      voiceStartLabel: 'Stimme',
      durationLabel,
      playhead,
    });
    return true;
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
    if (original || take) {
      lastDrawBuffers = {
        original,
        take,
        takeKey: takeKey || null,
        originalUrl: originalUrl || null,
      };
    }
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
      liveBucketSec,
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
    if (original) {
      lastDrawBuffers = {
        ...lastDrawBuffers,
        original,
        originalUrl: originalUrl || lastDrawBuffers.originalUrl,
      };
    }
    const expected = Math.max(800, Number(expectedMs) || 4000);
    const progress =
      Number.isFinite(progressOpt)
        ? Math.max(0, Math.min(1.05, progressOpt))
        : Math.max(0, (Number(elapsedMs) || 0) / expected);
    drawOverlap(canvas, {
      original,
      take: null,
      livePeaks: livePeaks || [],
      liveBucketSec: liveBucketSec || 0.02,
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
        takeKey = takeBlob
          ? `blob:${takeBlob.size}:${takeBlob.type}`
          : `b64:${String(takeBase64).slice(0, 40)}`;
        take = await loadTake({ takeBlob, takeBase64, takeMime, cacheKey: takeKey });
      }
    } catch (err) {
      console.warn('Take waveform decode failed', err);
    }

    lastDrawBuffers = {
      original,
      take,
      takeKey,
      originalUrl: originalUrl || null,
    };

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
      timelineSec: axis,
      audioOffsetSec: lead,
    };
  }

  global.CVWaveform = {
    refresh,
    drawOverlap,
    drawLive,
    drawPlayhead,
    drawTiming,
    getCachedDrawState,
    loadOriginal,
    loadTake,
  };
})(window);
