/**
 * Cue / onset detection for MJ Headle.
 * Finds the first markant transient so 0.1s clips are audible (not silence/wind).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLE_RATE = 22050;
const ANALYZE_SECONDS = 45;
const WINDOW_SEC = 0.02;
const HOP_SEC = 0.01;
const PREVIEW_SEC = 0.1;

function decodeToF32(filePath, maxSeconds = ANALYZE_SECONDS) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Datei nicht gefunden: ${abs}`);
  }
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-t',
      String(maxSeconds),
      '-i',
      abs,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      'pipe:1',
    ],
    { encoding: 'buffer', maxBuffer: 80 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    const err = (result.stderr && result.stderr.toString('utf8')) || 'ffmpeg failed';
    throw new Error(err.trim() || 'ffmpeg decode failed');
  }
  return new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / 4)
  );
}

function windowStats(samples) {
  const win = Math.max(1, Math.floor(WINDOW_SEC * SAMPLE_RATE));
  const hop = Math.max(1, Math.floor(HOP_SEC * SAMPLE_RATE));
  const rms = [];
  const flux = [];
  let prevEnergy = 0;
  for (let start = 0; start + win <= samples.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = samples[start + i];
      sum += v * v;
    }
    const e = Math.sqrt(sum / win);
    rms.push(e);
    flux.push(Math.max(0, e - prevEnergy));
    prevEnergy = e;
  }
  return { rms, flux, hopSec: HOP_SEC };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1)))
  );
  return sorted[idx];
}

function previewMetrics(samples, cueStartSec, dur = PREVIEW_SEC) {
  const start = Math.floor(cueStartSec * SAMPLE_RATE);
  const end = Math.min(samples.length, start + Math.floor(dur * SAMPLE_RATE));
  if (end <= start) return { previewRms: 0, previewPeak: 0 };
  let sum = 0;
  let peak = 0;
  const n = end - start;
  for (let i = start; i < end; i++) {
    const v = samples[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { previewRms: Math.sqrt(sum / n), previewPeak: peak };
}

function analyzeSamples(samples) {
  const { rms, flux, hopSec } = windowStats(samples);
  if (!rms.length) {
    return {
      cueStartSec: 0,
      cueQuality: 'weak',
      previewRms: 0,
      peakRms: 0,
      noiseFloor: 0,
      reason: 'empty',
    };
  }

  const sorted = [...rms].sort((a, b) => a - b);
  const noiseFloor = Math.max(1e-6, percentile(sorted, 15));
  const peakRms = sorted[sorted.length - 1] || 0;
  const energyThresh = Math.max(noiseFloor * 8, peakRms * 0.18, 0.02);
  const fluxThresh = Math.max(
    percentile([...flux].sort((a, b) => a - b), 85) * 0.6,
    energyThresh * 0.35
  );

  let cueIndex = -1;
  for (let i = 2; i < rms.length - 2; i++) {
    if (rms[i] < energyThresh) continue;
    if (flux[i] < fluxThresh && rms[i] < energyThresh * 1.4) continue;
    const localPrev = (rms[i - 1] + rms[i - 2]) / 2;
    if (rms[i] < localPrev * 1.35 && flux[i] < fluxThresh * 1.2) continue;
    cueIndex = i;
    break;
  }

  if (cueIndex < 0) {
    for (let i = 0; i < rms.length; i++) {
      if (rms[i] >= energyThresh) {
        cueIndex = i;
        break;
      }
    }
  }

  const cueStartSec = cueIndex < 0 ? 0 : Number((cueIndex * hopSec).toFixed(3));
  const preview = previewMetrics(samples, cueStartSec);
  const snr = preview.previewRms / Math.max(noiseFloor, 1e-6);
  const peakRatio = preview.previewPeak / Math.max(noiseFloor, 1e-6);

  let cueQuality = 'ok';
  let reason = 'onset';
  if (cueIndex < 0 || preview.previewRms < noiseFloor * 4 || snr < 4 || peakRatio < 6) {
    cueQuality = 'weak';
    reason = 'low-energy-or-noisy';
  }

  return {
    cueStartSec,
    cueQuality,
    previewRms: Number(preview.previewRms.toFixed(5)),
    previewPeak: Number(preview.previewPeak.toFixed(5)),
    peakRms: Number(peakRms.toFixed(5)),
    noiseFloor: Number(noiseFloor.toFixed(5)),
    snr: Number(snr.toFixed(2)),
    reason,
  };
}

function analyzeFile(filePath) {
  const samples = decodeToF32(filePath);
  return analyzeSamples(samples);
}

function analyzeBuffer(buffer, ext = '.mp3') {
  const tmp = path.join(os.tmpdir(), `mj-headle-cue-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, buffer);
  try {
    return analyzeFile(tmp);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function isPlayableCue(song) {
  const q = String(song?.cueQuality || '').toLowerCase();
  return q === 'ok' || q === 'manual';
}

module.exports = {
  SAMPLE_RATE,
  PREVIEW_SEC,
  decodeToF32,
  analyzeSamples,
  analyzeFile,
  analyzeBuffer,
  isPlayableCue,
};
