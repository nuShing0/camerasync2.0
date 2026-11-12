const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

// A stored file's link as the server gave it: a path on this server, or a
// full (signed) CDN link when the server has one set up.
function fileLink(link) {
  return link.startsWith("/") ? `${SERVER_URL}${link}` : link;
}

// What a <video> needs to send with its requests for [link]: the login
// cookie to this server (which checks it), nothing to the CDN (the link is
// signed, and asking for credentials there would need CORS set up for it).
export function mediaCors(link) {
  return link?.startsWith(SERVER_URL) ? "use-credentials" : undefined;
}

// sends api requests with the login cookie
async function request(path, options = {}) {
  const response = await fetch(`${SERVER_URL}${path}`, {
    credentials: "include",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// loads sessions visible to the current user
export async function getSessions() {
  const data = await request("/api/recordings/sessions");
  for (const session of data.sessions) {
    if (session.thumbnailUrl) session.thumbnailUrl = fileLink(session.thumbnailUrl);
  }
  return data.sessions;
}

// creates either a scheduled or live session
export async function scheduleSession(session) {
  const data = await request("/api/recordings/sessions", {
    method: "POST",
    body: JSON.stringify(session),
  });
  return data.session;
}

export async function createLiveSession(session) {
  const data = await request("/api/recordings/sessions/live", {
    method: "POST",
    body: JSON.stringify(session),
  });
  return data.session;
}

// updates session membership and status
export async function joinSession(id) {
  const data = await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/join`,
    { method: "POST" }
  );
  return data.session;
}

export async function leaveSession(id) {
  await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/join`,
    { method: "DELETE" }
  );
}

export async function endSession(id) {
  const data = await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/end`,
    { method: "PATCH" }
  );
  return data.session;
}

export async function cancelSession(id) {
  const data = await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/cancel`,
    { method: "PATCH" }
  );
  return data.session;
}

// startedAt is the take's shared start; actualStartedAt (optional) is when
// this device's camera really began, both on the server clock. Playback
// shifts the angle by the difference to line it up with the others.
// startClock says what actualStartedAt is: "frame" for the first frame's
// capture time, "call" for when the recorder said it started.
export async function saveRecordingDetails(id, startedAt, actualStartedAt, startClock) {
  await request(`/api/recordings/sessions/${encodeURIComponent(id)}/videos`, {
    method: "POST",
    body: JSON.stringify({ startedAt, actualStartedAt, startClock }),
  });
}

export async function getSessionVideos(id) {
  const data = await request(`/api/recordings/sessions/${encodeURIComponent(id)}/videos`);
  for (const recording of data.recordings) {
    for (const video of recording.videos) {
      if (video.url) video.url = fileLink(video.url);
      if (video.previewUrl) video.previewUrl = fileLink(video.previewUrl);
      if (video.scrub) video.scrub.sheets = video.scrub.sheets.map(fileLink);
    }
  }
  return data;
}

// The session (or, with startedAt, one recording) as a download, for keeping
// on a computer or USB stick. A plain link: the browser downloads it with
// the login cookie. `kind`:
//   "original"  a zip of each phone's file as recorded (not lined up)
//   "synced"    a zip of every angle trimmed to start and end together
//   "grid"      every angle side by side in one video (an MP4 for one
//               recording, a zip of them for the session)
// synced and grid have to be made first: see requestExport.
export function sessionDownloadUrl(id, { kind = "original", startedAt = null } = {}) {
  const query = new URLSearchParams();
  if (kind !== "original") query.set("kind", kind);
  if (startedAt != null) query.set("startedAt", String(startedAt));
  const search = query.toString();
  return `${SERVER_URL}/api/recordings/sessions/${encodeURIComponent(id)}/download` +
    (search ? `?${search}` : "");
}

// Asks the server to make a synced or grid download, and how far along it
// is: { state: "queued" | "working" | "ready" | "failed", progress (0-1),
// ready, total (recordings), waiting (other downloads ahead), error }. Safe
// to repeat; ask every few seconds until it's ready.
export async function requestExport(id, kind, startedAt = null) {
  return request(`/api/recordings/sessions/${encodeURIComponent(id)}/exports`, {
    method: "POST",
    body: JSON.stringify(startedAt == null ? { kind } : { kind, startedAt }),
  });
}

// `signal` stops it part way (a take starting): it then rejects with an
// AbortError. Sent in pieces (UPLOAD_PIECE_BYTES each) so a stopped or
// dropped upload carries on from what reached the server: pass the same
// `resume` object again ({} the first time; it remembers the upload). A
// server without resumable uploads gets the whole file in one request.
// `onProgress` hears how much has gone, 0 to 1, as it goes.
export async function uploadSessionVideo(
  id, startedAt, video, filename, actualStartedAt, startClock, signal, resume = {}, onProgress = null
) {
  const actual = Number.isFinite(actualStartedAt)
    ? `&actualStartedAt=${Math.round(actualStartedAt)}${startClock ? `&startClock=${startClock}` : ""}`
    : "";
  const query = `?sessionId=${encodeURIComponent(id)}&startedAt=${startedAt}${actual}`;
  const uploads = `${SERVER_URL}/api/files/uploads`;
  // The bars viewers see, every few seconds.
  let reportedAt = 0;
  const report = (sent) => {
    onProgress?.(sent / video.size);
    if (Date.now() - reportedAt < PROGRESS_EVERY_MS) return;
    reportedAt = Date.now();
    reportUploadProgress(id, startedAt, "full", sent / video.size).catch(() => {});
  };

  let offset = 0;
  if (resume.uploadId) {
    const status = await send("GET", `${uploads}/${resume.uploadId}`, null, { signal });
    if (status.status === 200 && status.data.size === video.size) offset = status.data.offset;
    else if (status.status === 404 || status.status === 200) resume.uploadId = null;
    else throw uploadError(status);
  }
  if (!resume.uploadId) {
    const started = await send("POST",
      `${uploads}${query}&size=${video.size}&name=${encodeURIComponent(filename)}`, null, { signal });
    if (started.status === 404) return uploadWhole(`${SERVER_URL}/api/files/upload${query}`, video, filename, signal, report);
    if (started.status !== 201) throw uploadError(started);
    resume.uploadId = started.data.uploadId;
  }

  while (offset < video.size) {
    const from = offset;
    const piece = video.slice(from, Math.min(from + UPLOAD_PIECE_BYTES, video.size));
    const sent = await send("PUT", `${uploads}/${resume.uploadId}?offset=${from}`, piece, {
      signal, onProgress: (loaded) => report(from + loaded),
    });
    if (sent.status === 200) {
      offset = sent.data.offset;
    } else if (sent.status === 409 && Number.isFinite(sent.data?.offset)) {
      // The server has a different amount (a piece that half arrived).
      offset = sent.data.offset;
    } else {
      throw uploadError(sent);
    }
  }
  const done = await send("POST", `${uploads}/${resume.uploadId}/complete`, null, { signal });
  if (done.status < 200 || done.status >= 300) throw uploadError(done);
}

// How much of a recording goes up in one request: small enough that a
// dropped connection loses little, big enough not to waste time on requests.
const UPLOAD_PIECE_BYTES = 4 * 1024 * 1024;

// The whole file in one multipart request, for a server without resumable
// uploads.
async function uploadWhole(url, video, filename, signal, report) {
  const body = new FormData();
  // Multipart uploads need the plain media type, without recorder codec details.
  body.append("file", new Blob([video], { type: video.type.split(";")[0] }), filename);
  const result = await send("POST", url, body, { signal, onProgress: report });
  if (result.status < 200 || result.status >= 300) throw uploadError(result);
}

function uploadError(result) {
  return new Error(result.data?.error || "Could not upload this recording.");
}

// One request with the login cookie, by XMLHttpRequest rather than fetch:
// it reports how much of the body has gone. Resolves {status, data} (the
// parsed JSON reply, or null); rejects when it can't reach the server, or
// with an AbortError when `signal` stops it.
function send(method, url, body, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    if (body instanceof Blob && !(body instanceof File)) {
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
    }
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded);
      };
    }
    xhr.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      resolve({ status: xhr.status, data: parsed });
    };
    xhr.onerror = () => reject(new Error("Could not upload this recording."));
    xhr.onabort = () => reject(new DOMException("Upload stopped", "AbortError"));
    if (signal?.aborted) {
      reject(new DOMException("Upload stopped", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

// Often enough for the bars to look alive, rarely enough not to compete
// with the upload on a slow connection.
const PROGRESS_EVERY_MS = 3000;

// How far along this device's upload of one angle is (stage "preview" or
// "full"), for the progress bars under angles still uploading.
export async function reportUploadProgress(id, startedAt, stage, fraction) {
  // No reply body (204), so not through request().
  await fetch(`${SERVER_URL}/api/recordings/sessions/${encodeURIComponent(id)}/upload-progress`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startedAt, stage, fraction }),
  });
}

export async function deleteSession(id) {
  await request(`/api/recordings/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// Deletes one recording of a session (every angle, and its comments).
// Admins only.
export async function deleteRecording(id, startedAt) {
  await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/recordings/${startedAt}`,
    { method: "DELETE" }
  );
}

// loads the notes left on one recording of a session
export async function getSessionNotes(id, startedAt) {
  const data = await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/notes?startedAt=${startedAt}`
  );
  return data.notes;
}

// adds a note at a point in that recording
export async function createSessionNote(id, startedAt, body, videoTimeMs) {
  await request(`/api/recordings/sessions/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    body: JSON.stringify({ startedAt, body, videoTimeMs }),
  });
}

export async function deleteSessionNote(id, noteId) {
  await request(
    `/api/recordings/sessions/${encodeURIComponent(id)}/notes/${noteId}`,
    { method: "DELETE" }
  );
}
