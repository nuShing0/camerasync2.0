import "dotenv/config";
import http from "node:http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import timesyncServer from "timesync/server/index.js";

import { healthRouter } from "./routes/health.js";
import { initSocket } from "./sockets/websocket.js";
import { startIdleSessionChecks } from "./sessions/idleSessions.js";
import { startPreviewBackfill } from "./recordings/previews.js";
import { startThumbnailBackfill } from "./recordings/thumbnails.js";
import { startScrubBackfill } from "./recordings/scrubFrames.js";
import { startUnfinishedUploadSweep } from "./routes/file.js";
import { startRetiredFileSweep } from "./recordings/retiredFiles.js";
import { authRouter } from "./routes/auth.js";
import { groupRouter } from "./routes/groups.js";
import { postRouter } from "./routes/posts.js";
import { recordingsRouter } from './routes/recordings.js';
import { fileRouter } from "./routes/file.js";
import { notificationsRouter } from "./routes/notifications.js";
import { auditLogRouter } from "./routes/auditLogs.js";

const PORT = process.env.PORT || 4000;
const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:5173";

const app = express();
// credentials:true is required for the browser to send/accept the httpOnly
// session cookie cross-origin (Vite on :5173 -> API on :4000).
app.use(cors({ origin: WEB_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/health", healthRouter);
app.use("/timesync", timesyncServer.requestHandler);

// Status message for root route
app.get("/", async (req, res) => {
  res.status(200).json({"status": "OK"})
})

// REST routes go here as the API grows:
app.use("/api/auth", authRouter);
app.use("/api/groups", groupRouter);
app.use("/api/posts", postRouter);
app.use("/api/recordings", recordingsRouter);
app.use("/api/files", fileRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/audit-logs", auditLogRouter);

const server = http.createServer(app);

// Create web socket
initSocket(server);
startIdleSessionChecks();
startPreviewBackfill();
startThumbnailBackfill();
startScrubBackfill();
startUnfinishedUploadSweep();
startRetiredFileSweep();

server.listen(PORT, () => {
  console.log(`[camerasync] server listening on http://localhost:${PORT}`);
  console.log(`[camerasync] socket.io ready, web origin: ${WEB_ORIGIN}`);
});
