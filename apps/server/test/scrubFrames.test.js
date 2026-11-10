// The stills shown while the seek bar is dragged: their size, and that
// ffmpeg tiles them as the players expect. Needs ffmpeg for the second.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// Only the pure parts are tested here. Loading the real storage clears its
// folder of uploads in progress, which other test files are using.
vi.mock("../src/storage/index.js", () => ({ storage: {} }));
vi.mock("../src/db/pool.js", () => ({ pool: {} }));

const { COLS, ROWS, SCRUB_FPS, scrubArgs, tileSize } = await import("../src/recordings/scrubFrames.js");

let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

const dir = mkdtempSync(path.join(tmpdir(), "scrub-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("scrub frames", () => {
  it("keeps the shorter side at 144 and the shape", () => {
    expect(tileSize(1920, 1080)).toEqual({ width: 256, height: 144 });
    expect(tileSize(1080, 1920)).toEqual({ width: 144, height: 256 });
    expect(tileSize(640, 480)).toEqual({ width: 192, height: 144 });
  });

  it("tiles a sheet per COLS x ROWS frames", () => {
    if (!hasFfmpeg) return;
    const seconds = (COLS * ROWS) / SCRUB_FPS + 4; // a full sheet and a bit
    const video = path.join(dir, "in.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
      `testsrc=size=640x360:rate=30:duration=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", video]);
    const tile = tileSize(640, 360);
    execFileSync("ffmpeg", scrubArgs(video, path.join(dir, "sheet-%03d.jpg"), tile));
    const sheets = readdirSync(dir).filter((name) => name.startsWith("sheet-")).sort();
    expect(sheets).toEqual(["sheet-000.jpg", "sheet-001.jpg"]);
    const size = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height",
      "-of", "csv=p=0", path.join(dir, sheets[0])]).toString().trim();
    expect(size).toBe(`${tile.width * COLS},${tile.height * ROWS}`);
  });
});
