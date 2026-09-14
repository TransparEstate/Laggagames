#!/usr/bin/env node
/**
 * Upload a whole folder of MP3s to R2 bucket lagga-mj-headle under audio/.
 * Bypasses the Cloudflare dashboard 100-file limit.
 *
 * Setup once:
 *   - Copy games/mj-headle/.env.example → games/mj-headle/.env
 *   - Fill MJ_R2_ACCOUNT_ID, MJ_R2_ACCESS_KEY_ID, MJ_R2_SECRET_ACCESS_KEY
 *
 * Run (on your PC):
 *   node tools/upload-folder.js --in "C:/Users/You/Music/MJ"
 *
 * Optional:
 *   --prefix audio/          (default)
 *   --dry-run                list only
 *   --ext .mp3,.m4a,.wav
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function parseArgs(argv) {
  const out = {
    inDir: null,
    prefix: 'audio/',
    dryRun: false,
    skipExisting: true,
    exts: ['.mp3', '.m4a', '.ogg', '.wav', '.flac', '.aac'],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.inDir = argv[++i];
    else if (a === '--prefix') out.prefix = String(argv[++i] || 'audio/').replace(/\/?$/, '/');
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--overwrite') out.skipExisting = false;
    else if (a === '--ext') {
      out.exts = String(argv[++i] || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
        .map((x) => (x.startsWith('.') ? x : `.${x}`));
    } else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function listFiles(dir, exts) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFiles(full, exts));
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!exts.includes(ext)) continue;
    out.push(full);
  }
  return out;
}

function contentType(ext) {
  return (
    {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
    }[ext] || 'application/octet-stream'
  );
}

function clientFromEnv() {
  const accessKeyId = env('MJ_R2_ACCESS_KEY_ID') || env('R2_ACCESS_KEY_ID');
  const secretAccessKey = env('MJ_R2_SECRET_ACCESS_KEY') || env('R2_SECRET_ACCESS_KEY');
  const bucket = env('MJ_R2_BUCKET') || 'lagga-mj-headle';
  let endpoint = env('MJ_R2_ENDPOINT') || env('R2_ENDPOINT');
  const accountId = env('MJ_R2_ACCOUNT_ID') || env('R2_ACCOUNT_ID');
  if (!endpoint && accountId) endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error(
      'Missing R2 credentials. Set MJ_R2_ACCOUNT_ID, MJ_R2_ACCESS_KEY_ID, MJ_R2_SECRET_ACCESS_KEY in games/mj-headle/.env'
    );
  }
  const client = new S3Client({
    region: env('MJ_R2_REGION') || 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return { client, bucket };
}

async function exists(client, bucket, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.inDir) {
    console.log(`Usage:
  node tools/upload-folder.js --in "C:/path/to/MJ-folder"

Options:
  --prefix audio/     R2 key prefix (default audio/)
  --dry-run           only list files
  --overwrite         re-upload even if object exists
  --ext .mp3,.m4a     file extensions
`);
    process.exit(args.help ? 0 : 1);
  }

  const inDir = path.resolve(args.inDir);
  if (!fs.existsSync(inDir)) {
    console.error('Folder not found:', inDir);
    process.exit(1);
  }

  const files = listFiles(inDir, args.exts);
  console.log(`Found ${files.length} audio files in ${inDir}`);
  if (!files.length) process.exit(0);

  if (args.dryRun) {
    for (const f of files.slice(0, 20)) {
      console.log(`  ${args.prefix}${path.basename(f)}`);
    }
    if (files.length > 20) console.log(`  … +${files.length - 20} more`);
    console.log('Dry-run only — nothing uploaded.');
    return;
  }

  const { client, bucket } = clientFromEnv();
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const name = path.basename(file);
    const key = `${args.prefix}${name}`;
    const n = `[${i + 1}/${files.length}]`;

    try {
      if (args.skipExisting && (await exists(client, bucket, key))) {
        skipped += 1;
        console.log(`${n} skip (exists) ${key}`);
        continue;
      }
      const body = fs.readFileSync(file);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType(path.extname(name).toLowerCase()),
        })
      );
      uploaded += 1;
      console.log(`${n} ok ${key}`);
    } catch (err) {
      failed += 1;
      console.error(`${n} FAIL ${key}: ${err.message || err}`);
    }
  }

  console.log(`\nDone. uploaded=${uploaded} skipped=${skipped} failed=${failed} bucket=${bucket}`);
  console.log('Next: open MJ Headle and hit catalog sync (or restart the game server).');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
