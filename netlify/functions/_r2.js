// netlify/functions/_r2.js
// -----------------------------------------------------------------------------
// Storage abstraction over Cloudflare R2 (S3-compatible).
//
// EVERYTHING that touches storage goes through this file, so swapping providers
// later (AWS S3, Backblaze B2, Supabase Storage, …) means editing only THIS module —
// the rest of the app talks in terms of listPlaylist / presignGet / presignPut.
//
// Required env vars (set in Netlify + local .env):
//   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// -----------------------------------------------------------------------------

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.R2_BUCKET;

function client() {
  return new S3Client({
    region: 'auto', // R2 ignores region but the SDK requires one
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

// List the audio objects under a party prefix. Sorted lexicographically by key
// (we prefix uploads with a timestamp, so this is effectively chronological).
async function listPlaylist(prefix) {
  const s3 = client();
  const out = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (out.Contents || [])
    .filter((o) => o.Key !== prefix && (o.Size || 0) > 0)
    .sort((a, b) => (a.Key < b.Key ? -1 : 1));
}

// Short-lived download link (browser fetches the file directly from R2; free egress).
function presignGet(key, expiresIn = 6 * 60 * 60) {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

// Short-lived upload link (host's browser PUTs the file straight to R2, bypassing
// Netlify's ~6 MB function-body limit).
function presignPut(key, contentType, expiresIn = 15 * 60) {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn }
  );
}

module.exports = { listPlaylist, presignGet, presignPut, BUCKET };
