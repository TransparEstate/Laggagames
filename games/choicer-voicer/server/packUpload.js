const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const unzipper = require('unzipper');
const {
  ensureUserPacksRoot,
  uniquePackId,
  USER_PACKS_ROOT,
  loadPack,
  buildManifest,
  rememberManifest,
  deleteLocalManifest,
} = require('./packLoader');
const r2 = require('./r2');
const { ensureBrowserVideo } = require('./videoConvert');

function looksLikePackDir(dir) {
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir);
  const hasScenes = files.some((f) => /^\d+_.*\.txt$/i.test(f));
  const hasInfo = files.includes('_pack_info.ini');
  const hasVideo = files.some((f) => /^dub_video\.(mp4|webm|ogv)$/i.test(f));
  return hasScenes && (hasInfo || hasVideo);
}

async function findPackRoot(extractDir) {
  if (looksLikePackDir(extractDir)) return extractDir;
  const entries = await fsp.readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(extractDir, entry.name);
    if (looksLikePackDir(nested)) return nested;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(extractDir, entry.name);
    const inner = await fsp.readdir(nested, { withFileTypes: true });
    for (const child of inner) {
      if (!child.isDirectory()) continue;
      const deep = path.join(nested, child.name);
      if (looksLikePackDir(deep)) return deep;
    }
  }
  return null;
}

async function extractZipTo(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: destDir }))
    .promise();
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else await fsp.copyFile(from, to);
  }
}

async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

/**
 * Install a uploaded .zip voice pack into USER_PACKS_ROOT (+ optional R2).
 */
async function installPackFromZip(zipPath, originalName) {
  ensureUserPacksRoot();
  const workRoot = path.join(
    USER_PACKS_ROOT,
    '.tmp',
    `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const extractDir = path.join(workRoot, 'extract');

  try {
    await extractZipTo(zipPath, extractDir);
    const packRoot = await findPackRoot(extractDir);
    if (!packRoot) {
      throw new Error(
        'Kein gültiges Voicepack. Erwartet: _pack_info.ini und/oder dub_video.* plus NN_Character.txt Szenen.'
      );
    }

    let preferredName = path.basename(originalName || 'pack', path.extname(originalName || ''));
    const infoPath = path.join(packRoot, '_pack_info.ini');
    if (fs.existsSync(infoPath)) {
      const titleMatch = fs.readFileSync(infoPath, 'utf8').match(/title\s*=\s*"([^"]+)"/);
      if (titleMatch) preferredName = titleMatch[1];
    }

    const packId = uniquePackId(preferredName);
    const dest = path.join(USER_PACKS_ROOT, packId);
    await copyDir(packRoot, dest);

    // Chrome/Edge cannot play .ogv — convert to H.264 MP4 before listing/R2
    const converted = await ensureBrowserVideo(dest);
    if (!converted.ok && converted.error?.includes('ffmpeg')) {
      console.warn('Video-Konvertierung:', converted.error);
    } else if (!converted.ok) {
      console.warn('Video-Konvertierung:', converted.error);
    } else if (converted.converted) {
      console.log(
        `Pack ${packId}: ${converted.from} → dub_video.mp4` +
          (converted.profile ? ` [${converted.profile}]` : '')
      );
    }

    const pack = loadPack(packId);
    if (!pack.videoFile || pack.videoFile.endsWith('.ogv') || pack.videoFile.endsWith('.webm')) {
      const detail = converted?.error
        ? converted.error.slice(0, 280)
        : 'Unbekannter Fehler bei der Konvertierung.';
      throw new Error(
        `Video konnte nicht nach MP4 konvertiert werden (${pack.videoFile || 'kein Video'}). ${detail}`
      );
    }

    const manifest = buildManifest(pack);
    rememberManifest(manifest);

    let r2Status = { skipped: true };
    if (r2.isEnabled()) {
      await r2.uploadPackDirectory(packId, dest);
      await r2.putManifest(packId, manifest);
      r2Status = { ok: true };
      rememberManifest(manifest);

      // Optional: drop bulky local files after R2 mirror (Railway free disk)
      if (!r2.status().keepLocal) {
        await rmrf(dest);
      }
    }

    const refreshed = loadPack(packId);
    return {
      ok: true,
      r2: r2Status,
      pack: {
        id: refreshed.id,
        title: refreshed.title,
        iconUrl: refreshed.iconUrl,
        sceneCount: refreshed.scenes.length,
        characters: refreshed.characters,
        source: refreshed.source,
        sizeBytes: refreshed.sizeBytes,
        hasVideo: refreshed.hasVideo,
        mirroredToR2: !!refreshed.mirroredToR2 || r2Status.ok === true,
      },
    };
  } finally {
    await rmrf(workRoot);
    try {
      await fsp.unlink(zipPath);
    } catch {
      /* ignore */
    }
  }
}

async function deleteUserPack(packId) {
  const safe = String(packId || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe || safe !== packId) return { error: 'Ungültige Pack-ID.' };

  const bundled = path.join(__dirname, '..', 'assets', 'packs', safe);
  if (fs.existsSync(bundled)) {
    return { error: 'Mitgelieferte Packs können nicht gelöscht werden.' };
  }

  const dir = path.join(USER_PACKS_ROOT, safe);
  const hadLocal = fs.existsSync(dir);
  const hadMeta = !!require('./packLoader').readLocalManifest(safe);

  if (!hadLocal && !hadMeta && !r2.isEnabled()) {
    return { error: 'Pack nicht gefunden.' };
  }

  if (hadLocal) await rmrf(dir);
  deleteLocalManifest(safe);

  if (r2.isEnabled()) {
    await r2.deletePackPrefix(safe);
    try {
      await require('./packLoader').refreshR2Manifests();
    } catch {
      /* ignore */
    }
  }

  return { ok: true };
}

/**
 * Mirror local user packs into object storage so redeploys keep them.
 * Skips packs that already have a remote manifest.
 */
async function syncLocalPacksToRemote() {
  if (!r2.isEnabled()) return { skipped: true, synced: [] };
  ensureUserPacksRoot();
  const remoteIds = new Set(await r2.listPackIds());
  const synced = [];
  const failed = [];

  if (!fs.existsSync(USER_PACKS_ROOT)) {
    return { ok: true, synced, failed };
  }

  for (const entry of fs.readdirSync(USER_PACKS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packId = entry.name;
    const dest = path.join(USER_PACKS_ROOT, packId);
    if (remoteIds.has(packId)) {
      // Ensure manifest exists even if files were uploaded earlier without one
      try {
        const existing = await r2.getJson(r2.manifestKey(packId));
        if (existing?.id) continue;
      } catch {
        /* upload manifest below */
      }
    }
    try {
      const pack = loadPack(packId);
      const manifest = buildManifest(pack);
      rememberManifest(manifest);
      await r2.uploadPackDirectory(packId, dest);
      await r2.putManifest(packId, manifest);
      synced.push(packId);
      console.log(`Pack nach Object Storage gespiegelt: ${packId}`);
    } catch (err) {
      failed.push({ id: packId, error: err.message || String(err) });
      console.warn(`Spiegeln fehlgeschlagen: ${packId}`, err.message || err);
    }
  }

  return { ok: true, synced, failed };
}

module.exports = {
  installPackFromZip,
  deleteUserPack,
  looksLikePackDir,
  syncLocalPacksToRemote,
};
