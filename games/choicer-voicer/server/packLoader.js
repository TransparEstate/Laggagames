const fs = require('fs');
const path = require('path');

const BUNDLED_PACKS_ROOT = path.join(__dirname, '..', 'assets', 'packs');
const USER_PACKS_ROOT =
  process.env.PACKS_DIR || path.join(__dirname, '..', 'data', 'packs');
const META_ROOT =
  process.env.PACK_META_DIR || path.join(__dirname, '..', 'data', 'pack-meta');

/** @type {Map<string, object>} */
const r2ManifestCache = new Map();

function ensureUserPacksRoot() {
  fs.mkdirSync(USER_PACKS_ROOT, { recursive: true });
  return USER_PACKS_ROOT;
}

function ensureMetaRoot() {
  fs.mkdirSync(META_ROOT, { recursive: true });
  return META_ROOT;
}

function parseDataBlock(text) {
  const data = {};
  const captionMatch = text.match(/caption\s*=\s*"((?:\\.|[^"\\])*)"/);
  if (captionMatch) {
    data.caption = captionMatch[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');
  }

  const imageMatch = text.match(/image\s*=\s*"([^"]+)"/);
  if (imageMatch) data.image = imageMatch[1];

  const tsMatch = text.match(/dub_timestamps\s*=\s*\[([^\]]*)\]/);
  if (tsMatch) {
    data.dub_timestamps = tsMatch[1]
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n));
  } else {
    data.dub_timestamps = [0];
  }

  const charMatch = text.match(/dub_characters\s*=\s*\[([^\]]*)\]/);
  if (charMatch) {
    data.dub_characters = [...charMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  } else {
    data.dub_characters = ['Unknown'];
  }

  return data;
}

function parsePackInfo(text) {
  const titleMatch = text.match(/title\s*=\s*"([^"]+)"/);
  const iconMatch = text.match(/icon\s*=\s*"([^"]+)"/);
  const authorsMatch = text.match(/authors\s*=\s*\[([^\]]*)\]/);
  return {
    title: titleMatch ? titleMatch[1] : 'Untitled Pack',
    icon: iconMatch ? iconMatch[1] : null,
    authors: authorsMatch
      ? [...authorsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [],
  };
}

function dirSizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (p) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function mediaBase() {
  try {
    const r2 = require('./r2');
    const pub = r2.publicBaseUrl();
    if (pub) return pub.replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  return '';
}

function mediaUrl(packId, fileName) {
  if (!fileName) return null;
  const base = mediaBase();
  if (base) return `${base}/packs/${packId}/${fileName}`;
  return `/packs/${packId}/${fileName}`;
}

const AUDIO_PAD_SEC = 0.18; // tiny tail so takes aren't cut mid-breath
const FALLBACK_LAST_SEC = 4;
const FALLBACK_MIN_SEC = 1.0;

/**
 * Clip length should match the spoken reference line, not the gap until the next cue.
 * Gap is only an upper bound (don't overlap the next line).
 *
 * @param {object[]} scenes
 * @param {string|null} packDir local pack folder (may lack MP3s)
 * @param {{ packId?: string, previousById?: Map<string, object> }} [opts]
 */
function applySceneDurations(scenes, packDir, opts = {}) {
  const { probeAudioDurationSync } = require('./videoConvert');
  const previousById = opts.previousById || null;

  scenes.sort((a, b) => a.timestamp - b.timestamp || a.orderKey - b.orderKey);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const start = Number(scene.timestamp) || 0;
    const next = scenes[i + 1];
    const gapEnd = next ? next.timestamp - 0.14 : null;

    let referenceDuration = null;
    if (Number.isFinite(scene.referenceDuration) && scene.referenceDuration > 0.05) {
      referenceDuration = scene.referenceDuration;
    } else if (packDir && scene.referenceFile) {
      referenceDuration = probeAudioDurationSync(path.join(packDir, scene.referenceFile));
    }
    if (referenceDuration == null && previousById) {
      const prev = previousById.get(scene.id);
      if (Number.isFinite(prev?.referenceDuration) && prev.referenceDuration > 0.05) {
        referenceDuration = prev.referenceDuration;
      }
    }
    scene.referenceDuration = referenceDuration;

    let end;
    if (referenceDuration != null) {
      const audioEnd = start + referenceDuration + AUDIO_PAD_SEC;
      end = gapEnd != null ? Math.min(audioEnd, gapEnd) : audioEnd;
      // Always keep at least the real audio (clamped by next cue if needed)
      const minEnd =
        start +
        Math.min(
          referenceDuration,
          gapEnd != null ? Math.max(0.3, gapEnd - start) : referenceDuration
        );
      end = Math.max(end, minEnd);
    } else if (gapEnd != null) {
      end = Math.max(start + FALLBACK_MIN_SEC, gapEnd);
    } else {
      end = start + FALLBACK_LAST_SEC;
    }

    scene.endTimestamp = Math.round(end * 1000) / 1000;
    scene.duration = Math.round((scene.endTimestamp - start) * 1000) / 1000;
  }
}

