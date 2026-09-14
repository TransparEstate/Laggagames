const fs = require('fs');
const path = require('path');
const r2 = require('./r2');
const { isPlayableCue } = require('./cueDetect');
const { slugify, songsFromAudioObjects } = require('./titleClean');

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

async function enrichAudioFlags(songs) {
  const out = [];
  for (const song of songs) {
    const local = detectLocalAudio(song);
    let hasAudio = !!local || !!song.hasAudio;
    if (!hasAudio && r2.isEnabled() && song.audioKey) {
      const head = await r2.headObject(song.audioKey);
      hasAudio = !!head;
    }
    out.push({ ...song, hasAudio, localPath: local || null });
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

  try {
    const fromR2 = await buildFromR2();
    if (fromR2.length) {
      songs = fromR2;
      source = 'r2-audio';
    }
  } catch {
    /* ignore */
  }

  if (!songs.length) {
    const localAudio = buildFromLocalAudioDir();
    if (localAudio.length) {
      songs = localAudio;
      source = 'local-audio';
    }
  }

  if (!songs.length && r2.isEnabled()) {
    try {
      const obj = await r2.getObjectBuffer('catalog/songs.json');
      if (obj?.buffer) {
        const parsed = JSON.parse(obj.buffer.toString('utf8'));
        songs = Array.isArray(parsed) ? parsed : parsed.songs || [];
        if (songs.length) source = 'r2-catalog';
      }
    } catch {
      /* ignore */
    }
  }

  if (!songs.length) {
    const local = loadJsonSafe(LOCAL_CATALOG, { songs: [] });
    songs = Array.isArray(local) ? local : local.songs || [];
    if (songs.length) source = 'local-catalog';
  }

  songs = applyOverrides(songs.map(normalizeSong).filter(Boolean));
  songs = await enrichAudioFlags(songs);
  cache = { loadedAt: now, songs, source };
  return songs;
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
  listPublicSongs,
  listPlayableSongs,
  getSong,
  resolveAudio,
  publicSong,
  saveCueOverride,
  syncFromStorage,
  isPlayableCue,
};
