import { afterEach, describe, expect, it } from "vitest";
import {
  STALLED_AFTER_MS, clearProgress, progressFor, reportProgress, resetProgress,
} from "../src/recordings/uploadProgress.js";

afterEach(() => resetProgress());

describe("upload progress", () => {
  it("shows the latest report for an angle, clamped to 0..1", () => {
    reportProgress("s1", 1000, 7, "preview", 0.4, 0);
    reportProgress("s1", 1000, 7, "full", 1.7, 1000);
    expect(progressFor("s1", 1000, 7, 2000)).toEqual({ stage: "full", fraction: 1, stalled: false });
    expect(progressFor("s1", 1000, 8, 2000)).toBeNull();
  });

  it("marks an upload stalled when reports stop", () => {
    reportProgress("s1", 1000, 7, "full", 0.5, 0);
    expect(progressFor("s1", 1000, 7, STALLED_AFTER_MS + 1).stalled).toBe(true);
  });

  it("clears a stage once its file arrives, but not the next one", () => {
    reportProgress("s1", 1000, 7, "full", 0.2, 0);
    clearProgress("s1", 1000, 7, "preview");
    expect(progressFor("s1", 1000, 7, 0)).not.toBeNull();
    clearProgress("s1", 1000, 7);
    expect(progressFor("s1", 1000, 7, 0)).toBeNull();
  });
});
