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

function accessKeyId() {
  return env('MJ_R2_ACCESS_KEY_ID') || env('R2_ACCESS_KEY_ID') || env('AWS_ACCESS_KEY_ID');
}

function secretAccessKey() {
  return env('MJ_R2_SECRET_ACCESS_KEY') || env('R2_SECRET_ACCESS_KEY') || env('AWS_SECRET_ACCESS_KEY');
}

function bucket() {
  return env('MJ_R2_BUCKET') || 'lagga-mj-headle';
}

function endpoint() {
  const custom = env('MJ_R2_ENDPOINT') || env('R2_ENDPOINT') || env('AWS_ENDPOINT_URL');
  if (custom) return custom.replace(/\/$/, '');
  const accountId = env('MJ_R2_ACCOUNT_ID') || env('R2_ACCOUNT_ID');
  if (accountId) return `https://${accountId}.r2.cloudflarestorage.com`;
  return '';
}

function region() {
  return env('MJ_R2_REGION') || env('R2_REGION') || env('AWS_DEFAULT_REGION') || 'auto';
}

function isEnabled() {
  return !!(accessKeyId() && secretAccessKey() && bucket() && endpoint());
}

let client = null;

function getClient() {
  if (!isEnabled()) return null;
  if (client) return client;
  client = new S3Client({
    region: region(),
    endpoint: endpoint(),
    forcePathStyle: env('MJ_R2_FORCE_PATH_STYLE') === '1' || env('R2_FORCE_PATH_STYLE') === '1',
    credentials: {
      accessKeyId: accessKeyId(),
      secretAccessKey: secretAccessKey(),
    },
  });
  return client;
}

function publicBaseUrl() {
  return env('MJ_R2_PUBLIC_BASE_URL') || env('R2_PUBLIC_BASE_URL');
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
  const keys = [];
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
      if (obj.Key) keys.push(obj.Key);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
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

module.exports = {
  isEnabled,
  bucket,
  endpoint,
  publicBaseUrl,
  getObjectBuffer,
  headObject,
  listPrefix,
  putJson,
  status() {
    return {
      enabled: isEnabled(),
      bucket: bucket(),
      endpoint: endpoint() ? '[set]' : '',
      publicBaseUrl: publicBaseUrl() || '',
    };
  },
};
