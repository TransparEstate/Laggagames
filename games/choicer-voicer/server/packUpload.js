const fs = require('fs');
const crypto = require('crypto');
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

/**
 * Stable SHA-256 over sorted relative paths + file bytes (after convert).
 */
async function hashPackDirectory(packDir) {
  const files = [];
  const walk = async (dir, base) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, base);
      else files.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  };
  await walk(packDir, packDir);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fsp.readFile(path.join(packDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function installPackFromZip(zipPath, originalName) {
  if (!r2.isEnabled()) {
    throw new Error(
      'Cloudflare R2 ist nicht konfiguriert. Packs werden nur in R2 gespeichert — setze R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY und R2_BUCKET.'
    );
  }
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

    // Stage under temp id, convert, then dedupe by content hash before assigning final id.
    const stagingId = `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dest = path.join(USER_PACKS_ROOT, stagingId);
    await copyDir(packRoot, dest);

    // Chrome/Edge cannot play .ogv — convert to H.264 MP4 before listing/R2
    const converted = await ensureBrowserVideo(dest);
    if (!converted.ok && converted.error?.includes('ffmpeg')) {
      console.warn('Video-Konvertierung:', converted.error);
    } else if (!converted.ok) {
      console.warn('Video-Konvertierung:', converted.error);
    } else if (converted.converted) {
      console.log(
        `Pack staging: ${converted.from} → dub_video.mp4` +
          (converted.profile ? ` [${converted.profile}]` : '')
      );
    }

    // Validate video via directory load (staging folder name is not a public pack id)
    const stagingPack = loadPack(stagingId);
    if (!stagingPack.videoFile || stagingPack.videoFile.endsWith('.ogv') || stagingPack.videoFile.endsWith('.webm')) {
      const detail = converted?.error
        ? converted.error.slice(0, 280)
        : 'Unbekannter Fehler bei der Konvertierung.';
      throw new Error(
        `Video konnte nicht nach MP4 konvertiert werden (${stagingPack.videoFile || 'kein Video'}). ${detail}`
      );
    }

    const contentHash = await hashPackDirectory(dest);
    const existingId = await r2.getPackIdByContentHash(contentHash);
    if (existingId) {
      await rmrf(dest);
      try {
        await require('./packLoader').refreshR2Manifests();
      } catch {
        /* ignore */
      }
      let existing;
      try {
        existing = loadPack(existingId);
      } catch {
        const remote = await r2.getJson(r2.manifestKey(existingId));
        if (!remote?.id) throw new Error(`Duplikat-Pack ${existingId} nicht in R2 gefunden.`);
        require('./packLoader').rememberManifest(remote);
        existing = loadPack(existingId);
      }
      return {
        ok: true,
        duplicate: true,
        r2: { ok: true, deduped: true },
        pack: {
          id: existing.id,
          title: existing.title,
          iconUrl: existing.iconUrl,
          sceneCount: existing.scenes.length,
          characters: existing.characters,
          source: existing.source,
          sizeBytes: existing.sizeBytes,
          hasVideo: existing.hasVideo,
          mirroredToR2: true,
          contentHash,
        },
      };
    }

    const packId = uniquePackId(preferredName);
    const finalDest = path.join(USER_PACKS_ROOT, packId);
    await fsp.rename(dest, finalDest);

    const pack = loadPack(packId);
    pack.contentHash = contentHash;
    const manifest = buildManifest(pack);
    rememberManifest(manifest);

    await r2.uploadPackDirectory(packId, finalDest);
    await r2.putManifest(packId, manifest);
    await r2.putContentHashIndex(contentHash, packId);
    rememberManifest(manifest);

    // Local disk is staging only — packs live exclusively in Cloudflare R2
    await rmrf(finalDest);

    const refreshed = loadPack(packId);
    return {
      ok: true,
      duplicate: false,
      r2: { ok: true },
      pack: {
        id: refreshed.id,
        title: refreshed.title,
        iconUrl: refreshed.iconUrl,
        sceneCount: refreshed.scenes.length,
        characters: refreshed.characters,
        source: refreshed.source,
        sizeBytes: refreshed.sizeBytes,
        hasVideo: refreshed.hasVideo,
        mirroredToR2: true,
        contentHash,
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
  const localMeta = require('./packLoader').readLocalManifest(safe);
  const hadMeta = !!localMeta;

  if (!hadLocal && !hadMeta && !r2.isEnabled()) {
    return { error: 'Pack nicht gefunden.' };
  }

  let contentHash = localMeta?.contentHash || null;
  if (!contentHash && r2.isEnabled()) {
    try {
      const remote = await r2.getJson(r2.manifestKey(safe));
      contentHash = remote?.contentHash || null;
    } catch {
      /* ignore */
    }
  }

  if (hadLocal) await rmrf(dir);
  deleteLocalManifest(safe);

  if (r2.isEnabled()) {
    await r2.deletePackPrefix(safe);
    if (contentHash) {
      try {
        await r2.deleteContentHashIndex(contentHash);
      } catch {
        /* ignore */
      }
    }
    try {
      await require('./packLoader').refreshR2Manifests();
    } catch {
      /* ignore */
    }
  }

  return { ok: true };
}


async function syncLocalPacksToRemote() {
  // Local disk is ephemeral staging only — Cloudflare R2 is the sole pack store.
  // Existing R2 packs are loaded via refreshR2Manifests on boot / GET /api/packs.
  return { skipped: true, synced: [], note: 'R2-only: kein lokales Spiegeln' };
}


module.exports = {
  installPackFromZip,
  deleteUserPack,
  looksLikePackDir,
  syncLocalPacksToRemote,
  hashPackDirectory,
};
