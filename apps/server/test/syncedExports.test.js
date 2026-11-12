// Synced and grid downloads: where each angle is cut, the ffmpeg commands,
// and the cache on disk. No database or ffmpeg needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const EXPORT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "exports-test-"));
process.env.EXPORT_DIR = EXPORT_DIR;

vi.mock("../src/db/pool.js", () => ({ pool: { query: vi.fn() } }));

const {
  canCopy, exportKey, gridArgs, gridLayout, openExport, purgeExportsUsing,
  sweepExports, syncWindow, syncedAngleArgs,
} = await import("../src/recordings/syncedExports.js");

afterAll(() => fs.rmSync(EXPORT_DIR, { recursive: true, force: true }));

describe("syncWindow", () => {
  it("starts every angle when the last camera began, like the player", () => {
    // A real take's offsets: the +15 ms camera began last.
    const { skips } = syncWindow([
      { startOffsetMs: -955, duration: 60 },
      { startOffsetMs: 15, duration: 60 },
      { startOffsetMs: -325, duration: 60 },
    ]);
    expect(skips).toEqual([0.97, 0, 0.34]);
  });

  it("ends them together, when the first one stopped", () => {
    const { length } = syncWindow([
      { startOffsetMs: 0, duration: 30 },     // runs to 30 s
      { startOffsetMs: 500, duration: 28 },   // to 28.5 s: first to stop
      { startOffsetMs: 200, duration: 31 },
    ]);
    // Shared start 0.5 s, shared end 28.5 s.
    expect(length).toBe(28);
  });

  it("counts an angle without an offset as on time, as the player does", () => {
    expect(syncWindow([
      { startOffsetMs: null, duration: 10 },
      { startOffsetMs: 250, duration: 10 },
    ]).skips).toEqual([0.25, 0]);
  });

  it("gives up when the angles don't overlap", () => {
    expect(syncWindow([
      { startOffsetMs: 0, duration: 2 },
      { startOffsetMs: 2_000, duration: 10 },
    ])).toBeNull();
    expect(syncWindow([])).toBeNull();
  });
});

