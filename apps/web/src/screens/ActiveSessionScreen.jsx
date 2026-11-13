import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import timesyncUrl from "timesync/dist/timesync.min.js?url";

import {
  endSession,
  getSessionVideos,
  getSessions,
  leaveSession,
  saveRecordingDetails,
  uploadSessionVideo,
} from "../api/recordings.js";
import { getGroups } from "../api/groups.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
import { LocalMediaPreview } from "../components/LocalMediaPreview.jsx";
import { useWakeLock } from "../hooks/useWakeLock.js";
import { createFrameWatcher } from "../recording/firstFrame.js";
import { PlaybackScreen } from "./PlaybackScreen.jsx";
import {
  createLocalRecorder,
  downloadFile,
  recordingBaseName,
  recordingDisplayName,
} from "../recording/localRecording.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

// This tab's device id: the server allows one device per account in a
// session and tells a reconnect from a second device by it. Per tab (it
// survives a reload), so a second tab counts as another device.
function tabDeviceId() {
  try {
    let id = sessionStorage.getItem("8kount.deviceId");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("8kount.deviceId", id);
    }
    return id;
  } catch {
    return null;
  }
}
let timesyncPromise = null;

// loads the timesync browser file once
function loadTimesync() {
  if (window.timesync) return Promise.resolve(window.timesync);

  if (!timesyncPromise) {
    timesyncPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = timesyncUrl;
      script.onload = () => {
        if (window.timesync) resolve(window.timesync);
        else reject(new Error("Unable to start timesync."));
      };
      script.onerror = () => reject(new Error("Unable to load timesync."));
      document.head.appendChild(script);
    });
  }

  return timesyncPromise;
}

