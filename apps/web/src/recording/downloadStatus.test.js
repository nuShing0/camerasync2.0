import { describe, expect, it } from "vitest";

import { downloadStatusText } from "./downloadStatus.js";

describe("downloadStatusText", () => {
  it("shows the percentage while a recording is lined up", () => {
    expect(downloadStatusText("synced", { state: "working", progress: 0.427, ready: 0, total: 1 }))
      .toBe("Lining up the angles… 42%");
  });

  it("counts recordings for a whole session", () => {
    expect(downloadStatusText("grid", { state: "working", progress: 0.5, ready: 2, total: 4 }))
      .toBe("Building the grid… 50% (2 of 4 recordings done)");
  });

  it("says when other downloads are ahead in line", () => {
    expect(downloadStatusText("synced", { state: "queued", progress: 0, waiting: 2, ready: 0, total: 1 }))
      .toBe("Waiting for 2 other downloads to finish…");
  });

  it("passes the server's reason on when it fails", () => {
    expect(downloadStatusText("synced", { state: "failed", error: "These angles don't overlap." }))
      .toBe("These angles don't overlap.");
  });
});