function previousScenesById(packId) {
  const prev = r2ManifestCache.get(packId) || readLocalManifest(packId);
  if (!prev?.scenes?.length) return null;
  return new Map(prev.scenes.map((s) => [s.id, s]));
}

/**
 * Download reference MP3 from R2 (or public URL) and probe duration.
 */
async function probeReferenceDurationRemote(packId, referenceFile) {
  if (!packId || !referenceFile) return null;
  const { probeAudioDurationSync, probeAudioDurationBuffer } = require('./videoConvert');
  const r2 = require('./r2');

  const publicBase = r2.publicBaseUrl();
  if (publicBase) {
    const url = `${publicBase}/packs/${packId}/${referenceFile}`;
    const viaUrl = probeAudioDurationSync(url);
    if (viaUrl != null) return viaUrl;
  }

  if (!r2.isEnabled()) return null;
  try {
    const res = await r2.getObject(r2.packKey(packId, referenceFile));
    if (!res?.Body) return null;
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    const ext = path.extname(referenceFile) || '.mp3';
    return probeAudioDurationBuffer(buf, ext);
  } catch (err) {
    console.warn(`Referenz-Probe fehlgeschlagen ${packId}/${referenceFile}:`, err.message || err);
    return null;
  }
}

function resolvePackDir(packId) {
  const safe = String(packId || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe || safe !== packId) return null;
  const userDir = path.join(USER_PACKS_ROOT, safe);
  if (fs.existsSync(userDir) && fs.statSync(userDir).isDirectory()) {
    // Ignore empty / meta-only dirs
    const files = fs.readdirSync(userDir).filter((f) => !f.startsWith('.'));
    if (files.length) return { dir: userDir, source: 'user' };
  }
  const bundledDir = path.join(BUNDLED_PACKS_ROOT, safe);
  if (fs.existsSync(bundledDir) && fs.statSync(bundledDir).isDirectory()) {
    return { dir: bundledDir, source: 'bundled' };
  }
  return null;
}

