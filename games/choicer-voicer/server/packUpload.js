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

const PACK_INFO_NAME = '_pack_info.ini';
const MAX_PACK_SEARCH_DEPTH = 6;
const SCENE_TXT_RE = /^\d+_.*\.txt$/i;
const VIDEO_RE = /^dub_video\.(mp4|webm|ogv)$/i;

function isJunkName(name) {
  const n = String(name || '');
  return n === '__MACOSX' || n.startsWith('._') || n === '.DS_Store';
}

function listDirNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !isJunkName(f));
}

function findPackInfoFile(files) {
  return files.find((f) => f.toLowerCase() === PACK_INFO_NAME) || null;
}

function inspectPackDir(dir) {
  const files = listDirNames(dir);
  const infoFile = findPackInfoFile(files);
  const hasScenes = files.some((f) => SCENE_TXT_RE.test(f));
  const hasVideo = files.some((f) => VIDEO_RE.test(f));
  const hasInfo = !!infoFile;
  return {
    files,
    infoFile,
    hasScenes,
    hasInfo,
    hasVideo,
    ok: hasScenes && (hasInfo || hasVideo),
  };
}

function looksLikePackDir(dir) {
  return inspectPackDir(dir).ok;
}

/**
 * BFS for a pack root, skipping macOS junk folders. Max depth caps runaway trees.
 */
async function findPackRoot(extractDir) {
  const queue = [{ dir: extractDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (looksLikePackDir(dir)) return dir;
    if (depth >= MAX_PACK_SEARCH_DEPTH) continue;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isJunkName(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

function describePackFailure(extractDir) {
  const queue = [{ dir: extractDir, depth: 0 }];
  let best = null;
  let deepestSeen = 0;

  while (queue.length) {
    const { dir, depth } = queue.shift();
    deepestSeen = Math.max(deepestSeen, depth);
    const info = inspectPackDir(dir);
    const score =
      (info.hasInfo ? 4 : 0) + (info.hasVideo ? 2 : 0) + (info.hasScenes ? 3 : 0);
    if (!best || score > best.score) {
      best = { dir, depth, score, info };
    }
    if (depth >= MAX_PACK_SEARCH_DEPTH) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isJunkName(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  if (!best || best.score === 0) {
    return (
      'Kein gültiges Voicepack gefunden. Erwartet im Pack-Ordner: ' +
      '_pack_info.ini und/oder dub_video.* sowie Szenen-Dateien wie 01_Character.txt.'
    );
  }

  const { info, depth } = best;
  if (info.hasInfo || info.hasVideo) {
    if (!info.hasScenes) {
      return (
        'Pack-Info/Video gefunden, aber keine Szenen-Dateien (Muster: 01_Character.txt) ' +
        'im gleichen Ordner. Liegen die .txt-Dateien in einem Unterordner oder anders benannt?'
      );
    }
  }
  if (info.hasScenes && !info.hasInfo && !info.hasVideo) {
    return (
      'Szenen gefunden, aber weder _pack_info.ini noch dub_video.mp4/webm/ogv im gleichen Ordner.'
    );
  }
  if (depth >= MAX_PACK_SEARCH_DEPTH) {
    return (
      `Pack-Inhalt steckt zu tief verschachtelt (max. ${MAX_PACK_SEARCH_DEPTH} Ordnerebenen). ` +
      'ZIP/RAR so packen, dass der Pack-Ordner näher an der Archive-Wurzel liegt.'
    );
  }
  return (
    'Kein gültiges Voicepack. Erwartet: _pack_info.ini und/oder dub_video.* plus NN_Character.txt Szenen.'
  );
}

function normalizeArchiveEntryPath(entryPath) {
  return String(entryPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
}

async function extractZipTo(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    const rel = normalizeArchiveEntryPath(entry.path);
    if (!rel || rel.split('/').some(isJunkName)) {
      entry.autodrain();
      continue;
    }
    const outPath = path.join(destDir, rel);
    if (entry.type === 'Directory') {
      await fsp.mkdir(outPath, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await new Promise((resolve, reject) => {
      entry
        .stream()
        .pipe(fs.createWriteStream(outPath))
        .on('error', reject)
        .on('finish', resolve);
    });
  }
}

async function extractRarTo(rarPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const { createExtractorFromFile } = require('node-unrar-js');
  let extractor;
  try {
    extractor = await createExtractorFromFile({
      filepath: rarPath,
      targetPath: destDir,
      filenameTransform: (filename) => normalizeArchiveEntryPath(filename),
    });
  } catch (e) {
    throw new Error(
      `RAR konnte nicht gelesen werden: ${e.message || e}. ` +
        'Mehrteilige (.part2.rar) oder passwortgeschützte Archive werden nicht unterstützt.'
    );
  }
  // Generators are lazy — must fully iterate to extract to disk.
  const list = extractor.getFileList();
  // eslint-disable-next-line no-unused-vars
  for (const _ of list.fileHeaders) {
    /* drain headers */
  }
  const extracted = extractor.extract();
  for (const file of extracted.files) {
    const name = file?.fileHeader?.name || '';
    if (name.split(/[/\\]/).some(isJunkName)) continue;
  }
}

function detectArchiveKind(filePath, originalName) {
  const name = String(originalName || filePath || '').toLowerCase();
  if (name.endsWith('.rar')) return 'rar';
  if (name.endsWith('.zip')) return 'zip';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // PK
    if (n >= 7 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72) return 'rar'; // Rar!
  } catch {
    /* ignore */
  }
  return null;
}

async function extractArchiveTo(archivePath, destDir, originalName) {
  const kind = detectArchiveKind(archivePath, originalName);
  if (kind === 'rar') {
    await extractRarTo(archivePath, destDir);
    return kind;
  }
  if (kind === 'zip') {
    await extractZipTo(archivePath, destDir);
    return kind;
  }
  throw new Error('Nur .zip oder .rar Voicepacks werden unterstützt.');
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (isJunkName(entry.name)) continue;
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
 * Stable SHA-256 over sorted relative paths + file bytes (after convert).
 */
async function hashPackDirectory(packDir) {
  const files = [];
  const walk = async (dir, base) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || isJunkName(entry.name)) continue;
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

/**
 * Install an uploaded .zip / .rar voice pack into USER_PACKS_ROOT (+ R2).
 */
async function installPackFromArchive(archivePath, originalName) {
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
    await extractArchiveTo(archivePath, extractDir, originalName);
    const packRoot = await findPackRoot(extractDir);
    if (!packRoot) {
      throw new Error(describePackFailure(extractDir));
    }

    let preferredName = path.basename(originalName || 'pack', path.extname(originalName || ''));
    const packFiles = listDirNames(packRoot);
    const infoName = findPackInfoFile(packFiles);
    if (infoName) {
      const infoPath = path.join(packRoot, infoName);
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
      await fsp.unlink(archivePath);
    } catch {
      /* ignore */
    }
  }
}

/** @deprecated use installPackFromArchive */
async function installPackFromZip(zipPath, originalName) {
  return installPackFromArchive(zipPath, originalName);
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
  installPackFromArchive,
  deleteUserPack,
  looksLikePackDir,
  inspectPackDir,
  findPackRoot,
  describePackFailure,
  detectArchiveKind,
  extractArchiveTo,
  syncLocalPacksToRemote,
  hashPackDirectory,
};
