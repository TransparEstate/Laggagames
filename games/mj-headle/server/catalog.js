const fs = require('fs');
const path = require('path');
const r2 = require('./r2');
const cueDetect = require('./cueDetect');
const { isPlayableCue } = cueDetect;
const { slugify, songsFromAudioObjects } = require('./titleClean');
const { extractClip } = require('./clipExtract');

const ROOT = path.join(__dirname, '..');
const LOCAL_CATALOG = path.join(ROOT, 'catalog', 'songs.json');
const LOCAL_OVERRIDES = path.join(ROOT, 'data', 'cue-overrides.json');
const LOCAL_AUDIO_DIR = path.join(ROOT, 'data', 'audio');

const AUDIO_EXTS = ['.mp3', '.m4a', '.ogg', '.wav', '.webm'];

let cache = {
  loadedAt: 0,
  songs: [],
  source: 'none',
};

function loadJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeSong(raw) {
  const id = String(raw.id || slugify(raw.title) || '').trim();
  if (!id) return null;
  const audioKey = raw.audioKey || `audio/${id}.mp3`;
  return {
    id,
    title: String(raw.title || id),
    artist: String(raw.artist || 'Michael Jackson'),
    audioKey,
    localFile: raw.localFile || null,
    cueStartSec: Number(raw.cueStartSec ?? 0) || 0,
    cueQuality: raw.cueQuality || 'missing',
    cueReason: raw.cueReason || '',
    hasAudio: !!raw.hasAudio,
  };
}

function applyOverrides(songs) {
  const overrides = loadJsonSafe(LOCAL_OVERRIDES, {});
  return songs.map((s) => {
    const o = overrides[s.id];
    if (!o) return s;
    return {
      ...s,
      cueStartSec: o.cueStartSec != null ? Number(o.cueStartSec) : s.cueStartSec,
      cueQuality: o.cueQuality || (o.cueStartSec != null ? 'manual' : s.cueQuality),
      cueReason: o.cueReason || s.cueReason,
    };
  });
}

