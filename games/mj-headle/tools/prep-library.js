#!/usr/bin/env node
/**
 * Prep MJ Headle library from a folder of already-named MP3s.
 *
 * - Cleans titles (strips Remaster / Radio Edit / Demo / …)
 * - Slugifies filenames → audio/<id>.mp3
 * - Drops duplicates (keeps best version per song)
 * - Writes catalog/songs.json
 * - Optionally runs cue detection
 *
 * Usage (on your machine, where the MP3s live):
 *   node tools/prep-library.js --in "/path/to/MJ Songs" --out data/audio --cues
 *
 * Dry-run (no copies):
 *   node tools/prep-library.js --in "/path/to/MJ Songs" --dry-run
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'audio');
const CATALOG_PATH = path.join(ROOT, 'catalog', 'songs.json');

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac']);

const VERSION_JUNK = [
  /\(.*?remaster.*?\)/gi,
  /\(.*?remastered.*?\)/gi,
  /\(.*?radio edit.*?\)/gi,
  /\(.*?single version.*?\)/gi,
  /\(.*?immortal.*?\)/gi,
  /\(.*?demo.*?\)/gi,
  /\(.*?original version.*?\)/gi,
  /\(.*?album version.*?\)/gi,
  /\(.*?extended.*?\)/gi,
  /\(.*?feat\..*?\)/gi,
  /\(.*?featuring.*?\)/gi,
  /\[.*?remaster.*?\]/gi,
  /\[.*?remastered.*?\]/gi,
  /\s*-\s*remastered.*$/gi,
  /\s*-\s*radio edit.*$/gi,
];

function parseArgs(argv) {
  const out = {
    inDir: null,
    outDir: DEFAULT_OUT,
    dryRun: false,
    cues: false,
    keepFixture: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.inDir = argv[++i];
    else if (a === '--out') out.outDir = path.resolve(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--cues') out.cues = true;
    else if (a === '--no-fixture') out.keepFixture = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function cleanTitle(filename) {
  let base = path.basename(filename, path.extname(filename));
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  for (const re of VERSION_JUNK) base = base.replace(re, '');
  base = base.replace(/\s+/g, ' ').trim();
  // drop trailing empty parens
  base = base.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  return base || path.basename(filename, path.extname(filename));
}

function versionScore(filename) {
  const n = filename.toLowerCase();
  let score = 100;
  if (/\bdemo\b/.test(n)) score -= 40;
  if (/\bimmortal\b/.test(n)) score -= 25;
  if (/\bradio edit\b/.test(n)) score -= 15;
  if (/\bextended\b/.test(n)) score -= 10;
  if (/\bremaster/.test(n)) score += 10; // prefer remastered masters
  if (/\boriginal version\b/.test(n)) score += 5;
  // prefer cleaner names (fewer parentheses)
  score -= (n.match(/\(/g) || []).length * 3;
  return score;
}

function listAudioFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      files.push(...listAudioFiles(full));
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    files.push(full);
  }
  return files;
}

function dedupe(files) {
  /** @type {Map<string, { file: string, title: string, id: string, score: number, size: number }>} */
  const best = new Map();
  const dropped = [];

  for (const file of files) {
    const title = cleanTitle(file);
    const id = slugify(title);
    if (!id) continue;
    const size = fs.statSync(file).size;
    const score = versionScore(path.basename(file));
    const cand = { file, title, id, score, size };
    const prev = best.get(id);
    if (!prev) {
      best.set(id, cand);
      continue;
    }
    const takeNew =
      cand.score > prev.score || (cand.score === prev.score && cand.size > prev.size);
    if (takeNew) {
      dropped.push({ kept: cand, dropped: prev, reason: 'better-version' });
      best.set(id, cand);
    } else {
      dropped.push({ kept: prev, dropped: cand, reason: 'duplicate' });
    }
  }

  return { kept: [...best.values()].sort((a, b) => a.title.localeCompare(b.title, 'en')), dropped };
}

function runCue(filePath) {
  try {
    const cueDetect = require('../server/cueDetect');
    return cueDetect.analyzeFile(filePath);
  } catch (err) {
    return { cueStartSec: 0, cueQuality: 'missing', reason: err.message || 'cue-failed' };
  }
}

function loadExistingFixture(keepFixture) {
  if (!keepFixture || !fs.existsSync(CATALOG_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    const songs = Array.isArray(raw) ? raw : raw.songs || [];
    return songs.filter((s) => s.id === 'thriller-fixture' || s.cueReason === 'fixture-onset');
  } catch {
    return [];
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.inDir) {
    console.log(`Usage:
  node tools/prep-library.js --in "/path/to/mp3-folder" [--out data/audio] [--cues] [--dry-run]

Example:
  node tools/prep-library.js --in "C:/Users/You/Music/MJ" --cues
`);
    process.exit(args.help ? 0 : 1);
  }

  const inDir = path.resolve(args.inDir);
  if (!fs.existsSync(inDir)) {
    console.error('Input folder not found:', inDir);
    process.exit(1);
  }

  const files = listAudioFiles(inDir);
  console.log(`Found ${files.length} audio files in ${inDir}`);
  const { kept, dropped } = dedupe(files);
  console.log(`Kept ${kept.length} unique songs, dropped ${dropped.length} duplicates`);

  if (dropped.length) {
    console.log('\nDropped duplicates:');
    for (const d of dropped.slice(0, 40)) {
      console.log(
        `  - ${path.basename(d.dropped.file)}  → keep ${path.basename(d.kept.file)}`
      );
    }
    if (dropped.length > 40) console.log(`  … +${dropped.length - 40} more`);
  }

  if (!args.dryRun) {
    fs.mkdirSync(args.outDir, { recursive: true });
  }

  const songs = [];
  for (const item of kept) {
    const ext = path.extname(item.file).toLowerCase() || '.mp3';
    const destName = `${item.id}${ext}`;
    const dest = path.join(args.outDir, destName);
    if (!args.dryRun) {
      fs.copyFileSync(item.file, dest);
    }

    let cueStartSec = 0;
    let cueQuality = 'missing';
    let cueReason = 'audio-pending';
    if (args.cues && !args.dryRun) {
      const analysis = runCue(dest);
      cueStartSec = analysis.cueStartSec || 0;
      cueQuality = analysis.cueQuality || 'weak';
      cueReason = analysis.reason || 'auto-onset';
      console.log(
        `  cue ${item.id}: ${cueStartSec}s (${cueQuality})`
      );
    }

    songs.push({
      id: item.id,
      title: item.title,
      artist: 'Michael Jackson',
      audioKey: `audio/${destName}`,
      cueStartSec,
      cueQuality,
      cueReason,
    });
  }

  const fixtures = loadExistingFixture(args.keepFixture);
  const catalog = { songs: [...fixtures, ...songs] };

  if (args.dryRun) {
    console.log('\nDry-run — catalog preview (first 15):');
    for (const s of songs.slice(0, 15)) {
      console.log(`  ${s.id}  ←  ${s.title}`);
    }
    console.log(`\nWould write ${songs.length} songs to ${CATALOG_PATH}`);
    console.log(`Would copy files to ${args.outDir}`);
    return;
  }

  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote catalog: ${CATALOG_PATH} (${catalog.songs.length} entries)`);
  console.log(`Audio copies: ${args.outDir}`);
  console.log(`
Next:
  1) Upload data/audio/* to R2 bucket lagga-mj-headle under prefix audio/
  2) Or keep local for now (server falls back to data/audio)
  3) Start game: npm run game -- mj-headle
`);
}

main();
