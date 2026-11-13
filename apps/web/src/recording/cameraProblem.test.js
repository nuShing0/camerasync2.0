import { describe, expect, it } from "vitest";
import { cameraProblem } from "./cameraProblem.js";

const error = (name) => Object.assign(new Error("x"), { name });

describe("cameraProblem", () => {
  it("says another app has the camera", () => {
    expect(cameraProblem(error("NotReadableError")).kind).toBe("busy");
    expect(cameraProblem(error("TrackStartError")).kind).toBe("busy");
    expect(cameraProblem(error("NotReadableError")).message).toMatch(/another app/);
  });

  it("says the browser won't allow it", () => {
    expect(cameraProblem(error("NotAllowedError")).kind).toBe("blocked");
  });

  it("says there's no camera", () => {
    expect(cameraProblem(error("NotFoundError")).kind).toBe("missing");
    expect(cameraProblem(error("OverconstrainedError")).kind).toBe("missing");
  });

  it("falls back to trying again", () => {
    expect(cameraProblem(new Error("odd")).kind).toBe("other");
    expect(cameraProblem(undefined).kind).toBe("other");
  });
});
