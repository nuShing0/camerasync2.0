// What went wrong opening the camera, in words a person can act on, from the
// error the browser threw. `kind` says what can help: "busy" (another app
// has it), "blocked" (the browser or the computer won't allow it), "missing"
// (no camera, or the one picked is gone) or "other".
export function cameraProblem(err) {
  const name = err?.name || "";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      kind: "busy",
      message: "Your camera is being used by another app, like Zoom, Teams or FaceTime. "
        + "Close the camera there (or turn your video off in that call), then try again.",
    };
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return {
      kind: "blocked",
      message: "This browser isn't allowed to use your camera and microphone. "
        + "Allow them from the camera icon in the address bar (or your computer's privacy settings), then try again.",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return {
      kind: "missing",
      message: "No camera or microphone was found. Plug one in, then try again.",
    };
  }
  return {
    kind: "other",
    message: "Your camera couldn't be started. Try again in a moment.",
  };
}
