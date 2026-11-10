// Where players fetch stored files (videos, their previews, thumbnails and
// seek-bar stills) from.
//
// With a CDN set up (CloudFront in front of the recordings bucket, see
// deploy/setup-cdn.sh), a file's link is a signed CloudFront URL: the bytes
// come from a server near the viewer instead of through this instance, and
// the link stops working after a while, so only someone this server gave it
// to (a member who can see the session) can use it. Without one, links go
// through /api/files/get as before, which checks the login on every request.
//
// Configuration (environment), all three or none:
//   CDN_URL                         e.g. https://d1234abcd.cloudfront.net
//   CLOUDFRONT_KEY_PAIR_ID          the public key's id in CloudFront
//   CLOUDFRONT_PRIVATE_KEY_BASE64   its private key (PEM), base64-encoded
// Only used with STORAGE_DRIVER=s3; the files' keys get S3_KEY_PREFIX.

import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

// Links are good for at least this long...
const VALID_FOR_MS = 12 * 60 * 60 * 1000;
// ...and stay the same within each window this long, so a list refreshed
// every few seconds hands out the same link (a player given a new one would
// load the video again).
const WINDOW_MS = 6 * 60 * 60 * 1000;

function cdnConfig(env = process.env) {
  const base = env.CDN_URL?.replace(/\/+$/, "");
  const keyPairId = env.CLOUDFRONT_KEY_PAIR_ID;
  const encodedKey = env.CLOUDFRONT_PRIVATE_KEY_BASE64;
  if (env.STORAGE_DRIVER !== "s3" || !base || !keyPairId || !encodedKey) return null;
  const prefix = (env.S3_KEY_PREFIX ?? "recordings/").replace(/^\/+/, "");
  return {
    base,
    keyPairId,
    privateKey: Buffer.from(encodedKey, "base64").toString("utf8"),
    prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
  };
}

let config = cdnConfig();

// For tests: read the configuration again from [env].
export function configureCdn(env) {
  config = cdnConfig(env);
}

export function cdnEnabled() {
  return config !== null;
}

// The link players use for one stored file.
export function fileUrl(fileId, now = Date.now()) {
  if (!config) return `/api/files/get/${fileId}`;
  const expires = Math.floor(now / WINDOW_MS) * WINDOW_MS + WINDOW_MS + VALID_FOR_MS;
  return getSignedUrl({
    url: `${config.base}/${config.prefix}${fileId}`,
    keyPairId: config.keyPairId,
    privateKey: config.privateKey,
    dateLessThan: new Date(expires).toISOString(),
  });
}
