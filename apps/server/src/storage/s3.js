// S3 storage driver: recordings are objects in one bucket, uploaded after
// validation and streamed back through the server on playback.
//
// Streaming through the server keeps cookie auth on every request. With a
// CDN set up, players instead get signed CloudFront links to the same
// objects (see cdn.js and deploy/setup-cdn.sh), and this only serves files
// to those still using /api/files/get.
//
// Configuration (environment):
//   S3_BUCKET             required
//   AWS_REGION            default us-east-1
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
//                         picked up by the SDK's default credential chain; an
//                         EC2 instance role works too, so both are optional
//   S3_KEY_PREFIX         default "recordings/"
//   S3_ENDPOINT           for S3-compatible stores (MinIO in development)
//   S3_FORCE_PATH_STYLE   default true when S3_ENDPOINT is set

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

// S3 accepts at most this many keys per DeleteObjects call.
const DELETE_BATCH = 1000;

export function createS3Storage({ uploadDir }) {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3.");
  }

  const prefix = normalizePrefix(process.env.S3_KEY_PREFIX ?? "recordings/");
  const endpoint = process.env.S3_ENDPOINT || undefined;
  const client = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    ...(endpoint && {
      endpoint,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    }),
  });

  // multer still writes the upload to local disk first so the container
  // header can be sniffed before anything reaches the bucket.
  const incomingDir = path.join(uploadDir, "incoming");
  fs.mkdirSync(incomingDir, { recursive: true });

  const keyFor = (fileId) => `${prefix}${fileId}`;

  return {
    driver: "s3",
    incomingDir,

    describe: () =>
      `S3 bucket "${bucket}" (prefix "${prefix}"` +
      (endpoint ? `, endpoint ${endpoint})` : ")"),

    async check() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },

    // Multipart upload for anything over one part, so a 2 GB recording does
    // not have to be buffered. The temp file is removed either way.
    async put({ fileId, tempPath, contentType }) {
      const body = fs.createReadStream(tempPath);
      try {
        await new Upload({
          client,
          params: {
            Bucket: bucket,
            Key: keyFor(fileId),
            Body: body,
            ContentType: contentType,
          },
          partSize: 16 * 1024 * 1024,
          queueSize: 4,
          leavePartsOnError: false,
        }).done();
      } finally {
        body.destroy();
        await fsp.rm(tempPath, { force: true }).catch(() => {});
      }
    },

    // The stored object as a stream, for building a session download.
    async open(fileId) {
      const object = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: keyFor(fileId) })
      );
      return object.Body;
    },

    // Passes the player's Range header through to S3 and relays the 206 so
    // seeking works exactly as it did with sendFile.
    async serve(req, res, next, { fileId, contentType }) {
      let object;
      try {
        object = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: keyFor(fileId),
            ...(req.headers.range && { Range: req.headers.range }),
          })
        );
      } catch (err) {
        const status = err.$metadata?.httpStatusCode;
        if (err.name === "NoSuchKey" || err.name === "NotFound" || status === 404) {
          return res.status(404).json({ error: "File not found." });
        }
        if (err.name === "InvalidRange" || status === 416) {
          return res.status(416).json({ error: "Requested range not satisfiable." });
        }
        return next(err);
      }

      res.status(object.ContentRange ? 206 : 200);
      res.set({
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        ...(object.ContentLength != null && {
          "Content-Length": String(object.ContentLength),
        }),
        ...(object.ContentRange && { "Content-Range": object.ContentRange }),
        ...(object.ETag && { ETag: object.ETag }),
        ...(object.LastModified && {
          "Last-Modified": object.LastModified.toUTCString(),
        }),
      });

      const body = object.Body;
      body.on("error", (err) => {
        if (!res.headersSent) next(err);
        else res.destroy(err);
      });
      // A player that seeks away closes the response; stop pulling from S3.
      res.on("close", () => body.destroy());
      body.pipe(res);
    },

    async remove(fileIds) {
      for (let i = 0; i < fileIds.length; i += DELETE_BATCH) {
        const batch = fileIds.slice(i, i + DELETE_BATCH);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: batch.map((fileId) => ({ Key: keyFor(fileId) })),
              Quiet: true,
            },
          })
        );
      }
    },
  };
}

// "recordings" and "/recordings/" both become "recordings/"; "" stays "".
function normalizePrefix(prefix) {
  const trimmed = String(prefix).replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}
