// File storage abstraction for portal uploads (proofs of sale, documents, photos).
//
// Uses Cloudflare R2 (S3-compatible) in production when the R2_* env vars are set;
// otherwise falls back to local disk under UPLOAD_DIR for local dev. The opaque ref
// returned by putDataUrl() is what gets stored in the DB:
//   • R2:    "r2:uploads/<name>"
//   • local: "./uploads/<name>"
// getFile() resolves either form back to { buffer, contentType } for serving, and is
// the single place the path-traversal / key-confinement guard lives.
//
// The @aws-sdk/client-s3 import is dynamic so local dev (no R2 configured) never needs
// the SDK loaded — only the R2 code path pulls it in.
import { writeFile, readFile, mkdir } from 'fs/promises';
import path from 'path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const UPLOAD_PREFIX = 'uploads';            // R2 key namespace (also the local dir name)
const EXT_BY_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

export function r2Configured() {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

let _client = null;
export async function r2Client() {
  if (_client) return _client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  return _client;
}

function extFor(mediaType) {
  return EXT_BY_TYPE[mediaType] || (mediaType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
}
function guessType(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' })[ext] || 'application/octet-stream';
}

// Decode + store a base64 data URL under a logical prefix (e.g. a trailer id, "doc",
// "claim-WC-5001"). Returns the opaque DB ref, or null if the input isn't a data URL.
// Pass { maxBytes, tooLargeMsg } to enforce a size cap (throws when exceeded).
export async function putDataUrl(prefix, dataUrl, opts = {}) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const mediaType = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (opts.maxBytes && buf.length > opts.maxBytes) throw new Error(opts.tooLargeMsg || 'File is too large.');
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${extFor(mediaType)}`;

  if (r2Configured()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const Key = `${UPLOAD_PREFIX}/${name}`;
    await (await r2Client()).send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key, Body: buf, ContentType: mediaType }));
    return `r2:${Key}`;
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  await writeFile(path.join(UPLOAD_DIR, name), buf);
  return `${UPLOAD_DIR}/${name}`;
}

// Resolve a stored ref back to { buffer, contentType }, or null if missing/invalid.
// This is the trust boundary: R2 keys are confined to the uploads/ namespace and local
// paths are confined to UPLOAD_DIR, so a caller may safely pass a client-supplied ref.
export async function getFile(ref) {
  if (!ref || typeof ref !== 'string') return null;

  if (ref.startsWith('r2:')) {
    const key = ref.slice(3);
    if (key.includes('..') || !new RegExp(`^${UPLOAD_PREFIX}/[A-Za-z0-9._-]+$`).test(key)) return null;
    if (!r2Configured()) return null;
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const out = await (await r2Client()).send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
      const buffer = Buffer.from(await out.Body.transformToByteArray());
      return { buffer, contentType: out.ContentType || guessType(key) };
    } catch { return null; }
  }

  // Local path — confine to UPLOAD_DIR.
  const base = path.resolve(UPLOAD_DIR);
  const abs = path.resolve(ref);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  try { return { buffer: await readFile(abs), contentType: guessType(abs) }; }
  catch { return null; }
}