describe("syncedAngleArgs", () => {
  it("re-encodes from the exact frame when the start is cut", () => {
    const args = syncedAngleArgs("in.mov", "out.mp4", { skip: 0.97, length: 28 });
    // -ss before -i, and a real encoder, not a copy.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("0.97");
    expect(args[args.indexOf("-t") + 1]).toBe("28");
    expect(args).toContain("libx264");
    expect(args).not.toContain("copy");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("copies the angle that started last: only its end is cut", () => {
    const args = syncedAngleArgs("in.mp4", "out.mp4", { skip: 0, length: 28, copy: true });
    expect(args).not.toContain("-ss");
    expect(args[args.indexOf("-c") + 1]).toBe("copy");
    expect(args[args.indexOf("-t") + 1]).toBe("28");
  });

  it("keeps the sound when there is some", () => {
    expect(syncedAngleArgs("in.mp4", "out.mp4", { skip: 1, length: 2 })).toContain("0:a:0?");
  });
});

describe("canCopy", () => {
  it("copies only an uncut H.264 or HEVC angle", () => {
    expect(canCopy(0, "h264")).toBe(true);
    expect(canCopy(0, "hevc")).toBe(true);
    expect(canCopy(0.5, "h264")).toBe(false);
    // A laptop's VP9 doesn't go in an MP4 everyone can play.
    expect(canCopy(0, "vp9")).toBe(false);
  });
});

describe("gridLayout", () => {
  it("puts 4 landscape angles in a 2x2 1280x720 grid", () => {
    expect(gridLayout(4, false)).toMatchObject({ cols: 2, rows: 2, width: 1280, height: 720 });
  });

  it("centres a short last row", () => {
    const { cells, cellW } = gridLayout(3, false);
    expect(cells).toEqual([{ x: 0, y: 0 }, { x: cellW, y: 0 }, { x: cellW / 2, y: 360 }]);
  });

  it("uses tall cells for phones held upright", () => {
    expect(gridLayout(2, true)).toMatchObject({ cellW: 360, cellH: 640, width: 720, height: 640 });
  });

  it("never goes past 1920 on a side, with even sizes for the encoder", () => {
    for (let n = 1; n <= 16; n += 1) {
      for (const portrait of [false, true]) {
        const { width, height, cellW, cellH } = gridLayout(n, portrait);
        expect(width).toBeLessThanOrEqual(1920);
        expect(height).toBeLessThanOrEqual(1920);
        expect(cellW % 2 + cellH % 2).toBe(0);
      }
    }
  });
});

describe("gridArgs", () => {
  const window = { skips: [0.97, 0, 0.34], length: 28, portrait: false, audioFrom: 1 };

  it("cuts each input to the shared window", () => {
    const { args } = gridArgs(["a.mp4", "b.mp4", "c.mp4"], "grid.mp4", window);
    const inputs = args.reduce((list, arg, i) => (arg === "-i" ? [...list, i] : list), []);
    expect(inputs.map((i) => args.slice(i - 4, i))).toEqual([
      ["-ss", "0.97", "-t", "28"],
      ["-ss", "0", "-t", "28"],
      ["-ss", "0.34", "-t", "28"],
    ]);
  });

  it("letterboxes each angle into its cell and stacks them", () => {
    const { args } = gridArgs(["a.mp4", "b.mp4", "c.mp4"], "grid.mp4", window);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("force_original_aspect_ratio=decrease");
    expect(graph).toContain("xstack=inputs=3:layout=0_0|640_0|320_360:fill=black");
  });

  it("takes the sound from one angle only", () => {
    const { args } = gridArgs(["a.mp4", "b.mp4"], "grid.mp4", { ...window, skips: [0, 0] });
    expect(args.filter((arg) => /^\d+:a:0$/.test(arg))).toEqual(["1:a:0"]);
    const silent = gridArgs(["a.mp4", "b.mp4"], "grid.mp4", { ...window, skips: [0, 0], audioFrom: null });
    expect(silent.args.some((arg) => /:a:/.test(arg))).toBe(false);
  });

  it("handles a single angle without xstack", () => {
    const { args } = gridArgs(["a.mp4"], "grid.mp4", { ...window, skips: [0] });
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("xstack");
  });
});

describe("exportKey", () => {
  const take = {
    angles: [
      { fileId: "a.mp4", startOffsetMs: -955 },
      { fileId: "b.mp4", startOffsetMs: 15 },
    ],
  };

  it("is the same for the same files and offsets, in any order", () => {
    expect(exportKey("synced", take)).toBe(
      exportKey("synced", { angles: [...take.angles].reverse() }));
  });

  it("changes with the kind, a better offset or a late angle", () => {
    const key = exportKey("synced", take);
    expect(exportKey("grid", take)).not.toBe(key);
    expect(exportKey("synced", { angles: [take.angles[0], { ...take.angles[1], startOffsetMs: 40 }] }))
      .not.toBe(key);
    expect(exportKey("synced", { angles: [...take.angles, { fileId: "c.mp4", startOffsetMs: 0 }] }))
      .not.toBe(key);
  });
});

describe("the export cache", () => {
  function cached(kind, take, { sources, bytes = 10, ageMs = 0 }) {
    const dir = path.join(EXPORT_DIR, exportKey(kind, take));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "grid.mp4"), Buffer.alloc(bytes));
    const manifest = path.join(dir, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ kind, file: "grid.mp4", length: 1, angles: [], sources }));
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(manifest, at, at);
    return dir;
  }

  it("serves a finished export and drops it when its recording is deleted", async () => {
    const take = { angles: [{ fileId: "x.mp4", previewFileId: "xp.mp4", startOffsetMs: 0 }] };
    const dir = cached("grid", take, { sources: ["x.mp4", "xp.mp4"] });
    const ready = await openExport("grid", take);
    expect(ready.file).toBe("grid.mp4");
    expect(fs.existsSync(ready.path(ready.file))).toBe(true);
    ready.release();

    await purgeExportsUsing(["xp.mp4"]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(await openExport("grid", take)).toBeNull();
  });

  it("sweeps old exports and half-made ones, but not one being sent", async () => {
    const old = cached("grid", { angles: [{ fileId: "old.mp4" }] }, { sources: [], ageMs: 100 * 3600_000 });
    const sending = { angles: [{ fileId: "sending.mp4" }] };
    const busy = cached("grid", sending, { sources: [], ageMs: 100 * 3600_000 });
    const half = path.join(EXPORT_DIR, "f".repeat(32));
    fs.mkdirSync(half, { recursive: true });
    const fresh = cached("grid", { angles: [{ fileId: "fresh.mp4" }] }, { sources: [] });

    const ready = await openExport("grid", sending);
    // Opening marks it used now; age it again to prove only the lock saves it.
    const at = new Date(Date.now() - 100 * 3600_000);
    fs.utimesSync(path.join(busy, "manifest.json"), at, at);
    await sweepExports();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(half)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(busy)).toBe(true);
    ready.release();
    await sweepExports();
    expect(fs.existsSync(busy)).toBe(false);
  });
});
