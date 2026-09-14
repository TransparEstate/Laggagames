#!/usr/bin/env node
/**
 * Generate synthetic fixtures and verify cue detection.
 * - silence-then-hit: should find a markant onset near ~1.0s
 * - noise-only: should be weak
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cueDetect = require('../server/cueDetect');

const FIX = path.join(__dirname, '..', 'data', 'fixtures');
fs.mkdirSync(FIX, { recursive: true });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  }
}

function makeSilenceThenHit(outFile) {
  // 0.3s 880Hz tone delayed by 1.0s → markant onset ~1.0s
  run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=44100:duration=0.3',
    '-af',
    'adelay=1000|1000',
    outFile,
  ]);
}

function makeNoiseOnly(outFile) {
  run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=pink:amplitude=0.02:sample_rate=44100',
    '-t',
    '2',
    outFile,
  ]);
}

const hit = path.join(FIX, 'silence-then-hit.wav');
const noise = path.join(FIX, 'noise-only.wav');
makeSilenceThenHit(hit);
makeNoiseOnly(noise);

const hitCue = cueDetect.analyzeFile(hit);
const noiseCue = cueDetect.analyzeFile(noise);

console.log('silence-then-hit', hitCue);
console.log('noise-only', noiseCue);

let failed = false;
if (!(hitCue.cueQuality === 'ok' && hitCue.cueStartSec >= 0.7 && hitCue.cueStartSec <= 1.2)) {
  console.error('FAIL: expected markant cue near 1.0s for silence-then-hit');
  failed = true;
} else {
  console.log('OK: silence-then-hit cue detected');
}
if (noiseCue.cueQuality === 'ok') {
  console.error('FAIL: noise-only should be weak');
  failed = true;
} else {
  console.log('OK: noise-only marked weak');
}

process.exit(failed ? 1 : 0);
