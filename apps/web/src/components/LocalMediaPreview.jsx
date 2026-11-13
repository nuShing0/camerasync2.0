import { useEffect, useRef, useState } from "react";
import { cameraProblem } from "../recording/cameraProblem.js";

// The room as it sounds. Browsers default to call processing that cancels
// sound from this computer's own speakers, dulls music and pumps the volume.
const RECORDING_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

// The camera and microphone last picked, so the next session opens on them.
const DEVICES_KEY = "8kount.mediaDevices";

function savedDevices() {
  try {
    return JSON.parse(localStorage.getItem(DEVICES_KEY)) || {};
  } catch {
    return {};
  }
}

function saveDevices(cameraId, microphoneId) {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify({ cameraId, microphoneId }));
  } catch {
    // Private windows can refuse storage; the defaults still work.
  }
}

// True when the browser already allows both, so asking again would be a
// pointless extra click. Browsers that can't say (Firefox) get the prompt.
async function alreadyAllowed() {
  try {
    const [camera, microphone] = await Promise.all([
      navigator.permissions.query({ name: "camera" }),
      navigator.permissions.query({ name: "microphone" }),
    ]);
    return camera.state === "granted" && microphone.state === "granted";
  } catch {
    return false;
  }
}

// Once the browser allows the camera, sessions open straight on it (no
// prompt). The preview fills its box, with the camera's name on a chip and a
// settings button for picking the camera and microphone; `children` (the
// session's own controls) sit over the video too.
//
// When the camera can't start (another app such as Zoom has it, the browser
// blocks it, there's none) or stops partway, it says why and offers to try
// again, or `onControlOnly` (to run the session from here without
// recording) when given. It never leaves the session on its own; only
// Decline on the first prompt does.
export function LocalMediaPreview({ disabled, onReady, onDecline, onControlOnly, children }) {
  const videoRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [devices, setDevices] = useState([]);
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // Until we know whether the browser already allows the camera.
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Why the camera isn't on, when it couldn't start or stopped: { kind, message }.
  const [failure, setFailure] = useState(null);

  // puts the current stream in the local preview
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  // The camera or microphone stopping by itself (another app took it, it
  // was unplugged): say so, rather than sit on a frozen picture.
  useEffect(() => {
    if (!stream) return undefined;
    const lost = () => {
      setFailure({
        kind: "lost",
        message: "Your camera or microphone stopped. Another app may have taken it, "
          + "or it was unplugged. Close it there, then try again.",
      });
      setStream(null);
    };
    const tracks = stream.getTracks();
    tracks.forEach((track) => track.addEventListener("ended", lost));
    return () => tracks.forEach((track) => track.removeEventListener("ended", lost));
  }, [stream]);

  // turns off old camera and microphone tracks
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  // asks for the camera and microphone together
  const getMedia = async (
    nextCameraId,
    nextMicrophoneId,
    firstRequest = false
  ) => {
    setRequesting(true);
    setError("");

    // A remembered device is a preference (it may be unplugged); a device
    // picked from the list is required.
    const pick = (id) => (firstRequest ? { ideal: id } : { exact: id });
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: nextCameraId
          ? { deviceId: pick(nextCameraId) }
          : true,
        audio: nextMicrophoneId
          ? { deviceId: pick(nextMicrophoneId), ...RECORDING_AUDIO }
          : RECORDING_AUDIO,
      });

      let availableDevices = [];
      try {
        availableDevices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        // default devices still work without their names
      }

      setStream(nextStream);
      setDevices(availableDevices);
      setCameraId(nextCameraId);
      setMicrophoneId(nextMicrophoneId);
      if (!firstRequest) saveDevices(nextCameraId, nextMicrophoneId);
      setAccepted(true);
      setFailure(null);
      onReady(nextStream);
    } catch (err) {
      const problem = cameraProblem(err);
      // Starting (or starting again): say why, with a way forward. This
      // used to count as declining, which for the host ended the session.
      if (firstRequest || !stream) {
        setFailure(problem);
        return;
      }

      // Switching devices: the one already on keeps going.
      setError(problem.kind === "other" ? "Unable to switch to that device." : problem.message);
    } finally {
      setRequesting(false);
    }
  };

  const accept = () => {
    const saved = savedDevices();
    return getMedia(saved.cameraId || "", saved.microphoneId || "", true);
  };

  // Already allowed: start the camera without asking.
  useEffect(() => {
    let cancelled = false;
    alreadyAllowed().then((allowed) => {
      if (cancelled) return;
      if (allowed) accept().finally(() => { if (!cancelled) setChecking(false); });
      else setChecking(false);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // switches the local camera or microphone
  const changeCamera = (event) => {
    const nextCameraId = event.target.value;
    getMedia(nextCameraId, microphoneId);
  };

  const changeMicrophone = (event) => {
    const nextMicrophoneId = event.target.value;
    getMedia(cameraId, nextMicrophoneId);
  };

  const cameras = devices.filter((device) => device.kind === "videoinput");
  const microphones = devices.filter(
    (device) => device.kind === "audioinput"
  );

  // The camera's name for the chip: the one picked, or what the browser gave.
  const liveCameraId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  const cameraName = cameras.find((camera) => camera.deviceId === (cameraId || liveCameraId))?.label
    || stream?.getVideoTracks()[0]?.label || "";

  // Locked while a take runs, like the lists were.
  useEffect(() => { if (disabled) setSettingsOpen(false); }, [disabled]);

  if (!accepted && checking) {
    return <p className="local-media-note">Starting camera…</p>;
  }

  if (failure) {
    const tryAgain = () => (accepted
      ? getMedia(cameraId, microphoneId)
      : accept());
    return (
      <section className="media-permission media-failure" role="alert">
        <style>{mediaCss}</style>
        <h2>{failure.kind === "busy" ? "Your camera is in use" : "Camera unavailable"}</h2>
        <p>{failure.message}</p>
        <div>
          {onControlOnly && (
            <button type="button" onClick={onControlOnly} disabled={requesting}>
              Control only
            </button>
          )}
          <button className="media-accept-button" type="button" onClick={tryAgain}
            disabled={requesting}>
            {requesting ? "Starting camera..." : "Try again"}
          </button>
        </div>
        {onControlOnly && (
          <p className="local-media-note">
            Control only runs the session from here without this device recording.
          </p>
        )}
      </section>
    );
  }

  if (!accepted) {
    return (
      <section className="media-permission">
        <style>{mediaCss}</style>
        <h2>Camera and microphone access</h2>
        <p>
          This session needs access to your camera and microphone. You can
          choose different devices after joining.
        </p>
        <div>
          <button type="button" onClick={onDecline} disabled={requesting}>
            Decline
          </button>
          <button
            className="media-accept-button"
            type="button"
            onClick={accept}
            disabled={requesting}
          >
            {requesting ? "Requesting access..." : "Accept"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="local-media">
      <style>{mediaCss}</style>
      <video ref={videoRef} autoPlay muted playsInline />

      <span className="local-media-chip">
        This camera{cameraName && <> · {cameraName.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "")}</>}
      </span>

      {children}

      <button type="button" className="local-media-settings" aria-label="Camera and microphone"
        aria-expanded={settingsOpen} title={disabled ? "Available once this take has finished" : "Camera and microphone"}
        disabled={disabled} onClick={() => setSettingsOpen((open) => !open)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {settingsOpen && (
        <div className="local-media-devices" role="dialog" aria-label="Camera and microphone">
          <label>
            Camera
            <select
              value={cameraId}
              onChange={changeCamera}
              disabled={disabled || requesting}
            >
              <option value="">System default</option>
              {cameras.map((camera, index) => (
                <option value={camera.deviceId} key={camera.deviceId}>
                  {camera.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          <label>
            Microphone
            <select
              value={microphoneId}
              onChange={changeMicrophone}
              disabled={disabled || requesting}
            >
              <option value="">System default</option>
              {microphones.map((microphone, index) => (
                <option value={microphone.deviceId} key={microphone.deviceId}>
                  {microphone.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
          {requesting && <p className="local-media-note">Switching device...</p>}
          {error && <p className="local-media-error">{error}</p>}
        </div>
      )}
    </section>
  );
}

const mediaCss = `
  .media-permission {
    width: min(100%, 520px);
    margin-top: 2rem;
    padding: 1.5rem;
    border: 1px solid #2d2d2d;
    border-radius: 9px;
    background: #111;
  }
  .media-permission h2 {
    margin: 0 0 0.6rem;
    font-size: 1.1rem;
  }
  .media-permission p {
    margin: 0;
    color: #aaa;
    line-height: 1.5;
  }
  .media-permission div {
    display: flex;
    justify-content: flex-end;
    gap: 0.7rem;
    margin-top: 1.2rem;
  }
  .media-permission .media-accept-button {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
  }
  /* The camera fills the session's stage; chips and controls float on it. */
  .local-media { position: absolute; inset: 0; }
  .local-media video {
    display: block; width: 100%; height: 100%;
    background: #111; object-fit: cover;
  }
  .local-media-chip {
    position: absolute; top: 18px; left: 18px; max-width: calc(50% - 30px);
    display: inline-flex; align-items: center; height: 34px; padding: 0 14px; box-sizing: border-box;
    border-radius: 17px; background: rgba(20,20,22,0.6); backdrop-filter: blur(12px);
    color: #fff; font-size: 0.82rem; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .local-media .local-media-settings {
    position: absolute; right: 24px; bottom: 38px; z-index: 2;
    display: flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; padding: 0; border: none; border-radius: 22px;
    background: rgba(20,20,22,0.6); backdrop-filter: blur(12px); color: #fff; cursor: pointer;
  }
  .local-media .local-media-settings[aria-expanded="true"] { background: #fff; color: #111; }
  .local-media .local-media-settings:disabled { opacity: 0.4; cursor: default; }
  .local-media-devices {
    position: absolute; right: 24px; bottom: 92px; z-index: 3;
    width: min(320px, calc(100% - 48px)); box-sizing: border-box;
    display: flex; flex-direction: column; gap: 0.8rem; padding: 16px;
    border-radius: 16px; background: rgba(20,20,22,0.85); backdrop-filter: blur(16px);
    box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  }
  .local-media-devices label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    color: #aaa;
    font-size: 0.8rem;
  }
  .local-media-devices select {
    width: 100%;
    padding: 0.55rem 0.65rem;
    border: 1px solid #383838;
    border-radius: 9px;
    background: #171717;
    color: #eee;
    font: inherit;
  }
  .local-media-note,
  .local-media-error {
    margin: 0;
    color: #888;
    font-size: 0.8rem;
  }
  .local-media-error {
    color: #ffaaa5;
  }
`;