function detectLocalAudio(song) {
  for (const ext of AUDIO_EXTS) {
    const p = path.join(LOCAL_AUDIO_DIR, `${song.id}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  if (song.localFile) {
    const p = path.isAbsolute(song.localFile)
      ? song.localFile
      : path.join(ROOT, song.localFile);
    if (fs.existsSync(p)) return p;
  }
  if (song.audioKey) {
    const p = path.join(ROOT, 'data', song.audioKey);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function enrichAudioFlags(songs, { r2Reachable = false } = {}) {
  const out = [];
  for (const song of songs) {
    const local = detectLocalAudio(song);
    // Never trust hasAudio from JSON alone — without R2/local file the clip cannot play.
    let hasAudio = !!local;
    if (!hasAudio && r2.isEnabled() && r2Reachable) {
      if (song.hasAudio) {
        hasAudio = true; // came from R2 listing
      } else if (song.audioKey) {
        const head = await r2.headObject(song.audioKey);
        hasAudio = !!head;
      }
    }
    // If audio exists but cue was never analyzed, allow play at 0s (refine later).
    let cueQuality = song.cueQuality || 'missing';
    let cueReason = song.cueReason || '';
    if (hasAudio && cueQuality !== 'ok' && cueQuality !== 'manual') {
      cueQuality = 'ok';
      cueReason = cueReason || 'provisional-after-audio';
    }
    out.push({
      ...song,
      hasAudio,
      cueQuality,
      cueReason,
      localPath: local || null,
    });
  }
  return out;
}

async function buildFromR2() {
  if (!r2.isEnabled()) return [];
  const objects = await r2.listPrefix('audio/');
  if (!objects.length) return [];
  return songsFromAudioObjects(objects);
}

function buildFromLocalAudioDir() {
  if (!fs.existsSync(LOCAL_AUDIO_DIR)) return [];
  const files = fs.readdirSync(LOCAL_AUDIO_DIR);
  const objects = files.map((name) => {
    const full = path.join(LOCAL_AUDIO_DIR, name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      size = 0;
    }
    return { key: `audio/${name}`, size };
  });
  return songsFromAudioObjects(objects).map((s) => ({
    ...s,
    localFile: path.join('data', s.audioKey),
    hasAudio: true,
  }));
}

async function loadCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.songs.length && now - cache.loadedAt < 10_000) {
    return cache.songs;
  }

  let songs = [];
  let source = 'empty';
  let r2Error = null;
  let r2Reachable = false;

  try {
    const fromR2 = await buildFromR2();
    if (fromR2.length) {
      songs = fromR2;
      source = 'r2-audio';
      r2Reachable = true;
    } else if (r2.isEnabled()) {
      r2Reachable = true; // list worked, just empty
    }
  } catch (err) {
    r2Error = err?.message || String(err);
  }

  if (!songs.length) {
    const localAudio = buildFromLocalAudioDir();
    if (localAudio.length) {
      songs = localAudio;
      source = 'local-audio';
    }
  }

  if (!songs.length && r2.isEnabled() && r2Reachable) {
    try {
      const obj = await r2.getObjectBuffer('catalog/songs.json');
      if (obj?.buffer) {
        const parsed = JSON.parse(obj.buffer.toString('utf8'));
        songs = Array.isArray(parsed) ? parsed : parsed.songs || [];
        if (songs.length) source = 'r2-catalog';
      }
    } catch (err) {
      r2Error = r2Error || err?.message || String(err);
    }
  }

  if (!songs.length) {
    const local = loadJsonSafe(LOCAL_CATALOG, { songs: [] });
    songs = Array.isArray(local) ? local : local.songs || [];
    if (songs.length) source = 'local-catalog';
  }

  songs = applyOverrides(songs.map(normalizeSong).filter(Boolean));
  // If R2 keys are set but bucket is wrong, do NOT mark JSON songs as playable.
  songs = await enrichAudioFlags(songs, { r2Reachable });
  cache = { loadedAt: now, songs, source, r2Error, r2Reachable };
  return songs;
}

function catalogMeta() {
  return {
    source: cache.source || 'none',
    r2Reachable: !!cache.r2Reachable,
    r2Error: cache.r2Error || null,
    bucket: r2.bucket(),
  };
}

function publicSong(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    cueStartSec: song.cueStartSec,
    cueQuality: song.cueQuality,
    playable: !!(song.hasAudio && isPlayableCue(song)),
    hasAudio: !!song.hasAudio,
  };
}

async function listPublicSongs() {
  const songs = await loadCatalog();
  return songs.map(publicSong);
}

async function listPlayableSongs() {
  const songs = await loadCatalog();
  return songs.filter((s) => s.hasAudio && isPlayableCue(s));
}

async function getSong(id) {
  const songs = await loadCatalog();
  return songs.find((s) => s.id === id) || null;
}

async function resolveAudio(song) {
  if (!song) return null;
  if (song.localPath && fs.existsSync(song.localPath)) {
    const ext = path.extname(song.localPath).toLowerCase();
    const types = {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.webm': 'audio/webm',
    };
    return {
      buffer: fs.readFileSync(song.localPath),
      contentType: types[ext] || 'application/octet-stream',
      source: 'local',
    };
  }
  if (r2.isEnabled() && song.audioKey) {
    const obj = await r2.getObjectBuffer(song.audioKey);
    if (obj) return { ...obj, source: 'r2' };
  }
  return null;
}

function needsCueRefine(song) {
  if (!song) return false;
  const reason = String(song.cueReason || '');
  if (/provisional|r2-upload|upload-default|after-audio/i.test(reason)) return true;
  if ((Number(song.cueStartSec) || 0) <= 0.02) return true;
  return false;
}

/**
 * Provisional cues at 0s often land in silence — refine once via onset detect.
 */
async function ensureAudibleCue(song) {
  if (!song || !needsCueRefine(song)) return song;
  const audio = await resolveAudio(song);
  if (!audio?.buffer) return song;
  const ext = path.extname(song.audioKey || song.localPath || '.mp3') || '.mp3';
  let analysis;
  try {
    analysis = cueDetect.analyzeBuffer(audio.buffer, ext);
  } catch {
    return song;
  }
  const cueStartSec = Number(analysis.cueStartSec);
  if (!Number.isFinite(cueStartSec) || cueStartSec < 0) return song;
  const cueQuality =
    analysis.cueQuality === 'ok' || analysis.cueQuality === 'manual' ? analysis.cueQuality : 'ok';
  saveCueOverride(song.id, {
    cueStartSec,
    cueQuality,
    cueReason: analysis.reason || 'lazy-onset',
  });
  const refreshed = await getSong(song.id);
  return refreshed || { ...song, cueStartSec, cueQuality, cueReason: analysis.reason || 'lazy-onset' };
}

const clipCache = new Map();

async function resolveClip(song, durationSec) {
  if (!song) return null;
  const withCue = await ensureAudibleCue(song);
  const startSec = Number(withCue.cueStartSec) || 0;
  const dur = Math.min(35, Math.max(0.05, Number(durationSec) || 0.1));
  const cacheKey = `${withCue.id}:${startSec.toFixed(3)}:${dur.toFixed(3)}`;
  if (clipCache.has(cacheKey)) return { ...clipCache.get(cacheKey), song: withCue };

  const audio = await resolveAudio(withCue);
  if (!audio?.buffer) return null;
  const ext = path.extname(withCue.audioKey || withCue.localPath || '.mp3') || '.mp3';
  const clip = extractClip(audio.buffer, {
    startSec,
    durationSec: dur,
    ext,
  });
  const payload = {
    buffer: clip.buffer,
    contentType: clip.contentType,
    startSec: clip.startSec,
    durationSec: clip.durationSec,
    source: audio.source,
  };
  if (clipCache.size > 80) clipCache.clear();
  clipCache.set(cacheKey, payload);
  return { ...payload, song: withCue };
}

function saveCueOverride(id, { cueStartSec, cueQuality = 'manual', cueReason = 'manual-override' }) {
  const overrides = loadJsonSafe(LOCAL_OVERRIDES, {});
  overrides[id] = {
    cueStartSec: Number(cueStartSec) || 0,
    cueQuality,
    cueReason,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(LOCAL_OVERRIDES), { recursive: true });
  fs.writeFileSync(LOCAL_OVERRIDES, JSON.stringify(overrides, null, 2));
  cache.loadedAt = 0;
  return overrides[id];
}

async function syncFromStorage() {
  cache.loadedAt = 0;
  const songs = await loadCatalog({ force: true });
  return {
    source: cache.source,
    total: songs.length,
    withAudio: songs.filter((s) => s.hasAudio).length,
    playable: songs.filter((s) => s.hasAudio && isPlayableCue(s)).length,
  };
}

module.exports = {
  LOCAL_CATALOG,
  LOCAL_AUDIO_DIR,
  slugify,
  loadCatalog,
  catalogMeta,
  listPublicSongs,
  listPlayableSongs,
  getSong,
  resolveAudio,
  resolveClip,
  ensureAudibleCue,
  publicSong,
  saveCueOverride,
  syncFromStorage,
  isPlayableCue,
};
