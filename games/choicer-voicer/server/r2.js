const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function accessKeyId() {
  return env('R2_ACCESS_KEY_ID') || env('AWS_ACCESS_KEY_ID');
}

function secretAccessKey() {
  return env('R2_SECRET_ACCESS_KEY') || env('AWS_SECRET_ACCESS_KEY');
}

function bucket() {
  return env('R2_BUCKET') || env('AWS_S3_BUCKET_NAME') || env('BUCKET');
}

function endpoint() {
  const custom = env('R2_ENDPOINT') || env('AWS_ENDPOINT_URL');
  if (custom) return custom.replace(/\/$/, '');
  const accountId = env('R2_ACCOUNT_ID');
  if (accountId) return `https://${accountId}.r2.cloudflarestorage.com`;
  return '';
}

function region() {
  return env('R2_REGION') || env('AWS_DEFAULT_REGION') || env('AWS_REGION') || 'auto';
}

function isEnabled() {
  return !!(accessKeyId() && secretAccessKey() && bucket() && endpoint());
}

let client = null;

function getClient() {
  if (!isEnabled()) return null;
  if (client) return client;
  const ep = endpoint();
  // Default: virtual-hosted (Railway + Cloudflare). Only force path-style if explicitly set.
  const forcePathStyle = env('R2_FORCE_PATH_STYLE') === '1';
  client = new S3Client({
    region: region(),
    endpoint: ep,
    forcePathStyle,
    credentials: {
      accessKeyId: accessKeyId(),
      secretAccessKey: secretAccessKey(),
    },
  });
  return client;
}

function publicBaseUrl() {
  return env('R2_PUBLIC_BASE_URL').replace(/\/$/, '');
}

function packKey(packId, relativePath = '') {
  const rel = String(relativePath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return rel ? `packs/${packId}/${rel}` : `packs/${packId}`;
}

function manifestKey(packId) {
  return packKey(packId, '_cv_manifest.json');
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.ogv': 'video/ogg',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.json': 'application/json',
      '.txt': 'text/plain; charset=utf-8',
      '.ini': 'text/plain; charset=utf-8',
    }[ext] || 'application/octet-stream'
  );
}

async function putBuffer(key, body, contentType) {
  const s3 = getClient();
  if (!s3) throw new Error('Object-Storage ist nicht konfiguriert.');
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    })
  );
}

async function uploadFile(key, filePath) {
  const s3 = getClient();
  if (!s3) throw new Error('Object-Storage ist nicht konfiguriert.');
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket(),
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentTypeFor(filePath),
    },
    queueSize: 3,
    partSize: 16 * 1024 * 1024,
  });
  await upload.done();
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function uploadPackDirectory(packId, packDir) {
  if (!isEnabled()) return { skipped: true };
  const files = walkFiles(packDir);
  for (const rel of files) {
    const abs = path.join(packDir, rel);
    const key = packKey(packId, rel.replace(/\\/g, '/'));
    await uploadFile(key, abs);
  }
  return { ok: true, fileCount: files.length };
}

async function putManifest(packId, manifest) {
  if (!isEnabled()) return { skipped: true };
  const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  await putBuffer(manifestKey(packId), body, 'application/json');
  return { ok: true };
}

async function getObject(key, { range } = {}) {
  const s3 = getClient();
  if (!s3) return null;
  try {
    return await s3.send(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ...(range ? { Range: range } : {}),
      })
    );
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function getObjectStream(key) {
  return getObject(key);
}

async function getJson(key) {
  const res = await getObjectStream(key);
  if (!res?.Body) return null;
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function headObject(key) {
  const s3 = getClient();
  if (!s3) return null;
  try {
    return await s3.send(
      new HeadObjectCommand({
        Bucket: bucket(),
        Key: key,
      })
    );
  } catch {
    return null;
  }
}

async function listPackIds() {
  if (!isEnabled()) return [];
  const s3 = getClient();
  const ids = new Set();
  let token;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: 'packs/',
        Delimiter: '/',
        ContinuationToken: token,
      })
    );
    for (const p of res.CommonPrefixes || []) {
      const m = String(p.Prefix || '').match(/^packs\/([^/]+)\//);
      if (m && !m[1].startsWith('.') && !m[1].startsWith('_')) ids.add(m[1]);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return [...ids];
}

async function listManifests() {
  if (!isEnabled()) return [];
  const ids = await listPackIds();
  const out = [];
  for (const id of ids) {
    try {
      const manifest = await getJson(manifestKey(id));
      if (manifest?.id) out.push(manifest);
    } catch {
      /* skip broken */
    }
  }
  return out;
}

async function deletePackPrefix(packId) {
  if (!isEnabled()) return { skipped: true };
  const s3 = getClient();
  const prefix = `packs/${packId}/`;
  let token;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    const objects = (listed.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: objects },
        })
      );
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return { ok: true };
}


function contentHashKey(contentHash) {
  const hash = String(contentHash || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (!hash) throw new Error('Ungültiger Content-Hash.');
  return `packs/_index/by-hash/${hash}.json`;
}

async function getPackIdByContentHash(contentHash) {
  if (!isEnabled()) return null;
  try {
    const data = await getJson(contentHashKey(contentHash));
    return data?.packId || null;
  } catch {
    return null;
  }
}

async function putContentHashIndex(contentHash, packId) {
  if (!isEnabled()) return { skipped: true };
  const body = Buffer.from(
    JSON.stringify({ packId, contentHash, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  await putBuffer(contentHashKey(contentHash), body, 'application/json');
  return { ok: true };
}

async function deleteContentHashIndex(contentHash) {
  if (!isEnabled() || !contentHash) return { skipped: true };
  const s3 = getClient();
  try {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: [{ Key: contentHashKey(contentHash) }] },
      })
    );
  } catch {
    /* ignore */
  }
  return { ok: true };
}

function status() {
  return {
    enabled: isEnabled(),
    bucket: isEnabled() ? bucket() : null,
    endpoint: isEnabled() ? endpoint() : null,
    publicBaseUrl: publicBaseUrl() || null,
    keepLocal: env('R2_KEEP_LOCAL', '0') !== '0',
  };
}

module.exports = {
  isEnabled,
  status,
  publicBaseUrl,
  packKey,
  manifestKey,
  contentHashKey,
  uploadPackDirectory,
  putManifest,
  getObject,
  getObjectStream,
  getJson,
  headObject,
  listPackIds,
  listManifests,
  deletePackPrefix,
  getPackIdByContentHash,
  putContentHashIndex,
  deleteContentHashIndex,
  contentTypeFor,
};
