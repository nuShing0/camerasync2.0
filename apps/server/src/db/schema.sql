CREATE TABLE IF NOT EXISTS users (
    user_id     SERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(63) DEFAULT NULL,
    profile_picture TEXT,
    roles       JSON NOT NULL DEFAULT '[]',
    password    TEXT NOT NULL,
    organizations JSON DEFAULT NULL,
    settings JSON NOT NULL DEFAULT '{}',
    agreements JSON NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS sessions (
    user_id     BIGINT NOT NULL,
    session_token TEXT,
    csrf_token TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    device VARCHAR(32),
    expires TIMESTAMP DEFAULT NOW()
);

-- Every authenticated request looks a session up by its cookie value, so this
-- index keeps that lookup from becoming a sequential scan.
CREATE INDEX IF NOT EXISTS sessions_session_token_idx ON sessions (session_token);

CREATE TABLE IF NOT EXISTS groups (
    group_id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    is_public BOOLEAN NOT NULL DEFAULT TRUE,
    password_hash TEXT,
    owner_id BIGINT NOT NULL REFERENCES users(user_id),
    primary_color CHAR(7) NOT NULL DEFAULT '#ead217',
    secondary_color CHAR(7) NOT NULL DEFAULT '#0d0d0d',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (is_public OR password_hash IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS groups_group_id_lower_idx
    ON groups (LOWER(group_id));

CREATE TABLE IF NOT EXISTS group_members (
    group_id VARCHAR(64) NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

UPDATE group_members
SET role = 'member'
WHERE role NOT IN ('admin', 'member');

ALTER TABLE group_members
    DROP CONSTRAINT IF EXISTS group_members_role_check;

ALTER TABLE group_members
    ADD CONSTRAINT group_members_role_check
    CHECK (role IN ('admin', 'member'));

CREATE TABLE IF NOT EXISTS organizations (
    org_id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(64),
    admins JSON DEFAULT '[]',
    rec_sessions JSON DEFAULT '[]'
);

-- stores scheduled and live group sessions
CREATE TABLE IF NOT EXISTS recording_sessions (
    id VARCHAR(6) PRIMARY KEY
        CHECK (id ~ '^[a-z0-9]{6}$'),
    group_id VARCHAR(64) NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by BIGINT NOT NULL REFERENCES users(user_id),
    status VARCHAR(16) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'active', 'complete', 'cancelled'))
);

UPDATE recording_sessions
SET status = 'complete'
WHERE status = 'completed';

ALTER TABLE recording_sessions
    DROP CONSTRAINT IF EXISTS recording_sessions_status_check;

ALTER TABLE recording_sessions
    ADD CONSTRAINT recording_sessions_status_check
    CHECK (status IN ('scheduled', 'active', 'complete', 'cancelled'));

CREATE INDEX IF NOT EXISTS recording_sessions_group_date_idx
    ON recording_sessions (group_id, scheduled_at);

-- tracks users who joined each session
CREATE TABLE IF NOT EXISTS recording_session_members (
    session_id VARCHAR(6) NOT NULL
        REFERENCES recording_sessions(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS videos (
    recording_uri TEXT,
    session_id VARCHAR(255),
    author BIGINT
);

CREATE TABLE IF NOT EXISTS recordings (
    id uuid PRIMARY KEY,
    name text,
    status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'recording', 'stopped', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    stopped_at timestamptz,
    closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS posts (
    post_id     VARCHAR(255) PRIMARY KEY,
    author      BIGINT NOT NULL,
    content     TEXT,
    created_at  TIMESTAMP DEFAULT NOW(),
    video_meta  JSON,
    reply       VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS socket_io (
    id BIGSERIAL UNIQUE PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    payload BYTEA
);

CREATE TABLE IF NOT EXISTS socket_io_attachments (
    id BIGSERIAL UNIQUE PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    payload BYTEA
);
-- Keep session attendance even after a member leaves.
CREATE TABLE IF NOT EXISTS recording_session_participants (
    session_id VARCHAR(6) NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, user_id)
);

INSERT INTO recording_session_participants (session_id, user_id)
SELECT session_id, user_id FROM recording_session_members
ON CONFLICT DO NOTHING;

-- One row per video saved by a participant, not per shared start command.
CREATE TABLE IF NOT EXISTS recording_session_videos (
    session_id VARCHAR(6) NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    started_at_ms BIGINT NOT NULL,
    PRIMARY KEY (session_id, user_id, started_at_ms)
);

-- Older sessions did not track complete attendance or saved videos.
ALTER TABLE recording_sessions
    ADD COLUMN IF NOT EXISTS counts_tracked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE recording_sessions ALTER COLUMN counts_tracked SET DEFAULT TRUE;

ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS file_id TEXT;

-- Notes members leave on one recording while watching it back. A session can
-- hold several recordings, so started_at_ms says which one the note belongs to
-- (it matches recording_session_videos.started_at_ms). video_time_ms is the
-- point inside that recording the note is about, not when it was written.
CREATE TABLE IF NOT EXISTS session_notes (
    note_id SERIAL PRIMARY KEY,
    session_id VARCHAR(6) NOT NULL
        REFERENCES recording_sessions(id) ON DELETE CASCADE,
    started_at_ms BIGINT NOT NULL DEFAULT 0,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    video_time_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notes started out attached to the whole session.
ALTER TABLE session_notes
    ADD COLUMN IF NOT EXISTS started_at_ms BIGINT NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS session_notes_session_idx;

CREATE INDEX IF NOT EXISTS session_notes_recording_idx
    ON session_notes (session_id, started_at_ms, note_id);

-- One row per recording in a session, numbered in the order they were first
-- seen (the host's start command, or the first saved video for a start time
-- the server never announced, such as a manual shutter tap on a phone).
-- started_at_ms is the shared server-clock start that recording_session_videos
-- and session_notes also key on. Numbers are persisted so they survive server
-- restarts and stay stable when a device uploads late.
CREATE TABLE IF NOT EXISTS session_recordings (
    session_id VARCHAR(6) NOT NULL
        REFERENCES recording_sessions(id) ON DELETE CASCADE,
    started_at_ms BIGINT NOT NULL,
    recording_number INTEGER NOT NULL CHECK (recording_number > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, started_at_ms),
    UNIQUE (session_id, recording_number)
);

-- Number the recordings saved before this table existed, in start order.
INSERT INTO session_recordings (session_id, started_at_ms, recording_number)
SELECT session_id, started_at_ms,
       ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at_ms)
  FROM (SELECT DISTINCT session_id, started_at_ms
          FROM recording_session_videos) existing
 WHERE NOT EXISTS (SELECT 1 FROM session_recordings sr
                    WHERE sr.session_id = existing.session_id)
ON CONFLICT DO NOTHING;

-- Single-use, short-lived tokens for the forgot-password flow. Only a SHA-256
-- hash of the emailed token is stored, so a leaked table row can't be used to
-- reset anything.
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

-- Viewer tier (SCRUM-53): viewers can watch recordings but not record or
-- manage. The owner keeps a plain admin row and outranks other admins via
-- groups.owner_id, the same way permission checks always treated them.
ALTER TABLE group_members
    DROP CONSTRAINT IF EXISTS group_members_role_check;

ALTER TABLE group_members
    ADD CONSTRAINT group_members_role_check
    CHECK (role IN ('admin', 'member', 'viewer'));

-- Mobile forgot-password flow: alongside the emailed web link, each reset row
-- also carries a 6-digit code the phone app can submit directly. Only a
-- SHA-256 hash of the code is stored, and `attempts` caps guesses before the
-- row is burned (see /verify-reset-code in routes/auth.js).
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS code_hash CHAR(64);
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

-- Email verification (SCRUM-43). NULL email_verified_at = not confirmed yet;
-- such accounts can sign in but every other API is closed to them.
-- Adding the column with DEFAULT NOW() marks every account that already
-- exists as verified (so nobody is locked out by the upgrade); dropping the
-- default straight after makes new sign-ups start unverified. Both
-- statements are no-ops when this file is re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;

-- One pending confirmation per user: a 6-digit code for the apps and a link
-- token for the email button, both stored only as SHA-256 hashes. A new
-- request replaces the row, so only the newest code and link work.
CREATE TABLE IF NOT EXISTS email_verifications (
    user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    code_hash CHAR(64) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires TIMESTAMPTZ NOT NULL
);

-- Each group's invite: a short code (shown as ABC-DEF) that also makes its
-- link and QR. Anyone with it can join; an admin can swap it for a new one.
-- Groups made before invites get a code here.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code VARCHAR(16);
UPDATE groups
   SET invite_code = UPPER(SUBSTRING(MD5(group_id || RANDOM()::text) FROM 1 FOR 6))
 WHERE invite_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS groups_invite_code_idx ON groups (invite_code);

-- Someone asking to join a group by its ID, without an invite. They're in
-- once an admin approves; declining or approving removes the request.
CREATE TABLE IF NOT EXISTS group_join_requests (
    group_id VARCHAR(64) NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- Group passwords are gone (invites replaced them), and with them the
-- lockout for wrong ones.
DROP TABLE IF EXISTS group_join_attempts;

-- 8kount's yellow is now the design's #EAD217 (it was #ffc72c). Groups still
-- on the old gold move to the new one so they match the palette.
ALTER TABLE groups ALTER COLUMN primary_color SET DEFAULT '#ead217';
UPDATE groups SET primary_color = '#ead217' WHERE primary_color = '#ffc72c';

-- How much later (positive) or earlier this device's camera actually began
-- than the shared start time in started_at_ms, in server-clock ms. Phones
-- take a moment to start recording and can get the start command late, so
-- playback shifts each angle by this to line the angles up. NULL for
-- uploads from before this was tracked (treated as 0).
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS start_offset_ms INTEGER;

-- Where the sync beep (see src/recordings/syncBeep.js) was found in this
-- video, in ms from its start. Every camera heard the beep at the same
-- moment, so this lines the angles up more exactly than start_offset_ms,
-- which can't see a phone's camera warming up. NULL when it wasn't heard.
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS beep_at_ms INTEGER;

-- A session can stand on its own, without a group: whoever starts it shares
-- its code, and anyone signed in can join with it. Only its creator and the
-- people who joined can see it (see sessionVisibleSql in
-- middleware/groupRole.js).
ALTER TABLE recording_sessions ALTER COLUMN group_id DROP NOT NULL;

-- A session outlives the account that started it: deleting an account (which
-- both app stores require) keeps the team's recordings, with no creator.
ALTER TABLE recording_sessions ALTER COLUMN created_by DROP NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recording_sessions_created_by_fkey'
       AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE recording_sessions DROP CONSTRAINT recording_sessions_created_by_fkey;
    ALTER TABLE recording_sessions
      ADD CONSTRAINT recording_sessions_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL;
  END IF;
END $$;

-- When the end beep (see src/recordings/syncBeep.js) played for this
-- recording, in server-clock ms. The device that stops a take plays it just
-- before every camera stops. NULL for takes stopped before it existed.
ALTER TABLE session_recordings ADD COLUMN IF NOT EXISTS end_beep_epoch_ms BIGINT;

-- Where the end beep was found in this video, in ms from its start. Lines up
-- an angle that started too late to hear the start beep. NULL when it
-- wasn't heard.
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS end_beep_at_ms INTEGER;

-- When a device last joined or left this live session's room. A live
-- session nobody has been connected to for a while is ended automatically
-- (see src/sessions/idleSessions.js). NULL until the first join after this
-- column was added; created_at stands in.
ALTER TABLE recording_sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

-- A smaller copy of the video for the multi-angle grid (see
-- src/recordings/previews.js): its own file, or the same file_id when the
-- original is already small. NULL until it's made; preview_failed when it
-- couldn't be, so it isn't retried on every start.
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS preview_file_id TEXT;
ALTER TABLE recording_session_videos
    ADD COLUMN IF NOT EXISTS preview_failed BOOLEAN NOT NULL DEFAULT FALSE;

-- What start_offset_ms was measured from: 'frame' when the device reported
-- the moment its camera captured the first frame (exact), 'call' when it's
-- when the app asked the camera to start (up to a second early on some
-- phones). NULL for uploads from before this was recorded.
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS start_offset_source TEXT;

-- A still from the video for the session lists (see
-- src/recordings/thumbnails.js). NULL until it's made; thumbnail_failed
-- when it couldn't be, so it isn't retried on every start.
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS thumbnail_file_id TEXT;
ALTER TABLE recording_session_videos
    ADD COLUMN IF NOT EXISTS thumbnail_failed BOOLEAN NOT NULL DEFAULT FALSE;

-- Whether a video that is its own preview (small enough) has had its codec
-- checked: one that every phone can't play (a laptop's VP9) gets an H.264
-- copy instead. FALSE for previews decided before codecs were checked, which
-- are checked once (see src/recordings/previews.js).
ALTER TABLE recording_session_videos
    ADD COLUMN IF NOT EXISTS preview_checked BOOLEAN NOT NULL DEFAULT FALSE;


-- Files a take no longer uses (a phone's preview, once the full video is
-- in), kept for a while so anyone already watching them can finish (see
-- src/recordings/retiredFiles.js).
CREATE TABLE IF NOT EXISTS retired_files (
    file_id TEXT PRIMARY KEY,
    session_id VARCHAR(6) NOT NULL,
    retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Small stills several a second, tiled to sheets, shown while the seek bar
-- is dragged (see src/recordings/scrubFrames.js): {fps, width, height, cols,
-- rows, frames, sheets: [file ids]}. NULL until made; scrub_failed when they
-- couldn't be, so they aren't retried on every start.
ALTER TABLE recording_session_videos ADD COLUMN IF NOT EXISTS scrub JSONB;
ALTER TABLE recording_session_videos
    ADD COLUMN IF NOT EXISTS scrub_failed BOOLEAN NOT NULL DEFAULT FALSE;

-- Finding a stored file's video row (the access check on /api/files/get),
-- by whichever column it's in, without scanning every recording.
CREATE INDEX IF NOT EXISTS recording_session_videos_file_idx
    ON recording_session_videos (file_id);
CREATE INDEX IF NOT EXISTS recording_session_videos_preview_idx
    ON recording_session_videos (preview_file_id);
CREATE INDEX IF NOT EXISTS recording_session_videos_thumbnail_idx
    ON recording_session_videos (thumbnail_file_id);
CREATE INDEX IF NOT EXISTS recording_session_videos_scrub_sheets_idx
    ON recording_session_videos USING gin ((scrub->'sheets'));

-- Uploads sent in pieces (see src/routes/file.js), until the last piece is
-- in: whose, the file type, its full size, and the take's details (the
-- /upload query) to file it with.
CREATE TABLE IF NOT EXISTS resumable_uploads (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    ext TEXT NOT NULL,
    size BIGINT NOT NULL,
    query JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A recording deleted on its own (its videos are gone): the number stays
-- taken, and late uploads for it are refused (see recordings/numbering.js).
ALTER TABLE session_recordings ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Tracks when users download specific files from a recording session
CREATE TABLE IF NOT EXISTS download_logs (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(6) NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL, 
    file_type VARCHAR(50), 
    file_id TEXT, 
    ip_address VARCHAR(45),
    downloaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_download_logs_session_id ON download_logs(session_id);

-- Which recording in the session ("Recording 003") a download was of, so the
-- download audit can group a session's downloads by take. A session download
-- (the zip on the playback page) logs one row per recording it contains.
ALTER TABLE download_logs ADD COLUMN IF NOT EXISTS recording_number INTEGER;

-- The download audit filters every query by date.
CREATE INDEX IF NOT EXISTS idx_download_logs_downloaded_at ON download_logs(downloaded_at);
