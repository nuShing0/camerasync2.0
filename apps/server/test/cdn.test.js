// File links: through /api/files/get without a CDN, signed CloudFront links
// with one (see src/storage/cdn.js).
import { generateKeyPairSync } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { cdnEnabled, configureCdn, fileUrl } from "../src/storage/cdn.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
const env = {
  STORAGE_DRIVER: "s3",
  CDN_URL: "https://d123.cloudfront.net/",
  CLOUDFRONT_KEY_PAIR_ID: "K2EXAMPLE",
  CLOUDFRONT_PRIVATE_KEY_BASE64: Buffer.from(pem).toString("base64"),
};

afterAll(() => configureCdn(process.env));

describe("file links", () => {
  it("go through the server without a CDN", () => {
    configureCdn({});
    expect(cdnEnabled()).toBe(false);
    expect(fileUrl("abc.mp4")).toBe("/api/files/get/abc.mp4");
    // Half set up is the same as not set up.
    configureCdn({ ...env, CLOUDFRONT_KEY_PAIR_ID: "" });
    expect(fileUrl("abc.mp4")).toBe("/api/files/get/abc.mp4");
  });

  it("are signed CloudFront links with one, under the key prefix", () => {
    configureCdn(env);
    expect(cdnEnabled()).toBe(true);
    const url = new URL(fileUrl("abc.mp4", Date.UTC(2026, 9, 29, 13)));
    expect(`${url.origin}${url.pathname}`).toBe("https://d123.cloudfront.net/recordings/abc.mp4");
    expect(url.searchParams.get("Key-Pair-Id")).toBe("K2EXAMPLE");
    expect(url.searchParams.get("Signature")).toBeTruthy();
    // Good for 12 to 18 hours.
    const expires = Number(url.searchParams.get("Expires")) * 1000;
    expect(expires - Date.UTC(2026, 9, 29, 13)).toBeGreaterThanOrEqual(12 * 3600_000);
    expect(expires - Date.UTC(2026, 9, 29, 13)).toBeLessThanOrEqual(18 * 3600_000);
  });

  it("stay the same for hours, so players aren't handed a new one on every refresh", () => {
    configureCdn(env);
    const at = Date.UTC(2026, 9, 29, 13);
    expect(fileUrl("abc.mp4", at)).toBe(fileUrl("abc.mp4", at + 3600_000));
  });
});