function loadPackFromDir(packId, packDir, source) {
  const infoPath = path.join(packDir, '_pack_info.ini');
  const info = fs.existsSync(infoPath)
    ? parsePackInfo(fs.readFileSync(infoPath, 'utf8'))
    : { title: packId, icon: null, authors: [] };

  const files = fs.readdirSync(packDir);
  const sceneFiles = files
    .filter((f) => /^\d+_.*\.txt$/i.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const scenes = [];
  for (const txtFile of sceneFiles) {
    const base = txtFile.replace(/\.txt$/i, '');
    const raw = fs.readFileSync(path.join(packDir, txtFile), 'utf8');
    const meta = parseDataBlock(raw);
    const mp3 = `${base}.mp3`;
    const png = meta.image || `${base}.png`;
    const timestamp = meta.dub_timestamps[0] || 0;
    const character = meta.dub_characters[0] || 'Unknown';

    scenes.push({
      id: base,
      orderKey: parseInt(base, 10) || 0,
      caption: meta.caption || base,
      character,
      timestamp,
      imageFile: files.includes(png) ? png : null,
      referenceFile: files.includes(mp3) ? mp3 : null,
      imageUrl: files.includes(png) ? mediaUrl(packId, png) : null,
      referenceUrl: files.includes(mp3) ? mediaUrl(packId, mp3) : null,
      fileBase: base,
    });
  }

  scenes.sort((a, b) => a.timestamp - b.timestamp || a.orderKey - b.orderKey);
  applySceneDurations(scenes, packDir, {
    packId,
    previousById: previousScenesById(packId),
  });

  const characters = [...new Set(scenes.map((s) => s.character))].sort();
  const videoCandidates = ['dub_video.mp4', 'dub_video.webm', 'dub_video.ogv'];
  const videoFile = videoCandidates.find((f) => files.includes(f)) || null;
  const sizeBytes = dirSizeBytes(packDir);

  return {
    id: packId,
    title: info.title,
    iconFile: info.icon || null,
    iconUrl: info.icon ? mediaUrl(packId, info.icon) : null,
    authors: info.authors,
    videoFile,
    videoUrl: videoFile ? mediaUrl(packId, videoFile) : null,
    backingTrackFile: files.includes('_backing_track.mp3') ? '_backing_track.mp3' : null,
    backingTrackUrl: files.includes('_backing_track.mp3')
      ? mediaUrl(packId, '_backing_track.mp3')
      : null,
    characters,
    scenes,
    hasVideo: !!videoFile,
    source,
    sizeBytes,
    mirroredToR2: isRemoteMirror(packId),
  };
}

function isRemoteMirror(packId) {
  try {
    const r2 = require('./r2');
    return r2.isEnabled() && r2ManifestCache.has(packId);
  } catch {
    return false;
  }
}

function packFromManifest(manifest, source = 'r2') {
  const packId = manifest.id;
  const scenes = (manifest.scenes || []).map((s) => ({
    ...s,
    imageUrl: s.imageFile ? mediaUrl(packId, s.imageFile) : s.imageUrl || null,
    referenceUrl: s.referenceFile
      ? mediaUrl(packId, s.referenceFile)
      : s.referenceUrl || null,
  }));

  return {
    id: packId,
    title: manifest.title || packId,
    iconFile: manifest.iconFile || null,
    iconUrl: manifest.iconFile
      ? mediaUrl(packId, manifest.iconFile)
      : manifest.iconUrl || null,
    authors: manifest.authors || [],
    videoFile: manifest.videoFile || null,
    videoUrl: manifest.videoFile
      ? mediaUrl(packId, manifest.videoFile)
      : manifest.videoUrl || null,
    backingTrackFile: manifest.backingTrackFile || null,
    backingTrackUrl: manifest.backingTrackFile
      ? mediaUrl(packId, manifest.backingTrackFile)
      : manifest.backingTrackUrl || null,
    characters: manifest.characters || [],
    scenes,
    hasVideo: !!(manifest.videoFile || manifest.hasVideo),
    source,
    sizeBytes: manifest.sizeBytes || 0,
    mirroredToR2: isRemoteMirror(packId) || source === 'r2',
    contentHash: manifest.contentHash || null,
  };
}

function buildManifest(pack) {
  return {
    id: pack.id,
    title: pack.title,
    iconFile: pack.iconFile || null,
    authors: pack.authors || [],
    videoFile: pack.videoFile || null,
    backingTrackFile: pack.backingTrackFile || null,
    characters: pack.characters || [],
    scenes: (pack.scenes || []).map((s) => ({
      id: s.id,
      orderKey: s.orderKey,
      caption: s.caption,
      character: s.character,
      timestamp: s.timestamp,
      endTimestamp: s.endTimestamp,
      duration: s.duration,
      referenceDuration: s.referenceDuration ?? null,
      imageFile: s.imageFile || null,
      referenceFile: s.referenceFile || null,
      fileBase: s.fileBase || s.id,
    })),
    hasVideo: !!pack.hasVideo,
    sizeBytes: pack.sizeBytes || 0,
    contentHash: pack.contentHash || null,
    uploadedAt: pack.uploadedAt || new Date().toISOString(),
  };
}

function saveLocalManifest(manifest) {
  ensureMetaRoot();
  const file = path.join(META_ROOT, `${manifest.id}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
}

function readLocalManifest(packId) {
  const file = path.join(META_ROOT, `${packId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function deleteLocalManifest(packId) {
  const file = path.join(META_ROOT, `${packId}.json`);
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function loadPack(packId) {
  const resolved = resolvePackDir(packId);
  if (resolved) {
    return loadPackFromDir(packId, resolved.dir, resolved.source);
  }

  const cached = r2ManifestCache.get(packId) || readLocalManifest(packId);
  if (cached) {
    return packFromManifest(cached, cached.source || 'r2');
  }

  throw new Error(`Pack nicht gefunden: ${packId}`);
}

function listLocalPackIds() {
  // Cloudflare R2 is the source of truth. Local user dirs are ephemeral staging only.
  const ids = new Set();
  for (const id of r2ManifestCache.keys()) {
    if (id && !String(id).startsWith('.') && !String(id).startsWith('_')) ids.add(id);
  }
  if (fs.existsSync(META_ROOT)) {
    for (const f of fs.readdirSync(META_ROOT)) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/i, '');
      if (id && !id.startsWith('.') && !id.startsWith('_')) ids.add(id);
    }
  }
  // Optional bundled packs (usually empty)
  if (fs.existsSync(BUNDLED_PACKS_ROOT)) {
    for (const d of fs.readdirSync(BUNDLED_PACKS_ROOT, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) ids.add(d.name);
    }
  }
  return [...ids];
}

function summarize(pack) {
  return {
    id: pack.id,
    title: pack.title,
    iconUrl: pack.iconUrl,
    sceneCount: pack.scenes.length,
    characters: pack.characters,
    source: pack.source,
    sizeBytes: pack.sizeBytes,
    hasVideo: pack.hasVideo,
    mirroredToR2: !!pack.mirroredToR2,
    contentHash: pack.contentHash || null,
  };
}

function listPacks() {
  return listLocalPackIds()
    .map((id) => {
      try {
        return summarize(loadPack(id));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title, 'de'));
}

function setR2ManifestCache(manifests) {
  r2ManifestCache.clear();
  for (const m of manifests || []) {
    if (m?.id) r2ManifestCache.set(m.id, m);
  }
}

function rememberManifest(manifest) {
  if (!manifest?.id) return;
  r2ManifestCache.set(manifest.id, manifest);
  saveLocalManifest(manifest);
}

async function refreshR2Manifests() {
  const r2 = require('./r2');
  if (!r2.isEnabled()) {
    setR2ManifestCache([]);
    return [];
  }
  const manifests = await r2.listManifests();
  setR2ManifestCache(manifests);
  for (const m of manifests) saveLocalManifest(m);
  return manifests;
}

/**
 * Recompute scene durations from reference MP3s (local and/or R2) and refresh manifests.
 * Never overwrites a working referenceDuration with null / gap-only fallbacks.
 */
async function repairPackDurations({ uploadToR2 = true } = {}) {
  const r2 = require('./r2');
  const results = [];
  ensureUserPacksRoot();
  const roots = [USER_PACKS_ROOT, BUNDLED_PACKS_ROOT];
  const seen = new Set();

  async function enrichMissingDurations(packId, scenes, packDir) {
    let probed = 0;
    for (const scene of scenes) {
      if (Number.isFinite(scene.referenceDuration) && scene.referenceDuration > 0.05) continue;
      if (!scene.referenceFile) continue;

      let dur = null;
      if (packDir) {
        const { probeAudioDurationSync } = require('./videoConvert');
        dur = probeAudioDurationSync(path.join(packDir, scene.referenceFile));
      }
      if (dur == null) {
        dur = await probeReferenceDurationRemote(packId, scene.referenceFile);
      }
      if (dur != null) {
        scene.referenceDuration = dur;
        probed += 1;
      }
    }
    applySceneDurations(scenes, packDir, {
      packId,
      previousById: previousScenesById(packId),
    });
    return probed;
  }

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name === '.tmp') continue;
      const packId = d.name;
      if (seen.has(packId)) continue;
      seen.add(packId);
      try {
        const packDir = path.join(root, packId);
        const pack = loadPackFromDir(
          packId,
          packDir,
          root === USER_PACKS_ROOT ? 'user' : 'bundled'
        );
        const beforeMissing = (pack.scenes || []).filter(
          (s) => s.referenceFile && !(Number.isFinite(s.referenceDuration) && s.referenceDuration > 0.05)
        ).length;
        const probed = await enrichMissingDurations(packId, pack.scenes, packDir);
        const withRef = (pack.scenes || []).filter(
          (s) => Number.isFinite(s.referenceDuration) && s.referenceDuration > 0.05
        ).length;

        // Avoid publishing gap-only manifests when we still couldn't measure audio
        if (withRef === 0 && beforeMissing > 0 && probed === 0) {
          results.push({
            id: packId,
            scenes: pack.scenes.length,
            ok: true,
            skipped: true,
            reason: 'keine Referenz-MP3-Dauer messbar — Manifest unverändert',
          });
          console.log(`Pack-Dauern übersprungen (keine MP3-Probe): ${packId}`);
          continue;
        }

        const manifest = buildManifest(pack);
        rememberManifest(manifest);
        if (uploadToR2 && r2.isEnabled() && root === USER_PACKS_ROOT) {
          await r2.putManifest(packId, manifest);
        }
        const sample = (pack.scenes || [])
          .filter((s) => s.referenceDuration != null)
          .slice(0, 3)
          .map((s) => `${s.id}:${s.referenceDuration?.toFixed(2)}→${s.duration}`);
        results.push({
          id: packId,
          scenes: pack.scenes.length,
          ok: true,
          probed,
          withRef,
          sample,
        });
        console.log(
          `Pack-Dauern repariert: ${packId} (${withRef}/${pack.scenes.length} mit Referenz, +${probed} remote)`
        );
      } catch (err) {
        results.push({ id: packId, ok: false, error: err.message });
        console.warn(`Pack-Dauer-Repair fehlgeschlagen: ${packId}`, err.message);
      }
    }
  }

  // Manifest-only packs (R2 / pack-meta without local media folder)
  const manifestIds = new Set([
    ...r2ManifestCache.keys(),
    ...(fs.existsSync(META_ROOT)
      ? fs
          .readdirSync(META_ROOT)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/i, ''))
      : []),
  ]);

  for (const packId of manifestIds) {
    if (seen.has(packId)) continue;
    seen.add(packId);
    try {
      const raw = r2ManifestCache.get(packId) || readLocalManifest(packId);
      if (!raw?.scenes?.length) continue;
      const pack = packFromManifest(raw, raw.source || 'r2');
      const probed = await enrichMissingDurations(packId, pack.scenes, null);
      const withRef = (pack.scenes || []).filter(
        (s) => Number.isFinite(s.referenceDuration) && s.referenceDuration > 0.05
      ).length;
      if (probed === 0 && withRef === 0) {
        results.push({
          id: packId,
          scenes: pack.scenes.length,
          ok: true,
          skipped: true,
          reason: 'manifest-only, keine MP3-Probe',
        });
        continue;
      }
      const manifest = buildManifest(pack);
      rememberManifest(manifest);
      if (uploadToR2 && r2.isEnabled()) {
        await r2.putManifest(packId, manifest);
      }
      results.push({
        id: packId,
        scenes: pack.scenes.length,
        ok: true,
        probed,
        withRef,
        source: 'manifest',
      });
      console.log(
        `Pack-Dauern repariert (manifest): ${packId} (${withRef}/${pack.scenes.length}, +${probed} remote)`
      );
    } catch (err) {
      results.push({ id: packId, ok: false, error: err.message });
      console.warn(`Pack-Dauer-Repair fehlgeschlagen: ${packId}`, err.message);
    }
  }

  return results;
}

function slugifyPackId(name) {
  return (
    String(name || 'pack')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'pack'
  );
}

function packIdExists(id) {
  if (resolvePackDir(id)) return true;
  if (r2ManifestCache.has(id)) return true;
  if (readLocalManifest(id)) return true;
  return false;
}

function uniquePackId(baseName) {
  ensureUserPacksRoot();
  let id = slugifyPackId(baseName);
  if (!packIdExists(id)) return id;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${id}-${i}`;
    if (!packIdExists(candidate)) return candidate;
  }
  return `${id}-${Date.now()}`;
}

module.exports = {
  loadPack,
  listPacks,
  listPackIds: listLocalPackIds,
  resolvePackDir,
  ensureUserPacksRoot,
  ensureMetaRoot,
  uniquePackId,
  slugifyPackId,
  buildManifest,
  saveLocalManifest,
  readLocalManifest,
  deleteLocalManifest,
  rememberManifest,
  refreshR2Manifests,
  repairPackDurations,
  setR2ManifestCache,
  BUNDLED_PACKS_ROOT,
  USER_PACKS_ROOT,
  META_ROOT,
  PACKS_ROOT: USER_PACKS_ROOT,
};
