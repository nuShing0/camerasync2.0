// What went wrong opening the camera, in words a person can act on, from the
// error the browser threw. `kind` says what can help: "busy" (another app
// has it), "blocked" (the browser or the computer won't allow it), "missing"
// (no camera, or the one picked is gone) or "other".
export function cameraProblem(err) {
  const name = err?.name || "";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      kind: "busy",
      message: "Another app is using your camera. Turn it off there, then try again.",
    };
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return {
      kind: "blocked",
      message: "Camera and microphone are blocked. Allow them in the address bar, then try again.",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return {
      kind: "missing",
      message: "No camera or microphone found.",
    };
  }
  return {
    kind: "other",
    message: "The camera couldn't start. Try again.",
  };
}
