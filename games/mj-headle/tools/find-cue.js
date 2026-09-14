#!/usr/bin/env node
/**
 * Find a markant cue point so the 0.1s clip is audible.
 *
 * Usage:
 *   node tools/find-cue.js path/to/track.mp3
 *   node tools/find-cue.js path/to/track.mp3 --apply song-id
 */
const path = require('path');
const fs = require('fs');
const cueDetect = require('../server/cueDetect');
const catalog = require('../server/catalog');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const applyIdx = args.indexOf('--apply');
  const songId = applyIdx >= 0 ? args[applyIdx + 1] : null;

  if (!file) {
    console.error('Usage: node tools/find-cue.js <audio-file> [--apply <song-id>]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
  }

  const analysis = cueDetect.analyzeFile(abs);
  console.log(JSON.stringify({ file: abs, ...analysis }, null, 2));

  if (songId) {
    if (analysis.cueQuality !== 'ok' && analysis.cueQuality !== 'manual') {
      console.error('Cue quality is weak — not applying. Set manually via API if needed.');
      process.exit(2);
    }
    const saved = catalog.saveCueOverride(songId, {
      cueStartSec: analysis.cueStartSec,
      cueQuality: 'ok',
      cueReason: analysis.reason || 'cli-onset',
    });
    await catalog.loadCatalog({ force: true });
    console.log('Applied override:', saved);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
