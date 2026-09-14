const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

function env(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

/**
 * MJ Headle uses ONLY MJ_R2_* vars.
 * Plain R2_* belong to other apps (e.g. Choicer-Voicer) on the same Railway service
 * and must never leak into this client.
 */
function accessKeyId() {
  return env('MJ_R2_ACCESS_KEY_ID');
}

function secretAccessKey() {
  return env('MJ_R2_SECRET_ACCESS_KEY');
}

function bucket() {
  return env('MJ_R2_BUCKET') || 'lagga-mj-headle';
}

function accountId() {
  return env('MJ_R2_ACCOUNT_ID');
}

function endpoint() {
  const custom = env('MJ_R2_ENDPOINT');
  if (custom) return custom.replace(/\/$/, '');
  const id = accountId();
  if (id) return `https://${id}.r2.cloudflarestorage.com`;
  return '';
}

function region() {
  return env('MJ_R2_REGION') || 'auto';
}

function isEnabled() {
  return !!(accessKeyId() && secretAccessKey() && bucket() && endpoint());
}

let client = null;

function getClient() {
  if (!isEnabled()) return null;
  if (client) return client;
  // R2 expects path-style URLs; virtual-hosted style is flaky across SDK versions.
  const forcePathStyle = env('MJ_R2_FORCE_PATH_STYLE') !== '0';
  client = new S3Client({
    region: region(),
    endpoint: endpoint(),
    forcePathStyle,
    credentials: {
      accessKeyId: accessKeyId(),
      secretAccessKey: secretAccessKey(),
    },
  });
  return client;
}

function publicBaseUrl() {
  return env('MJ_R2_PUBLIC_BASE_URL');
}

async function getObjectBuffer(key) {
  const c = getClient();
  if (!c) return null;
  const out = await c.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return {
    buffer: Buffer.concat(chunks),
    contentType: out.ContentType || 'application/octet-stream',
  };
}

async function headObject(key) {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  } catch {
    return null;
  }
}

async function listPrefix(prefix) {
  const c = getClient();
  if (!c) return [];
  const objects = [];
  let token;
  do {
    const out = await c.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of out.Contents || []) {
      if (obj.Key) objects.push({ key: obj.Key, size: obj.Size || 0 });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function putJson(key, data) {
  const c = getClient();
  if (!c) throw new Error('R2 nicht konfiguriert.');
  await c.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
      ContentType: 'application/json',
    })
  );
}

/**
 * Live check: credentials alone are not enough — bucket must exist & be reachable.
 */
async function ping() {
  if (!isEnabled()) {
    return { ok: false, error: 'R2-Keys fehlen (MJ_R2_ACCOUNT_ID / ACCESS_KEY / SECRET / BUCKET).' };
  }
  try {
    const objects = await listPrefix('audio/');
    return {
      ok: true,
      bucket: bucket(),
      audioObjects: objects.filter((o) => o.key && !o.key.endsWith('/')).length,
    };
  } catch (err) {
    const msg = err?.message || String(err);
    let error = msg;
    if (/specified bucket does not exist/i.test(msg)) {
      error = `Bucket existiert nicht: "${bucket()}" — Railway: MJ_R2_BUCKET=lagga-mj-headle und MJ_R2_ACCOUNT_ID prüfen.`;
    } else if (/access denied|access key id you provided does not exist/i.test(msg)) {
      error = `R2 Auth fehlgeschlagen für Bucket "${bucket()}" — nur MJ_R2_* nutzen (nicht die R2_* von Choicer-Voicer).`;
    }
    return {
      ok: false,
      bucket: bucket(),
      error,
    };
  }
}

module.exports = {
  isEnabled,
  bucket,
  endpoint,
  accountId,
  publicBaseUrl,
  getObjectBuffer,
  headObject,
  listPrefix,
  putJson,
  ping,
  status() {
    return {
      enabled: isEnabled(),
      bucket: bucket(),
      endpoint: endpoint() ? '[set]' : '',
      publicBaseUrl: publicBaseUrl() || '',
    };
  },
};
