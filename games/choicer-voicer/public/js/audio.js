(function (global) {
  let mediaStream = null;
  let mediaRecorder = null;
  let chunks = [];

  /** PCM capture (sample-accurate, no encoder delay / no auto-shift) */
  let pcmChunks = [];
  let pcmSamples = 0;
  let pcmCueSample = null;
  let pcmActive = false;

  let monitorCtx = null;
  let monitorSource = null;
  let monitorAnalyser = null;
  let livePeaks = [];
  let liveRaf = null;
  let liveStartedAt = 0;
  let liveMonitorActive = false;
  let liveBucketFill = 0;
  let liveBucketMin = 0;
  let liveBucketMax = 0;
  let liveSamplesPerBucket = 960; // ~20 ms @ 48 kHz
  const LIVE_BUCKET_SEC = 0.02;

  /** Mic → nur Gain → MediaRecorder (sauber, ohne Voice-FX) */
  let recordCtx = null;
  let recordChain = null;
  let workletReady = null;
  /** Base makeup — bewusst niedrig; guter Mic soll natürlich klingen, Slider regelt Feinabstimmung */
  const RECORD_GAIN = 1.2;
  /** User multiplier from Mic-slider (1 = 100%). Persisted in play.js via localStorage. */
  let userMicGain = 1;
  /** How strongly to pull take loudness toward the original (0–1). Leaves creative room. */
  const MATCH_STRENGTH = 0.65;
  const MATCH_MAX_PEAK = 0.93;
  const MATCH_MIN_GAIN = 0.5;
  const MATCH_MAX_GAIN = 4;
  const FALLBACK_TARGET_PEAK = 0.88;
  const FALLBACK_MAX_GAIN = 4;

  function getMicGain() {
    return userMicGain;
  }

  function effectiveRecordGain() {
    return RECORD_GAIN * userMicGain;
  }

  /** @param {number} gain multiplier, 1 = default (100% on the UI slider) */
  function setMicGain(gain) {
    const g = Number(gain);
    userMicGain = Number.isFinite(g) ? Math.min(2.5, Math.max(0.35, g)) : 1;
    // Capture bleibt dry — Pegel nur beim Export. Live-Monitor folgt dem Mic 1:1.
    return userMicGain;
  }

  function streamIsLive(stream) {
    return !!(stream && stream.getAudioTracks().some((t) => t.readyState === 'live'));
  }

  async function ensureMic(forceReopen = false) {
    if (mediaStream && !forceReopen && streamIsLive(mediaStream)) return mediaStream;
    if (mediaStream) {
      try {
        mediaStream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      mediaStream = null;
    }

    // Wichtig für gute Mics: KEINE Browser-Rauschunterdrückung / Echo-Cancelling —
    // die machen teure Mikros oft „Mülltonnen“-mäßig und matschig.
    const clean = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { ...clean, sampleRate: 48000 },
      });
    } catch {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: clean });
      } catch {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }
    return mediaStream;
  }

  function pickMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
    ];
    for (const type of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  /**
   * Transparent: nur Pegel. Kein Gate/EQ/Kompressor — die ruinieren gute Mikrofone.
   */
  function buildVoiceChain(ctx, stream) {
    const source = ctx.createMediaStreamSource(stream);
    const makeup = ctx.createGain();
    makeup.gain.value = effectiveRecordGain();
    const dest = ctx.createMediaStreamDestination();
    source.connect(makeup);
    makeup.connect(dest);
    return {
      source,
      makeup,
      dest,
      monitorTap: makeup,
    };
  }

  async function closeRecordChain({ keepContext = false } = {}) {
    pcmActive = false;
    if (recordChain) {
      try {
        if (recordChain.workletNode?.port) {
          recordChain.workletNode.port.onmessage = null;
          recordChain.workletNode.port.postMessage({ type: 'flush' });
        }
      } catch (_) {}
      try {
        if (recordChain.processor) recordChain.processor.onaudioprocess = null;
      } catch (_) {}
      for (const key of ['source', 'makeup', 'processor', 'workletNode', 'mute']) {
        try {
          recordChain[key]?.disconnect();
        } catch (_) {}
      }
      recordChain = null;
    }
    if (!keepContext && recordCtx && recordCtx.state !== 'closed') {
      try {
        await recordCtx.close();
      } catch (_) {}
      recordCtx = null;
      workletReady = null;
    }
  }

  const PCM_WORKLET_NAME = 'cv-pcm-capture';
  const PCM_WORKLET_SOURCE = `
class CvPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._filled = 0;
    this._active = true;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'stop') this._active = false;
      if (msg.type === 'start') this._active = true;
      if (msg.type === 'flush') this._flush();
    };
  }
  _flush() {
    if (this._filled <= 0) return;
    const out = this._buf.slice(0, this._filled);
    this._filled = 0;
    this.port.postMessage(out, [out.buffer]);
  }
  process(inputs) {
    if (!this._active) return true;
    const input = inputs[0] && inputs[0][0];
    if (!input || !input.length) return true;
    let i = 0;
    while (i < input.length) {
      const space = this._buf.length - this._filled;
      const n = Math.min(space, input.length - i);
      this._buf.set(input.subarray(i, i + n), this._filled);
      this._filled += n;
      i += n;
      if (this._filled >= this._buf.length) {
        const out = this._buf.slice(0);
        this._filled = 0;
        this.port.postMessage(out, [out.buffer]);
        this._buf = new Float32Array(4096);
      }
    }
    return true;
  }
}
registerProcessor('${PCM_WORKLET_NAME}', CvPcmCaptureProcessor);
`;

  async function ensurePcmWorklet(ctx) {
    if (!ctx?.audioWorklet) return false;
    if (workletReady === ctx) return true;
    try {
      const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      workletReady = ctx;
      return true;
    } catch (err) {
      console.warn('AudioWorklet PCM capture unavailable, falling back', err);
      return false;
    }
  }

  function pushPcmChunk(input) {
    if (!pcmActive || !input?.length) return;
    pcmChunks.push(input instanceof Float32Array ? input : new Float32Array(input));
    pcmSamples += input.length;
    // Live-Peaks ab Cue — unabhängig vom UI-Monitor, damit kein Sample verloren geht
    if (pcmCueSample != null) {
      appendLivePeaksFromSamples(input);
    }
  }

  function resetLivePeakBuilder(sampleRate) {
    livePeaks = [];
    liveBucketFill = 0;
    liveBucketMin = 0;
    liveBucketMax = 0;
    const sr = sampleRate || recordCtx?.sampleRate || 48000;
    liveSamplesPerBucket = Math.max(1, Math.round(sr * LIVE_BUCKET_SEC));
  }

  function appendLivePeaksFromSamples(samples) {
    if (!samples?.length) return;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (v < liveBucketMin) liveBucketMin = v;
      if (v > liveBucketMax) liveBucketMax = v;
      liveBucketFill += 1;
      if (liveBucketFill >= liveSamplesPerBucket) {
        livePeaks.push({ min: liveBucketMin, max: liveBucketMax });
        liveBucketFill = 0;
        liveBucketMin = 0;
        liveBucketMax = 0;
        if (livePeaks.length > 600) livePeaks.splice(0, livePeaks.length - 480);
      }
    }
  }

  /** AudioContext schon am Klick öffnen — Safari braucht die User-Geste. */
  async function prepareRecordContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio nicht verfügbar.');
    if (!recordCtx || recordCtx.state === 'closed') {
      try {
        recordCtx = new AC({ sampleRate: 48000 });
      } catch {
        recordCtx = new AC();
      }
    }
    if (recordCtx.state === 'suspended') await recordCtx.resume();
    // Worklet früh laden, damit der erste REC-Klick nicht darauf wartet
    try {
      await ensurePcmWorklet(recordCtx);
    } catch (_) {}
    return recordCtx;
  }

  function concatPcm() {
    const out = new Float32Array(pcmSamples);
    let offset = 0;
    for (const chunk of pcmChunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function stopLiveMonitor() {
    liveMonitorActive = false;
    if (liveRaf) {
      cancelAnimationFrame(liveRaf);
      liveRaf = null;
    }
    try {
      monitorSource?.disconnect();
    } catch (_) {}
    if (monitorAnalyser && recordChain?.monitorTap) {
      try {
        recordChain.monitorTap.disconnect(monitorAnalyser);
      } catch (_) {}
    }
    try {
      monitorAnalyser?.disconnect();
    } catch (_) {}
    monitorSource = null;
    monitorAnalyser = null;
    if (monitorCtx && monitorCtx.state !== 'closed') {
      monitorCtx.close().catch(() => {});
    }
    monitorCtx = null;
  }

  /**
   * Live waveform from the same PCM capture buffer (sample-accurate vs. Analyser).
   * Peaks start at the recording cue; time axis = (pcmSamples - cue) / sampleRate.
   * @param {(peaks: {min:number,max:number}[], elapsedMs: number, meta: object) => void} onFrame
   */
  async function startLiveMonitor(onFrame) {
    stopLiveMonitor();
    // Peak-Reset übernimmt markRecordingCue (Sample-Null am REC-Start)
    if (!livePeaks) livePeaks = [];
    liveMonitorActive = true;
    if (!liveStartedAt) liveStartedAt = performance.now();

    let lastFrameAt = 0;
    const tick = () => {
      if (!liveMonitorActive) return;
      const now = performance.now();
      if (now - lastFrameAt >= 48) {
        lastFrameAt = now;
        const elapsedSec = getLivePcmElapsedSec();
        const elapsedMs = elapsedSec * 1000;
        if (typeof onFrame === 'function') {
          onFrame(livePeaks, elapsedMs, {
            elapsedSec,
            bucketSec: LIVE_BUCKET_SEC,
            cued: pcmCueSample != null,
            sampleRate: recordCtx?.sampleRate || 48000,
          });
        }
      }
      liveRaf = requestAnimationFrame(tick);
    };
    liveRaf = requestAnimationFrame(tick);

    return { ok: true, processed: true, source: 'pcm' };
  }

  function getLivePeaks() {
    return livePeaks;
  }

  function getLiveBucketSec() {
    return LIVE_BUCKET_SEC;
  }

  function getLivePcmElapsedSec() {
    if (pcmCueSample == null) return 0;
    const sr = recordCtx?.sampleRate || 48000;
    return Math.max(0, (pcmSamples - pcmCueSample) / sr);
  }

  function getLiveElapsedMs() {
    return getLivePcmElapsedSec() * 1000;
  }

  function measurePeak(buffer) {
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

  /**
   * RMS of samples above a noise gate (ignores silence tails).
   * Better proxy for perceived dialogue loudness than raw peak.
   */
  function measureSpeechRms(buffer, gate = 0.02) {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const a = Math.abs(data[i]);
        if (a >= gate) {
          sum += data[i] * data[i];
          count += 1;
        }
      }
    }
    if (count < 32) {
      // Fallback: full-buffer RMS if almost everything was gated
      let s = 0;
      let n = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < data.length; i++) {
          s += data[i] * data[i];
          n += 1;
        }
      }
      return n ? Math.sqrt(s / n) : 0;
    }
    return Math.sqrt(sum / count);
  }

  /**
   * Gain that moves take loudness toward reference, partially (creative room),
   * then caps so peaks don't clip.
   */
  function computeMatchGain(takeBuffer, refBuffer, opts = {}) {
    const strength = Number.isFinite(opts.matchStrength) ? opts.matchStrength : MATCH_STRENGTH;
    const maxPeak = Number.isFinite(opts.maxPeak) ? opts.maxPeak : MATCH_MAX_PEAK;
    const minGain = Number.isFinite(opts.minGain) ? opts.minGain : MATCH_MIN_GAIN;
    const maxGain = Number.isFinite(opts.maxGain) ? opts.maxGain : MATCH_MAX_GAIN;

    const takeRms = measureSpeechRms(takeBuffer);
    const takePeak = measurePeak(takeBuffer);
    if (takeRms < 0.0004 || takePeak < 0.0005) {
      return { gain: 1, takeRms, refRms: null, mode: 'silent' };
    }

    let gain;
    let refRms = null;
    let mode = 'fallback-peak';

    if (refBuffer) {
      refRms = measureSpeechRms(refBuffer);
      if (refRms > 0.001) {
        // Match in dB space, only partway → keeps creative louder/quieter takes
        const takeDb = 20 * Math.log10(takeRms);
        const refDb = 20 * Math.log10(refRms);
        const deltaDb = (refDb - takeDb) * strength;
        gain = 10 ** (deltaDb / 20);
        mode = 'match-original';
      }
    }

    if (!(gain > 0)) {
      gain = Math.min(FALLBACK_MAX_GAIN, FALLBACK_TARGET_PEAK / takePeak);
      mode = 'fallback-peak';
    }

    gain = Math.min(maxGain, Math.max(minGain, gain));

    // Never clip: if boosted peaks would exceed maxPeak, pull gain down
    if (takePeak * gain > maxPeak) {
      gain = maxPeak / takePeak;
      mode = mode === 'match-original' ? 'match-original-limited' : 'fallback-peak-limited';
    }

    return { gain, takeRms, refRms, takePeak, mode };
  }

  function scaleAudioBuffer(ctx, buffer, scale) {
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const input = buffer.getChannelData(c);
      const output = out.getChannelData(c);
      for (let i = 0; i < input.length; i++) {
        output[i] = Math.max(-1, Math.min(1, input[i] * scale));
      }
    }
    return out;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /**
   * Quiet run at the start/end of a buffer (seconds), capped so whole lines aren't treated as silence.
   */
  function measureEdgeQuietSec(buffer, { fromEnd = false, gate = 0.018, maxSec = 0.28 } = {}) {
    if (!buffer || buffer.length < 8) return 0;
    const sr = buffer.sampleRate;
    const ch = buffer.getChannelData(0);
    const win = Math.max(1, Math.floor(0.006 * sr));
    const maxScan = Math.min(ch.length, Math.floor(maxSec * sr));

    if (!fromEnd) {
      for (let i = 0; i < maxScan; i += win) {
        let peak = 0;
        const end = Math.min(ch.length, i + win);
        for (let j = i; j < end; j++) peak = Math.max(peak, Math.abs(ch[j]));
        if (peak >= gate) return i / sr;
      }
      return maxScan / sr;
    }

    for (let i = 0; i < maxScan; i += win) {
      let peak = 0;
      const end = ch.length - i;
      const start = Math.max(0, end - win);
      for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(ch[j]));
      if (peak >= gate) return i / sr;
    }
    return maxScan / sr;
  }

  function smoothstep01(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  /**
   * Soft edges: attack from 0, release ending at releaseAtSample (or buffer end).
   */
  function applyEdgeFades(ctx, buffer, attackSec, releaseSec, releaseAtSample = null) {
    if (!buffer || buffer.length < 8) return buffer;
    const sr = buffer.sampleRate;
    const attackSamples = Math.max(1, Math.min(buffer.length, Math.round(Math.max(0.006, attackSec) * sr)));
    const releaseAt = Number.isFinite(releaseAtSample)
      ? clamp(Math.round(releaseAtSample), 1, buffer.length)
      : buffer.length;
    const releaseSamples = Math.max(
      1,
      Math.min(releaseAt, Math.round(Math.max(0.012, releaseSec) * sr))
    );

    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, sr);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const input = buffer.getChannelData(c);
      const output = out.getChannelData(c);
      output.set(input);
      for (let i = 0; i < attackSamples; i++) {
        output[i] *= smoothstep01(i / attackSamples);
      }
      for (let i = 0; i < releaseSamples; i++) {
        const idx = releaseAt - 1 - i;
        if (idx < 0) break;
        output[idx] *= smoothstep01(i / releaseSamples);
      }
    }
    return out;
  }

  /**
   * Exact-length copy from a fixed start sample. No auto-shift, no speech-detect, no smart crop.
   * Shorter takes are silence-padded; longer takes are truncated at targetSamples.
   */
  function copyExactLength(ctx, takeBuffer, targetSamples, startSample = 0) {
    const sr = takeBuffer.sampleRate;
    const channels = takeBuffer.numberOfChannels;
    const out = ctx.createBuffer(channels, Math.max(1, targetSamples), sr);
    const start = Math.max(0, Math.min(takeBuffer.length, Math.round(startSample) || 0));
    const copyLen = Math.min(out.length, Math.max(0, takeBuffer.length - start));
    for (let c = 0; c < channels; c++) {
      if (copyLen > 0) {
        out.getChannelData(c).set(takeBuffer.getChannelData(c).subarray(start, start + copyLen));
      }
    }
    const fade = Math.min(copyLen, Math.max(1, Math.round(0.002 * sr)));
    for (let c = 0; c < channels; c++) {
      const data = out.getChannelData(c);
      for (let i = 0; i < fade; i++) data[i] *= i / fade;
      if (copyLen > fade) {
        for (let i = 0; i < fade; i++) {
          const idx = copyLen - 1 - i;
          if (idx >= 0) data[idx] *= i / fade;
        }
      }
    }
    return out;
  }

  /**
   * Fit take to exact original/target length from a fixed start (1:1, no auto-shift).
   */
  function fitTakeToReference(ctx, takeBuffer, refBuffer, opts = {}) {
    const sr = takeBuffer.sampleRate;
    let targetSamples = takeBuffer.length;
    if (Number.isFinite(opts.targetDurationSec) && opts.targetDurationSec > 0.05) {
      targetSamples = Math.round(opts.targetDurationSec * sr);
    } else if (refBuffer && Number.isFinite(refBuffer.duration) && refBuffer.duration > 0.05) {
      targetSamples = Math.round(refBuffer.duration * sr);
    }
    const trimStartSec = Math.max(0, Number(opts.trimStartSec) || 0);
    return copyExactLength(ctx, takeBuffer, Math.max(1, targetSamples), Math.round(trimStartSec * sr));
  }

  /** Seconds until first audible speech (for UI marker). */
  function measureSpeechOnsetSec(buffer, gate = 0.022) {
    if (!buffer || buffer.length < 8) return 0;
    const sr = buffer.sampleRate;
    const ch = buffer.getChannelData(0);
    const win = Math.max(1, Math.floor(0.006 * sr));
    const maxScan = Math.min(ch.length, Math.floor(Math.min(buffer.duration, 1.5) * sr));
    for (let i = 0; i < maxScan; i += win) {
      let peak = 0;
      const end = Math.min(ch.length, i + win);
      for (let j = i; j < end; j++) peak = Math.max(peak, Math.abs(ch[j]));
      if (peak >= gate) return i / sr;
    }
    return 0;
  }

  /**
   * @deprecated kept as alias — always exact-length fit with soft edges
   */
  function fitTakeLength(ctx, takeBuffer, refBuffer, opts = {}) {
    return fitTakeToReference(ctx, takeBuffer, refBuffer, opts);
  }

  function audioBufferToWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
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
    view.setUint16(20, 1, true);
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

  async function decodeBlobToBuffer(ctx, blob) {
    const arr = await blob.arrayBuffer();
    return ctx.decodeAudioData(arr.slice(0));
  }

  async function decodeUrlToBuffer(ctx, url) {
    if (!url) return null;
    // Prefer waveform cache if already decoded
    if (global.CVWaveform?.loadOriginal) {
      try {
        const cached = await global.CVWaveform.loadOriginal(url);
        if (cached) return cached;
      } catch (_) {}
    }
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return ctx.decodeAudioData(arr.slice(0));
  }

  /**
   * Match take loudness toward the original reference (partial), with clip safety.
   * opts.referenceUrl | opts.referenceBuffer — original line audio
   * opts.matchStrength — 0..1 (default ~0.72)
   */
  async function normalizeRecordingBlob(blob, opts = {}) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !blob) return null;
    const ctx = new AC();
    try {
      let decoded = await decodeBlobToBuffer(ctx, blob);
      let refBuffer = opts.referenceBuffer || null;
      if (!refBuffer && opts.referenceUrl) {
        try {
          refBuffer = await decodeUrlToBuffer(ctx, opts.referenceUrl);
        } catch (err) {
          console.warn('Reference loudness load failed', err);
        }
      }

      decoded = fitTakeToReference(ctx, decoded, refBuffer, {
        targetDurationSec: opts.targetDurationSec,
        trimStartSec: opts.trimStartSec,
      });
      const match = computeMatchGain(decoded, refBuffer, opts);
      // Mic-Slider + leichter Base-Gain erst hier (nicht live im AudioGraph)
      const totalGain = match.gain * effectiveRecordGain();
      const scaled = scaleAudioBuffer(ctx, decoded, totalGain);
      return {
        blob: audioBufferToWavBlob(scaled),
        mimeType: 'audio/wav',
        gain: totalGain,
        peak: match.takePeak,
        takeRms: match.takeRms,
        refRms: match.refRms,
        mode: match.mode,
        durationSec: scaled.duration,
      };
    } finally {
      try {
        await ctx.close();
      } catch (_) {}
    }
  }

  async function startRecording() {
    await closeRecordChain({ keepContext: true });
    const stream = await ensureMic(false);
    const ctx = await prepareRecordContext();

    pcmChunks = [];
    pcmSamples = 0;
    pcmCueSample = null;
    pcmActive = true;
    chunks = [];
    mediaRecorder = null;

    const source = ctx.createMediaStreamSource(stream);
    const makeup = ctx.createGain();
    makeup.gain.value = 1;
    source.connect(makeup);

    const mute = ctx.createGain();
    mute.gain.value = 0;

    const useWorklet = await ensurePcmWorklet(ctx);
    let processor = null;
    let workletNode = null;

    if (useWorklet) {
      workletNode = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      workletNode.port.onmessage = (event) => {
        if (!pcmActive) return;
        const data = event.data;
        if (data instanceof Float32Array) pushPcmChunk(data);
      };
      workletNode.port.postMessage({ type: 'start' });
      makeup.connect(workletNode);
      workletNode.connect(mute);
    } else {
      // Größerer Buffer = deutlich weniger Dropouts als 1024 unter Main-Thread-Last
      processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!pcmActive) return;
        const input = event.inputBuffer.getChannelData(0);
        pushPcmChunk(new Float32Array(input));
        event.outputBuffer.getChannelData(0).fill(0);
      };
      makeup.connect(processor);
      processor.connect(mute);
    }
    mute.connect(ctx.destination);

    recordChain = {
      source,
      makeup,
      processor,
      workletNode,
      mute,
      monitorTap: makeup,
    };

    return {
      mimeType: 'audio/wav',
      startedAt: performance.now(),
      sampleRate: ctx.sampleRate,
      pcm: true,
      capture: useWorklet ? 'worklet' : 'scriptProcessor',
    };
  }

  /** Sample-Index am Sprech-Cue — Vorlauf wird später verworfen, Inhalt nicht verschoben. */
  function markRecordingCue() {
    pcmCueSample = pcmSamples;
    resetLivePeakBuilder(recordCtx?.sampleRate);
    liveStartedAt = performance.now();
    return pcmCueSample;
  }

  function cancelRecording() {
    return new Promise((resolve) => {
      stopLiveMonitor();
      pcmActive = false;
      pcmChunks = [];
      pcmSamples = 0;
      pcmCueSample = null;
      closeRecordChain().finally(resolve);
    });
  }

  function stopRecording(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!recordChain && pcmSamples <= 0) {
        reject(new Error('Keine aktive Aufnahme.'));
        return;
      }
      stopLiveMonitor();

      const finish = async () => {
        try {
          // Restbuffer aus dem Worklet noch abholen (pcmActive bleibt kurz an)
          if (recordChain?.workletNode?.port) {
            try {
              recordChain.workletNode.port.postMessage({ type: 'flush' });
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 25));
          }
          pcmActive = false;
          const pcm = concatPcm();
          const sr = recordCtx?.sampleRate || 48000;
          const cue = Number.isFinite(pcmCueSample) ? pcmCueSample : 0;
          const AC = window.AudioContext || window.webkitAudioContext;
          const ctx = new AC({ sampleRate: sr });
          try {
            const raw = ctx.createBuffer(1, Math.max(1, pcm.length), sr);
            if (pcm.length) raw.getChannelData(0).set(pcm);

            let targetSec = Number(opts.targetDurationSec);
            if (!(targetSec > 0.05) && opts.referenceUrl) {
              try {
                const ref = await decodeUrlToBuffer(ctx, opts.referenceUrl);
                if (ref?.duration > 0.05) targetSec = ref.duration;
              } catch (_) {}
            }
            if (!(targetSec > 0.05)) {
              targetSec = Math.max(0.15, (pcm.length - cue) / sr);
            }

            const fitted = copyExactLength(ctx, raw, Math.round(targetSec * sr), cue);
            let refBuffer = opts.referenceBuffer || null;
            if (!refBuffer && opts.referenceUrl) {
              try {
                refBuffer = await decodeUrlToBuffer(ctx, opts.referenceUrl);
              } catch (_) {}
            }
            const matched = computeMatchGain(fitted, refBuffer, opts);
            const totalGain = matched.gain * effectiveRecordGain();
            const scaled = scaleAudioBuffer(ctx, fitted, totalGain);
            const EDGE_FADE_SEC = 0.015;
            const smoothed = applyEdgeFades(ctx, scaled, EDGE_FADE_SEC, EDGE_FADE_SEC);
            resolve({
              blob: audioBufferToWavBlob(smoothed),
              mimeType: 'audio/wav',
              normalized: true,
              gainApplied: totalGain,
              matchMode: matched.mode,
              refRms: matched.refRms,
              takeRms: matched.takeRms,
              durationSec: smoothed.duration,
            });
          } finally {
            try {
              await ctx.close();
            } catch (_) {}
          }
        } catch (err) {
          pcmActive = false;
          reject(err);
        } finally {
          pcmChunks = [];
          pcmSamples = 0;
          pcmCueSample = null;
          await closeRecordChain();
        }
      };

      // Letztes Capture-Buffer noch mitnehmen, dann exakt auf Zieldauer schneiden
      setTimeout(() => {
        finish().catch(reject);
      }, 40);
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error('Base64-Fehler'));
      reader.readAsDataURL(blob);
    });
  }

  let currentPlayback = null;

  function stopPlayback() {
    if (currentPlayback) {
      try {
        currentPlayback.pause();
        currentPlayback.src = '';
      } catch (_) {}
      currentPlayback = null;
    }
  }

  function playBlob(blob, opts = {}) {
    stopPlayback();
    const url = URL.createObjectURL(blob);
    return playUrl(url, opts).finally(() => URL.revokeObjectURL(url));
  }

  /**
   * Play with optional delay (positive) or buffer seek (negative offset → skip start).
   * timingOffsetSec > 0: start later; < 0: skip into the clip so it lands earlier on timeline.
   */
  function playUrl(url, opts = {}) {
    stopPlayback();
    const delaySec = Math.max(0, Number(opts.delaySec) || 0);
    const offsetSec = Math.max(0, Number(opts.offsetSec) || 0);
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      currentPlayback = audio;
      audio.volume = 1;
      let delayTimer = null;
      const cleanup = () => {
        if (delayTimer) clearTimeout(delayTimer);
        if (currentPlayback === audio) currentPlayback = null;
      };
      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error('Audio konnte nicht abgespielt werden.'));
      };
      const start = () => {
        if (currentPlayback !== audio) return;
        if (offsetSec > 0.01) {
          try {
            audio.currentTime = offsetSec;
          } catch (_) {}
        }
        audio.play().catch((err) => {
          cleanup();
          reject(err);
        });
      };
      if (delaySec > 0.01) {
        delayTimer = setTimeout(start, delaySec * 1000);
      } else {
        start();
      }
    });
  }

  function playBase64(base64, mimeType, opts = {}) {
    stopPlayback();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    return playUrl(url, opts).finally(() => URL.revokeObjectURL(url));
  }

  function stopMic() {
    stopLiveMonitor();
    pcmActive = false;
    pcmChunks = [];
    pcmSamples = 0;
    pcmCueSample = null;
    closeRecordChain();
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    mediaRecorder = null;
    chunks = [];
  }

  global.CVAudio = {
    ensureMic,
    prepareRecordContext,
    startRecording,
    markRecordingCue,
    stopRecording,
    cancelRecording,
    startLiveMonitor,
    stopLiveMonitor,
    getLivePeaks,
    getLiveElapsedMs,
    getLivePcmElapsedSec,
    getLiveBucketSec,
    blobToBase64,
    playUrl,
    playBase64,
    playBlob,
    stopPlayback,
    stopMic,
    normalizeRecordingBlob,
    computeMatchGain,
    measureSpeechRms,
    measureSpeechOnsetSec,
    measurePeak,
    applyEdgeFades,
    getMicGain,
    setMicGain,
    effectiveRecordGain,
  };
})(window);
