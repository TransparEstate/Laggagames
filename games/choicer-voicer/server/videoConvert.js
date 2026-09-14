const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function runFfmpeg(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      if (!settled) {
        settled = true;
        reject(new Error(`ffmpeg Timeout nach ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`ffmpeg nicht gefunden: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.slice(-900).replace(/\s+/g, ' ').trim();
      if (signal) {
        reject(
          new Error(
            `ffmpeg abgebrochen (${signal}) — oft zu wenig RAM bei 1080p. ${tail}`
          )
        );
        return;
      }
      reject(new Error(`ffmpeg exit ${code}: ${tail}`));
    });
  });
}

/**
 * Read media duration in seconds via ffprobe (sync — used during pack load).
 * Accepts a local path or an http(s) URL.
 */
function probeAudioDurationSync(filePathOrUrl) {
  if (!filePathOrUrl) return null;
  const isUrl = /^https?:\/\//i.test(String(filePathOrUrl));
  if (!isUrl && !fileExists(filePathOrUrl)) return null;
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePathOrUrl,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );
    if (result.error || result.status !== 0) return null;
    const n = parseFloat(String(result.stdout || '').trim());
    return Number.isFinite(n) && n > 0.05 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Probe duration from an in-memory buffer by writing a temp file.
 */
function probeAudioDurationBuffer(buffer, ext = '.mp3') {
  if (!buffer || !buffer.length) return null;
  const os = require('os');
  const tmp = path.join(
    os.tmpdir(),
    `cv-probe-${process.pid}-${Date.now()}${ext.startsWith('.') ? ext : `.${ext}`}`
  );
  try {
    fs.writeFileSync(tmp, buffer);
    return probeAudioDurationSync(tmp);
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function buildConvertArgs(source, outFile, profile) {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-stats',
    '-i',
    source,
  ];
  if (profile.scale) {
    args.push('-vf', profile.scale);
  }
  args.push(
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    profile.preset,
    '-crf',
    String(profile.crf),
    '-threads',
    String(profile.threads),
    '-c:a',
    'aac',
    '-b:a',
    profile.audioBitrate,
    '-ac',
    '2',
    '-ar',
    '44100',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    outFile
  );
  return args;
}

/** Profiles: light first — Railway free/low RAM OOMs on full 1080p x264. */
const CONVERT_PROFILES = [
  {
    name: '720p-fast',
    scale: "scale='min(1280,iw)':-2",
    preset: 'veryfast',
    crf: 23,
    threads: 2,
    audioBitrate: '128k',
  },
  {
    name: '540p-ultra',
    scale: "scale='min(960,iw)':-2",
    preset: 'ultrafast',
    crf: 26,
    threads: 1,
    audioBitrate: '96k',
  },
  {
    name: '360p-ultra',
    scale: "scale='min(640,iw)':-2",
    preset: 'ultrafast',
    crf: 28,
    threads: 1,
    audioBitrate: '64k',
  },
];

/**
 * Ensure pack has Chrome-playable dub_video.mp4 (convert from .ogv/.webm if needed).
 */
async function ensureBrowserVideo(packDir) {
  const mp4 = path.join(packDir, 'dub_video.mp4');
  if (fileExists(mp4)) {
    return { ok: true, videoFile: 'dub_video.mp4', converted: false };
  }

  const sources = ['dub_video.webm', 'dub_video.ogv'].map((f) => path.join(packDir, f));
  const source = sources.find(fileExists);
  if (!source) {
    return { ok: false, error: 'Kein dub_video.* im Pack.' };
  }

  const errors = [];
  for (const profile of CONVERT_PROFILES) {
    const tmpOut = path.join(packDir, `dub_video.convert-${Date.now()}-${profile.name}.mp4`);
    try {
      console.log(`Video-Konvertierung (${profile.name}): ${path.basename(source)} → mp4`);
      await runFfmpeg(buildConvertArgs(source, tmpOut, profile), {
        timeoutMs: 12 * 60 * 1000,
      });
      if (!fileExists(tmpOut) || fs.statSync(tmpOut).size < 1024) {
        throw new Error('Ausgabe-Datei leer oder fehlt');
      }
      fs.renameSync(tmpOut, mp4);
      return {
        ok: true,
        videoFile: 'dub_video.mp4',
        converted: true,
        from: path.basename(source),
        profile: profile.name,
      };
    } catch (err) {
      try {
        if (fileExists(tmpOut)) fs.unlinkSync(tmpOut);
      } catch {
        /* ignore */
      }
      const msg = err.message || String(err);
      console.warn(`Video-Konvertierung (${profile.name}) fehlgeschlagen:`, msg.slice(0, 400));
      errors.push(`${profile.name}: ${msg.slice(0, 180)}`);
    }
  }

  return {
    ok: false,
    error:
      errors.join(' | ') ||
      'Video-Konvertierung fehlgeschlagen. Bitte Pack mit dub_video.mp4 hochladen.',
  };
}

module.exports = {
  ensureBrowserVideo,
  probeAudioDurationSync,
  probeAudioDurationBuffer,
};
