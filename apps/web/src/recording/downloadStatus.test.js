import { describe, expect, it } from "vitest";

import { downloadStatusText } from "./downloadStatus.js";

describe("downloadStatusText", () => {
  it("shows the percentage while the videos are lined up", () => {
    expect(downloadStatusText({ state: "working", progress: 0.427 }))
      .toBe("Lining up the videos… 42%");
  });

  it("says when other downloads are ahead in line", () => {
    expect(downloadStatusText({ state: "queued", progress: 0, waiting: 2 }))
      .toBe("Waiting for 2 other downloads to finish…");
  });

  it("passes the server's reason on when it fails", () => {
    expect(downloadStatusText({ state: "failed", error: "These angles don't overlap." }))
      .toBe("These angles don't overlap.");
  });

  it("has something to say before the server answers", () => {
    expect(downloadStatusText(null)).toBe("Getting your download ready…");
  });
});