export function ActiveSessionScreen() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [session, setSession] = useState(null);
  const [mediaReady, setMediaReady] = useState(false);
  // This device starts and stops the other cameras without recording itself.
  const [controllerOnly, setControllerOnly] = useState(false);
  const controllerOnlyRef = useRef(false);
  controllerOnlyRef.current = controllerOnly;
  // Whether this user may start and stop takes (the session's creator, or an
  // admin or the owner of its group), known before joining so the camera
  // prompt can offer "Control only".
  const [mayControl, setMayControl] = useState(false);
  // In the room: with the camera on, or as a controller.
  const ready = mediaReady || controllerOnly;
  const [members, setMembers] = useState([]);
  const [socketStatus, setSocketStatus] = useState("Waiting for media");
  const [syncStatus, setSyncStatus] = useState("Syncing");
  const [syncedTime, setSyncedTime] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  // Asking before leaving (or, for the host, ending it for everyone).
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState("");
  // How far ahead the shared start is set. It has to cover the start
  // message reaching every phone over the internet, or they start late.
  // The session's creator and the group's admins and owner start and stop
  // takes for everyone; the server says which this user is when joining.
  const [canControl, setCanControl] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("idle");
  const [recordingMessage, setRecordingMessage] = useState(
    "Waiting for the host to record."
  );
  const socketRef = useRef(null);
  const clockRef = useRef(null);
  const mediaStreamRef = useRef(null);
  // Reports camera frames' capture times (see firstFrame.js).
  const frameWatcherRef = useRef(null);
  const recorderRef = useRef(null);
  const recordingTimerRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingInfoRef = useRef(null);
  // Recordings waiting to upload, oldest first. None goes while a take runs,
  // so on a slow network the start and stop aren't stuck behind video; one
  // already going is stopped and carries on from where it got once it's
  // over.
  const uploadQueueRef = useRef([]);
  // Stops the upload going now (an AbortController), if one is.
  const uploadingRef = useRef(null);
  const takeRunningRef = useRef(false);
  // Waiting out a stop: cameras keep rolling until its time.
  const stopTimerRef = useRef(null);
  // A camera that left its app mid-take, for whoever runs the session.
  const [dropNotice, setDropNotice] = useState("");
  // The session's recordings, shown over this page so the session (camera,
  // connection) stays live underneath. Never during a take: it closes when
  // one starts, before this camera records, and can't open until it's done.
  // false, or the recording number to open on (0: the list).
  const [watching, setWatching] = useState(false);
  // When the take running now started (synced clock), for the REC timer.
  const [takeStartedAt, setTakeStartedAt] = useState(null);
  // This computer's uploads: how many wait, and how far the one going is
  // (null between uploads).
  const [uploads, setUploads] = useState({ queued: 0, fraction: null });
  // The session's recordings so far, for the list beside the camera.
  const [takes, setTakes] = useState([]);
  const [groupName, setGroupName] = useState("");
  // The screen stays on for the whole live session, cameras and controllers
  // alike: a sleeping computer misses the start or starts late.
  useWakeLock();

  // checks that this user can enter the live session
  useEffect(() => {
    let cancelled = false;

    Promise.all([getSessions(), getGroups().catch(() => [])])
      .then(([sessions, groups]) => {
        const currentSession = sessions.find(
          (item) => item.id === sessionId
        );

        if (!currentSession || currentSession.status !== "active") {
          throw new Error("This session is not live.");
        }
        if (!currentSession.isJoined) {
          throw new Error("Join this session from the Record page first.");
        }

        if (!cancelled) {
          setSession(currentSession);
          setGroupName(groups.find((group) => group.id === currentSession.groupId)?.name ?? "");
          setMayControl(
            Number(currentSession.createdBy) === Number(user.id) ||
            groups.some((group) => group.id === currentSession.groupId && group.role === "admin")
          );
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // connects the socket and clock after media is ready
  useEffect(() => {
    if (!session || !ready) return undefined;

    let socket;
    let clock;
    let timer;
    let cancelled = false;

    // queues the video to upload for playback; it's saved to this computer
    // only if the upload fails, so the take isn't lost
    const saveRecording = (recorder, extension) => {
      const info = recordingInfoRef.current;
      if (!info) return;

      const video = new Blob(recordingChunksRef.current, {
        type: recorder.mimeType || "video/webm",
      });
      const videoFileName = `${recordingBaseName(info)}.${extension}`;

      recorderRef.current = null;
      recordingInfoRef.current = null;
      recordingChunksRef.current = [];
      setRecordingStatus("idle");
      if (video.size === 0) {
        setRecordingMessage("Nothing was recorded on this device.");
        return;
      }
      setUploads((current) => ({ ...current, queued: uploadQueueRef.current.length + 1 }));
      uploadQueueRef.current.push({
        video,
        videoFileName,
        startedAt: info.plannedStartAtEpochMs,
        // When the recorder really started, so playback can line this angle
        // up with the phones, which start a moment after the shared time.
        actualStartedAt: info.actualStartAtEpochMs
          ? Math.round(info.actualStartAtEpochMs)
          : undefined,
        startClock: info.startClock ?? "call",
        // The server's upload of it once one has started, so a try that's
        // stopped (a take starting) or cut off carries on from there.
        resume: {},
      });
      sendUploads();
    };

    // sends the queued recordings one at a time, unless a take is running
    const sendUploads = () => {
      if (takeRunningRef.current || uploadingRef.current) return;
      const next = uploadQueueRef.current[0];
      if (!next) return;
      const controller = new AbortController();
      uploadingRef.current = controller;
      const done = () => {
        uploadQueueRef.current = uploadQueueRef.current.filter((item) => item !== next);
      };
      setUploads({ queued: uploadQueueRef.current.length, fraction: 0 });
      setRecordingMessage("Uploading for playback...");
      saveRecordingDetails(sessionId, next.startedAt, next.actualStartedAt, next.startClock)
        .then(() => uploadSessionVideo(
          sessionId, next.startedAt, next.video, next.videoFileName, next.actualStartedAt,
          next.startClock, controller.signal, next.resume,
          (fraction) => setUploads((current) => ({ ...current, fraction })),
        ))
        .then(() => {
          done();
          if (!takeRunningRef.current) setRecordingMessage("Uploaded for playback");
        })
        .catch((err) => {
          // Stopped for a take: it stays queued and goes again after.
          if (controller.signal.aborted) return;
          done();
          downloadFile(next.video, next.videoFileName);
          setRecordingMessage(
            `Upload failed (${err.message}), so ${next.videoFileName} was saved to this computer instead.`
          );
        })
        .finally(() => {
          uploadingRef.current = null;
          setUploads({ queued: uploadQueueRef.current.length, fraction: null });
          sendUploads();
        });
    };

    // waits for the shared server start time
    const beginRecording = (command) => {
      if (recorderRef.current || recordingTimerRef.current) return;

      setWatching(false);
      setTakeStartedAt(command.startAtEpochMs);
      takeRunningRef.current = true;
      uploadingRef.current?.abort();
      const receivedAtEpochMs = clock.now();
      recordingInfoRef.current = {
        sessionId,
        sessionName: session.name,
        userId: user.id,
        recordingNumber: command.recordingNumber,
        bufferMs: command.bufferMs,
        serverSentAtEpochMs: command.serverSentAtEpochMs,
        plannedStartAtEpochMs: command.startAtEpochMs,
        startCommandReceivedAtEpochMs: receivedAtEpochMs,
        timesyncOffsetAtCommandMs: clock.offset,
      };

      const delay = Math.max(0, command.startAtEpochMs - receivedAtEpochMs);

      setRecordingStatus("waiting");
      setRecordingMessage(`Recording starts in ${Math.round(delay)} ms`);

      if (controllerOnlyRef.current) {
        recordingTimerRef.current = window.setTimeout(() => {
          recordingTimerRef.current = null;
          setRecordingStatus("recording");
          setRecordingMessage(
            `${recordingDisplayName(command.startAtEpochMs, command.recordingNumber)} recording on the cameras`
          );
        }, delay);
        return;
      }

      recordingTimerRef.current = window.setTimeout(() => {
        recordingTimerRef.current = null;

        try {
          const { recorder, extension } = createLocalRecorder(
            mediaStreamRef.current
          );
          recordingChunksRef.current = [];
          recorderRef.current = recorder;

          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) recordingChunksRef.current.push(event.data);
          };
          recorder.onstart = () => {
            // Unless the first frame's capture time already came in, which is
            // more exact (see below).
            const actualStartAtEpochMs = recordingInfoRef.current?.startClock === "frame"
              ? recordingInfoRef.current.actualStartAtEpochMs
              : clock.now();
            recordingInfoRef.current = {
              ...recordingInfoRef.current,
              actualStartAtEpochMs,
              timesyncOffsetAtStartMs: clock.offset,
              startDifferenceMs:
                actualStartAtEpochMs - command.startAtEpochMs,
            };
            setRecordingStatus("recording");
            setRecordingMessage(
              `${recordingDisplayName(command.startAtEpochMs, command.recordingNumber)} in progress`
            );
          };
          recorder.onstop = () => saveRecording(recorder, extension);
          // The first frame the recorder takes is the next one the camera
          // sends; its capture time, on the synced clock, is when this angle
          // really started.
          frameWatcherRef.current?.nextFrameCaptureTime().then((captured) => {
            const info = recordingInfoRef.current;
            if (captured == null || !info || recorderRef.current !== recorder) return;
            info.actualStartAtEpochMs = clock.now() - (performance.now() - captured);
            info.startClock = "frame";
          });
          recorder.onerror = () => {
            recorderRef.current = null;
            recordingInfoRef.current = null;
            recordingChunksRef.current = [];
            setRecordingStatus("idle");
            setRecordingMessage("Local recording failed.");
          };
          recorder.start(1000);
        } catch (err) {
          recorderRef.current = null;
          recordingInfoRef.current = null;
          setRecordingStatus("idle");
          setError(err.message);
        }
      }, delay);
    };

    // stops this device when the host sends stop, at the stop's time
    const finishRecording = (command) => {
      if (recordingTimerRef.current) {
        window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }

      const receivedAtEpochMs = clock.now();

      const stopIn = command.stopAtEpochMs
        ? Math.max(0, command.stopAtEpochMs - receivedAtEpochMs)
        : 0;
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = window.setTimeout(() => {
        stopTimerRef.current = null;
        stopNow(command);
      }, stopIn);
    };

    const stopNow = (command) => {
      setDropNotice("");
      setTakeStartedAt(null);
      // Uploads go again once every camera has really stopped (this one's
      // own take joins the queue as it's saved).
      takeRunningRef.current = false;
      window.setTimeout(sendUploads, 1500);

      if (recordingInfoRef.current) {
        recordingInfoRef.current = {
          ...recordingInfoRef.current,
          serverStopAtEpochMs: command.stopAtEpochMs,
          stopCommandReceivedAtEpochMs: clock.now(),
          timesyncOffsetAtStopCommandMs: clock.offset,
        };
      }

      if (controllerOnlyRef.current) {
        recordingInfoRef.current = null;
        setRecordingStatus("idle");
        setRecordingMessage("Take stopped. The cameras are saving and uploading it.");
        return;
      }

      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        setRecordingStatus("saving");
        setRecordingMessage("Saving local recording...");
        recorder.stop();
      } else {
        recordingInfoRef.current = null;
        setRecordingStatus("idle");
        setRecordingMessage("Recording stopped before it began.");
      }
    };

    loadTimesync()
      .then((timesync) => {
        if (cancelled) return;

        setSocketStatus("Connecting");
        socket = io(SERVER_URL, { withCredentials: true });
        clock = timesync.create({
          server: `${SERVER_URL}/timesync`,
          interval: 10000,
        });
        socketRef.current = socket;
        clockRef.current = clock;

        timer = window.setInterval(() => {
          setSyncedTime(clock.now());
        }, 100);

        clock.on("change", (offset) => {
          setClockOffset(Math.round(offset));
          setSyncStatus("Synced");
        });
        clock.on("error", () => setSyncStatus("Retrying"));

        socket.on("connect", () => {
          socket.emit("session:join", { sessionId, camera: !controllerOnlyRef.current, deviceId: tabDeviceId() }, (reply) => {
            if (!reply?.ok) {
              setSocketStatus("Disconnected");
              setError(reply?.error || "Unable to join the live session.");
              return;
            }

            setMembers(reply.members);
            setSocketStatus("Connected");
            // Clears "Reconnecting…" once a dropped connection is back.
            setError("");
            const controls = Boolean(reply.session.canControl);
            setCanControl(controls);
            setRecordingMessage(
              controls ? "Ready to record." : "Waiting for the host to record."
            );
            if (reply.recording) {
              beginRecording(reply.recording);
            } else if (takeRunningRef.current && !recorderRef.current) {
              // The take ended while this computer was offline (its stop
              // never arrived): uploads can go again.
              takeRunningRef.current = false;
              sendUploads();
            }
          });
        });

        socket.on("connect_error", (err) => {
          setSocketStatus("Disconnected");
          // A network drop or server restart ("xhr poll error"); socket.io
          // keeps retrying and rejoins on connect. Anything else, like a
          // rejected login, is shown as is.
          setError(err.type === "TransportError"
            ? "Lost the connection to the server. Reconnecting…"
            : err.message);
        });
        socket.on("session:members", setMembers);
        socket.on("recording:started", beginRecording);
        socket.on("recording:stopped", finishRecording);
        socket.on("recording:dropped", ({ user: dropped } = {}) => {
          const name = dropped?.name || dropped?.email || "A camera";
          setDropNotice(`${name} left the app, so their camera stopped recording this take.`);
        });
        socket.on("session:close", () => {
          navigate("/watch", { replace: true });
        });
      })
      .catch((err) => {
        setSyncStatus("Unavailable");
        setError(err.message);
      });

    return () => {
      cancelled = true;
      // Leaving mid-take: whatever's queued still goes.
      takeRunningRef.current = false;
      sendUploads();
      if (timer) window.clearInterval(timer);
      if (recordingTimerRef.current) {
        window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
      if (
        recorderRef.current &&
        recorderRef.current.state !== "inactive"
      ) {
        recorderRef.current.stop();
      }
      clock?.destroy();
      socket?.emit("session:leave");
      socket?.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      if (clockRef.current === clock) clockRef.current = null;
    };
  }, [ready, navigate, session, sessionId, user.id]);

  // The browser's back button asks first, like the phone's: an extra
  // history entry catches it, and is put back if they stay.
  const leavingRef = useRef(false);
  leavingRef.current = leaving;
  useEffect(() => {
    window.history.pushState({ sessionGuard: true }, "", window.location.href);
    const onPop = () => {
      if (leavingRef.current) return;
      window.history.pushState({ sessionGuard: true }, "", window.location.href);
      setWatching(false);
      setConfirmingLeave(true);
    };
    // Closing or reloading the tab gets the browser's own "Leave site?".
    const onUnload = (event) => {
      if (leavingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  // The hidden camera-frame watcher goes with the page.
  useEffect(() => () => frameWatcherRef.current?.stop(), []);

  // The recordings list: on joining, after each take, and every 10 s while
  // nothing records (angles fill in as they upload).
  const loadTakes = () => {
    getSessionVideos(sessionId)
      .then((data) => setTakes(data.recordings))
      .catch(() => {});
  };
  useEffect(() => { if (ready) loadTakes(); }, [ready, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ready && recordingStatus === "idle") {
      const timer = window.setTimeout(loadTakes, 2500);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [recordingStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  useAutoRefresh(() => {
    if (ready && recordingStatus === "idle" && watching === false) loadTakes();
  }, 10000);

  // Esc closes the recordings and goes back to the session.
  useEffect(() => {
    if (watching === false) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setWatching(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [watching]);

  // Switching between recording and controlling after joining: join again
  // with the new choice (the server updates who's a camera). Before the
  // socket is up, the first join already carries it.
  const modeChanged = useRef(false);
  useEffect(() => {
    if (!modeChanged.current) {
      modeChanged.current = true;
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit("session:join", { sessionId, camera: !controllerOnly, deviceId: tabDeviceId() }, (reply) => {
      if (reply?.ok) setMembers(reply.members);
    });
  }, [controllerOnly, sessionId]);

  const isCreator =
    session && Number(session.createdBy) === Number(user?.id);

  const handleMediaReady = (stream) => {
    mediaStreamRef.current = stream;
    frameWatcherRef.current?.stop();
    frameWatcherRef.current = createFrameWatcher(stream);
    setMediaReady(true);
  };

  // sends the host recording commands
  const startRecording = () => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setRecordingMessage("Websocket is not connected yet.");
      return;
    }

    setRecordingStatus("requesting");
    setRecordingMessage("Sending the synchronized start...");
    socket.emit(
      "recording:start",
      // The server picks the start time, allowing for the slowest device.
      { sessionId },
      (reply) => {
        if (!reply?.ok) {
          setRecordingStatus("idle");
          setRecordingMessage(reply?.error || "Unable to start recording.");
        }
      }
    );
  };

  const stopRecording = () => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setRecordingMessage("Websocket is not connected.");
      return;
    }

    setRecordingStatus("stopping");
    setRecordingMessage("Stopping...");
    socket.emit("recording:stop", { sessionId }, (reply) => {
      if (!reply?.ok) {
        setRecordingStatus("recording");
        setRecordingMessage(reply?.error || "Unable to stop recording.");
      }
    });
  };

  const leave = async () => {
    setError("");
    setLeaving(true);

    try {
      await leaveSession(sessionId);
      navigate("/watch", { replace: true });
    } catch (err) {
      setError(err.message);
      setLeaving(false);
    }
  };

  const endAndLeave = async () => {
    setError("");
    setLeaving(true);

    try {
      await endSession(sessionId);
      navigate("/watch", { replace: true });
    } catch (err) {
      setError(err.message);
      setLeaving(false);
    }
  };

  const declineMedia = async () => {
    setLeaving(true);

    try {
      if (isCreator) await endSession(sessionId);
      else await leaveSession(sessionId);
    } catch {
      // leaving still removes this browser from the live room
    } finally {
      navigate("/watch", { replace: true });
    }
  };

  const busy = recordingStatus !== "idle";
  const recording = recordingStatus === "recording" || recordingStatus === "stopping";
  const elapsed = takeStartedAt == null ? 0 : Math.max(0, Math.floor((syncedTime - takeStartedAt) / 1000));
  const cameraCount = members.filter((member) => member.camera !== false).length;
  const linkReady = socketStatus === "Connected" && syncStatus === "Synced";
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  // Over the camera: the take's state in the top corner, and along the
  // bottom this device's mode, the shutter (for whoever runs the session)
  // and what's happening.
  const stageControls = (
    <>
      <span className={recording ? "session-state session-state-rec" : "session-state"} role="status">
        {recording ? (
          <><span className="session-state-dot" />REC {clock}</>
        ) : busy ? (
          recordingStatus === "saving" ? "Saving…" : "Starting…"
        ) : linkReady ? (
          <><span className="session-state-dot session-state-ok" />
            Ready · {cameraCount} {cameraCount === 1 ? "camera" : "cameras"} synced</>
        ) : socketStatus !== "Connected" ? "Connecting…" : "Syncing clock…"}
      </span>
      <div className="session-dock">
        {mayControl ? (
          <div className="session-device-mode" role="group" aria-label="This device">
            <button type="button" aria-pressed={!controllerOnly} disabled={busy}
              onClick={() => setControllerOnly(false)}>Camera</button>
            <button type="button" aria-pressed={controllerOnly} disabled={busy}
              onClick={() => setControllerOnly(true)}>Control only</button>
          </div>
        ) : <span />}
        <div className="session-shutter-wrap">
          {canControl && (
            recordingStatus === "idle" ? (
              <button type="button" className="session-shutter" aria-label="Start recording"
                onClick={startRecording} disabled={!linkReady}>
                <span className="session-shutter-start" />
              </button>
            ) : (
              <button type="button" className="session-shutter" aria-label="Stop recording"
                onClick={stopRecording}
                disabled={["requesting", "stopping", "saving"].includes(recordingStatus)}>
                <span className="session-shutter-stop" />
              </button>
            )
          )}
          <p>
            {recordingStatus === "idle" && canControl && linkReady && !/fail|saved|Unable|not connected/i.test(recordingMessage)
              ? `Records on ${cameraCount === 1 ? "this camera" : `all ${cameraCount} cameras at the same instant`}`
              : recordingMessage}
          </p>
          {canControl && dropNotice && <p className="session-sync-tip">{dropNotice}</p>}
        </div>
        <span />
      </div>
    </>
  );

  return (
    <>
    <div className="active-session-page" inert={watching !== false ? "" : undefined}>
      <style>{activeSessionCss}</style>

      {confirmingLeave && (
        <div className="active-session-leave-backdrop"
          onClick={(event) => { if (event.target === event.currentTarget && !leaving) setConfirmingLeave(false); }}
          onKeyDown={(event) => { if (event.key === "Escape" && !leaving) setConfirmingLeave(false); }}>
          <div className="active-session-leave" role="alertdialog" aria-modal="true"
            aria-labelledby="leave-title">
            <h2 id="leave-title">{isCreator ? "End the session?" : "Leave the session?"}</h2>
            <p>
              {isCreator
                ? "You're the host, so leaving closes the session for everyone. Every camera stops and no more takes can be recorded."
                : "You'll stop being a camera in this session. You can join again from its card in Sessions."}
            </p>
            {recordingStatus !== "idle" && <p>A take is recording; it stops here now.</p>}
            <div>
              <button type="button" autoFocus disabled={leaving}
                onClick={() => setConfirmingLeave(false)}>Stay</button>
              <button className="active-session-danger" type="button" disabled={leaving}
                onClick={isCreator ? endAndLeave : leave}>
                {leaving
                  ? (isCreator ? "Ending..." : "Leaving...")
                  : (isCreator ? "End for everyone" : "Leave")}
              </button>
            </div>
          </div>
        </div>
      )}
      <header className="active-session-header">
        <button type="button" className="active-session-back"
          aria-label={isCreator ? "End session" : "Leave session"}
          title={isCreator ? "End session" : "Leave session"}
          disabled={leaving} onClick={() => setConfirmingLeave(true)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="active-session-title">
          <h1>{session?.name || "Loading session..."}</h1>
          {session && (
            <span>
              {/* An old session without a group: its code is the way in. */}
              {session.groupId != null ? groupName : <>code <code>{session.id}</code></>}
            </span>
          )}
        </div>
        {session && (
          <button className="active-session-danger" type="button"
            disabled={leaving} onClick={() => setConfirmingLeave(true)}>
            {isCreator ? "End session" : "Leave"}
          </button>
        )}
      </header>

      {error && (
        <div className="active-session-error">
          <p>{error}</p>
          <button type="button" onClick={() => navigate("/watch")}>
            Back to Sessions
          </button>
        </div>
      )}

      {session && (
        <div className="active-session-body">
          {/* The camera, big, with the session's controls over it. */}
          <main className={recording ? "session-stage session-stage-rec" : "session-stage"}>
            {controllerOnly ? (
              <div className="session-controller-note">
                <h2>Controlling the cameras</h2>
                <p>This device isn't recording. Start and stop every camera from here.</p>
                {ready && stageControls}
              </div>
            ) : (
              <LocalMediaPreview
                disabled={busy}
                onReady={handleMediaReady}
                onDecline={declineMedia}
              >
                {ready && stageControls}
              </LocalMediaPreview>
            )}
          </main>

          {ready && (
            <aside className="session-side">
              <section className="active-session-members">
                <h2>
                  In this session
                  {members.length > 0 && (
                    <span>{members.length} {members.length === 1 ? "device" : "devices"}</span>
                  )}
                </h2>
                {members.length === 0 ? (
                  <p>Waiting for members to connect...</p>
                ) : (
                  <ul>
                    {members.map((member) => (
                      <li key={member.id}>
                        <span className="session-member-face" aria-hidden="true">
                          {(member.name || member.email || "?").trim().charAt(0).toUpperCase()}
                        </span>
                        <span className="session-member-name">
                          <strong>
                            {member.name || member.email}
                            {Number(member.id) === Number(user.id) && <em> (you)</em>}
                          </strong>
                          <small>
                            {[
                              Number(member.id) === Number(session.createdBy) && "Host",
                              member.camera === false ? "Controller" : "Camera",
                            ].filter(Boolean).join(" · ")}
                          </small>
                        </span>
                        <MemberSignal roundTripMs={member.roundTripMs}
                          offline={Number(member.id) === Number(user.id) && socketStatus === "Disconnected"} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* This computer's uploads: a bar while one goes, paused
                  during a take. */}
              {(uploads.queued > 0 || uploads.fraction != null) && (
                <div className={busy ? "session-upload session-upload-paused" : "session-upload"} role="status">
                  <span>
                    <strong>{busy ? "Uploads paused" : "Uploading your recording"}</strong>
                    {busy
                      ? <em>resume after this take</em>
                      : uploads.fraction != null && <b>{Math.round(uploads.fraction * 100)}%</b>}
                  </span>
                  <span className="session-upload-bar">
                    <span style={{ width: `${Math.round((uploads.fraction ?? 0) * 100)}%` }} />
                  </span>
                  {uploads.queued > 1 && <small>{uploads.queued - 1} more waiting</small>}
                </div>
              )}

              <section className="session-takes">
                <h2>
                  Recordings
                  {takes.length > 0 && (
                    <button type="button" className="session-link" disabled={busy}
                      title={busy ? "Available once this take has finished" : undefined}
                      onClick={() => setWatching(0)}>Watch all</button>
                  )}
                </h2>
                {takes.length === 0 ? (
                  <p>Recordings show up here as they're made.</p>
                ) : (
                  <ul>
                    {[...takes].reverse().map((take, index) => {
                      const number = take.number ?? takes.length - index;
                      const angleCount = take.videos.filter((video) => video.url).length;
                      return (
                        <li key={take.startedAt}>
                          <button type="button" disabled={busy}
                            title={busy ? "Available once this take has finished" : undefined}
                            onClick={() => setWatching(number)}>
                            <span className="session-take-num" aria-hidden="true">{String(number).padStart(3, "0")}</span>
                            <span>
                              <strong>Recording {String(number).padStart(3, "0")}</strong>
                              <small>
                                {new Date(take.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                                {" · "}
                                {angleCount < take.videos.length
                                  ? `${angleCount} of ${take.videos.length} angles in`
                                  : `${take.videos.length} ${take.videos.length === 1 ? "angle" : "angles"}`}
                              </small>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <span className="session-clock" title={`Socket: ${socketStatus}`}>
                {syncStatus === "Synced"
                  ? `Clock synced · ${clockOffset >= 0 ? "+" : ""}${clockOffset} ms`
                  : `Clock ${syncStatus.toLowerCase()}`}
              </span>
            </aside>
          )}
        </div>
      )}
    </div>
    {watching !== false && (
      <div className="session-watch-overlay" role="dialog" aria-modal="true"
        aria-label="This session's recordings">
        <PlaybackScreen live={{ sessionId, initial: watching || 0, onClose: () => setWatching(false) }} />
      </div>
    )}
    </>
  );
}

const activeSessionCss = `
  /* The whole window: a slim header, the camera big, and a column beside it. */
  .active-session-page {
    height: 100vh; margin: -2rem; padding: 20px 32px 24px; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 20px;
    background: #000; color: #f4f4f4; position: relative;
  }
  .active-session-page button {
    border: none; border-radius: 999px; padding: 0 18px; height: 42px;
    background: #1b1b1e; color: #f4f4f4; font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .active-session-page button:disabled { cursor: default; opacity: 0.45; }
  .active-session-page .active-session-danger { background: #3a1416; color: #ff8a8d; font-weight: 700; }
  .active-session-header { display: flex; align-items: center; gap: 14px; }
  .active-session-page .active-session-back {
    display: flex; align-items: center; justify-content: center;
    flex: 0 0 auto; width: 42px; padding: 0; border-radius: 50%;
  }
  .active-session-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .active-session-title h1 {
    margin: 0; font-size: 1.25rem; font-weight: 800;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .active-session-title span { color: #8a8a90; font-size: 0.82rem; }
  .active-session-title code { color: #c9c9cf; }

  .active-session-body {
    flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px;
  }
  .session-stage {
    position: relative; min-height: 0; border-radius: 24px; overflow: hidden; background: #111;
    display: flex; align-items: center; justify-content: center;
  }
  /* A red edge while recording. */
  .session-stage-rec::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    box-shadow: inset 0 0 0 3px #e5484d; z-index: 4;
  }
  .session-stage .media-permission { margin: 0; }
  .session-stage > .local-media-note { color: #8a8a90; }
  .session-controller-note { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 0 24px 140px; }
  .session-controller-note h2 { margin: 0; font-size: 1.3rem; }
  .session-controller-note p { margin: 0; color: #a8a8a8; line-height: 1.5; }

  .session-state {
    position: absolute; top: 18px; right: 18px; z-index: 2;
    display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; box-sizing: border-box;
    border-radius: 17px; background: rgba(20,20,22,0.6); backdrop-filter: blur(12px);
    color: #fff; font-size: 0.82rem; font-weight: 600; white-space: nowrap;
  }
  .session-state-dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; }
  .session-state-ok { background: #22a559; }
  .session-state-rec { background: #e5484d; backdrop-filter: none; font-size: 0.9rem; font-weight: 800; letter-spacing: 0.4px; font-variant-numeric: tabular-nums; }

  /* The dock along the bottom of the camera, over a dark fade. */
  .session-dock {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 1;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px;
    padding: 70px 24px 20px; background: linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0));
  }
  .session-device-mode {
    justify-self: start; display: inline-flex; padding: 4px; border-radius: 22px;
    background: rgba(20,20,22,0.6); backdrop-filter: blur(12px);
  }
  .active-session-page .session-device-mode button { height: 34px; padding: 0 16px; background: none; font-size: 0.82rem; }
  .active-session-page .session-device-mode button[aria-pressed="true"] { background: #fff; color: #111; font-weight: 700; }
  .session-shutter-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 460px; text-align: center; }
  .session-shutter-wrap p { margin: 0; color: #c9c9cf; font-size: 0.78rem; line-height: 1.4; }
  .active-session-page .session-shutter {
    display: flex; align-items: center; justify-content: center;
    width: 76px; height: 76px; padding: 0; border: 4px solid #fff; border-radius: 50%; background: transparent;
  }
  .active-session-page .session-shutter:disabled { opacity: 0.5; }
  .session-shutter-start { width: 56px; height: 56px; border-radius: 50%; background: #e5484d; transition: transform 0.15s; }
  .session-shutter:not(:disabled):hover .session-shutter-start { transform: scale(0.94); }
  .session-shutter-stop { width: 26px; height: 26px; border-radius: 6px; background: #e5484d; }
  .session-sync-tip { color: #ffb35c !important; }

  /* The column beside the camera. */
  .session-side { display: flex; flex-direction: column; gap: 22px; min-height: 0; overflow-y: auto; }
  .session-side h2 {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    margin: 0 0 6px; font-size: 1rem; font-weight: 700;
  }
  .session-side h2 > span { color: #8a8a90; font-size: 0.82rem; font-weight: 500; }
  .session-side p { margin: 0; color: #8a8a90; font-size: 0.85rem; }
  .session-side ul { list-style: none; margin: 0; padding: 0; }
  .active-session-members li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid #1e1e21; }
  .session-member-face {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; border-radius: 50%; background: #1b1b1e; color: var(--accent); font-size: 0.8rem; font-weight: 700;
  }
  .session-member-name { flex: 1; min-width: 0; }
  .session-member-name strong, .session-member-name small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-member-name strong { font-size: 0.9rem; font-weight: 600; }
  .session-member-name em { font-style: normal; font-weight: 400; color: #8a8a90; }
  .session-member-name small { margin-top: 1px; color: #8a8a90; font-size: 0.75rem; }
  .signal-bars { display: inline-flex; flex: none; }
  .signal-bars svg { display: block; }
  .member-signal { display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: 0.78rem; font-weight: 600; }

  .session-upload { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 16px; background: #111113; }
  .session-upload > span:first-child { display: flex; justify-content: space-between; gap: 10px; font-size: 0.82rem; }
  .session-upload strong { font-weight: 600; }
  .session-upload b { color: var(--accent); }
  .session-upload em { font-style: normal; color: #8a8a90; }
  .session-upload small { color: #8a8a90; font-size: 0.75rem; }
  .session-upload-bar { display: block; height: 4px; border-radius: 2px; background: #2a2a2e; overflow: hidden; }
  .session-upload-bar span { display: block; height: 100%; background: var(--accent); transition: width 0.3s; }
  .session-upload-paused .session-upload-bar span { background: #5a5a60; }

  .active-session-page .session-link { height: auto; padding: 0; background: none; color: var(--accent); font-size: 0.82rem; }
  .session-takes li { border-top: 1px solid #1e1e21; }
  .active-session-page .session-takes li button {
    display: flex; align-items: center; gap: 12px; width: 100%; height: auto; padding: 8px 6px;
    border-radius: 10px; background: none; text-align: left;
  }
  .active-session-page .session-takes li button:not(:disabled):hover { background: #161618; }
  .session-take-num {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
    width: 64px; height: 36px; border-radius: 6px; background: linear-gradient(135deg, #2b2b30, #17171a);
    color: #8a8a90; font-size: 0.75rem; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .session-takes strong, .session-takes small { display: block; }
  .session-takes strong { font-size: 0.85rem; font-weight: 600; }
  .session-takes small { color: #8a8a90; font-size: 0.75rem; font-weight: 400; }
  .session-clock { margin-top: auto; color: #6a6a70; font-size: 0.72rem; font-family: ui-monospace, monospace; }

  .active-session-error { display: flex; align-items: center; gap: 12px; color: #ffaaa5; }
  .active-session-error p { margin: 0; }
  .active-session-leave-backdrop {
    position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0,0,0,0.65);
  }
  .active-session-leave {
    width: 100%; max-width: 420px; padding: 1.4rem 1.5rem; border: 1px solid #333; border-radius: 16px;
    background: #161616; box-sizing: border-box;
  }
  .active-session-leave h2 { margin: 0 0 0.6rem; font-size: 1.15rem; }
  .active-session-leave p { margin: 0 0 0.8rem; color: #bbb; line-height: 1.45; font-size: 0.92rem; }
  .active-session-leave div { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1.1rem; }
  /* Playback over the live session, which keeps running underneath. */
  .session-watch-overlay {
    position: fixed; inset: 0; z-index: 50; overflow-y: auto; padding: 1.5rem; background: #000;
  }
  @media (max-width: 640px) { .session-watch-overlay { padding: 1rem; } }

  /* Narrow: the column goes under the camera. */
  @media (max-width: 960px) {
    .active-session-page { height: auto; min-height: 100vh; padding: 16px; }
    .active-session-body { grid-template-columns: 1fr; }
    .session-stage { aspect-ratio: 3 / 4; max-height: 75vh; }
    .session-side { overflow: visible; }
    .session-dock { grid-template-columns: 1fr; justify-items: center; padding: 60px 16px 16px; }
    .session-dock > span:empty { display: none; }
    .session-device-mode { justify-self: center; }
  }
`;

// Above this a round trip counts as weak: start and stop may arrive late and
// uploads will be slow.
const WEAK_ABOVE_MS = 600;

// How good a connection is from its round trip to the server (timed by the
// server and sent with the device list every few seconds).
function signalLevel(roundTripMs, connected) {
  if (!connected) return "offline";
  if (roundTripMs == null) return "unknown";
  return roundTripMs > WEAK_ABOVE_MS ? "weak" : "good";
}

const SIGNAL_LABELS = { good: "Good", weak: "Weak", offline: "Offline", unknown: "Checking" };
// Set on the bars themselves, so a list's own text colour can't grey them.
const SIGNAL_COLORS = { good: "#22a559", weak: "#e08a00", offline: "#e5484d", unknown: "#666" };

// Three signal bars in the connection's colour, as many lit as it's good.
function SignalBars({ level, title }) {
  const bars = { good: 3, weak: 2, offline: 0, unknown: 3 }[level];
  return (
    <span className="signal-bars" style={{ color: SIGNAL_COLORS[level] }} title={title}
      role="img" aria-label={`Connection: ${SIGNAL_LABELS[level]}`}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={1 + i * 5} y={10 - i * 4} width="3.5" height={5 + i * 4} rx="1"
            fill="currentColor" opacity={i < bars ? 1 : 0.25} />
        ))}
      </svg>
    </span>
  );
}

// Someone's connection in the session's list: the bars and the word (Good,
// Weak, Offline, or Checking until the server has timed it), with the round
// trip on hover. The only place connections show on the website.
function MemberSignal({ roundTripMs, offline }) {
  const level = signalLevel(roundTripMs, !offline);
  return (
    <span className="member-signal" style={{ color: SIGNAL_COLORS[level] }}
      title={level === "offline" ? "No connection to the server"
        : roundTripMs == null ? "Checking connection" : `${roundTripMs} ms to the server`}>
      <SignalBars level={level} />
      {SIGNAL_LABELS[level]}
    </span>
  );
}
