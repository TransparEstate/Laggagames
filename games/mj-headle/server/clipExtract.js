/**
 * Cut a short audible clip from a full audio buffer (ffmpeg).
 * Browser plays this small file as-is — no seeking on huge MP3s.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function extractClip(inputBuffer, { startSec = 0, durationSec = 0.1, ext = '.mp3' } = {}) {
  const start = Math.max(0, Number(startSec) || 0);
  const dur = Math.min(15, Math.max(0.05, Number(durationSec) || 0.1));
  const inFile = path.join(os.tmpdir(), `mj-clip-in-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  const outFile = path.join(os.tmpdir(), `mj-clip-out-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  fs.writeFileSync(inFile, inputBuffer);
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(start),
        '-t',
        String(dur),
        '-i',
        inFile,
        '-vn',
        '-acodec',
        'libmp3lame',
        '-q:a',
        '4',
        '-y',
        outFile,
      ],
      { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }
    );
    if (result.status !== 0) {
      const err = (result.stderr && result.stderr.toString('utf8')) || 'ffmpeg clip failed';
      throw new Error(err.trim() || 'ffmpeg clip failed');
    }
    if (!fs.existsSync(outFile)) throw new Error('Clip-Datei fehlt nach ffmpeg.');
    const buffer = fs.readFileSync(outFile);
    if (!buffer.length) throw new Error('Clip ist leer.');
    return { buffer, contentType: 'audio/mpeg', startSec: start, durationSec: dur };
  } finally {
    try {
      fs.unlinkSync(inFile);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { extractClip };
