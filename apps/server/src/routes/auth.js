import crypto from "node:crypto";

import { Router } from "express";
import bcrypt from "bcryptjs";

import { pool } from "../db/pool.js";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../email/mailer.js";
import { signupEmailError } from "../auth/emailPolicy.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { storage } from "../storage/index.js";
import { storedFileIds } from "./file.js";
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getUserBySessionToken,
  NOTIFICATION_KINDS,
  publicUser,
  sessionCookieOptions,
} from "../auth/sessions.js";

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

// Compared against when a login email is unknown, so that path pays for a
// bcrypt verification too and response timing can't reveal which emails have
// accounts. The plaintext is random per boot, so it never matches anyone.
const DUMMY_HASH = bcrypt.hashSync(
  crypto.randomBytes(16).toString("hex"),
  BCRYPT_ROUNDS
);

// Postgres unique-constraint violation. Turns a race on the users_email_key
// index into a clean 409 instead of a 500.
const PG_UNIQUE_VIOLATION = "23505";

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

authRouter.post("/register", async (req, res, next) => {
  try {
    const { name, password } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    const emailError = signupEmailError(email);
    if (emailError) {
      return res.status(400).json({ error: emailError });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

    let row;
    try {
      const result = await pool.query(
        `INSERT INTO users (email, display_name, password)
         VALUES ($1, $2, $3)
         RETURNING user_id, email, display_name, roles, email_verified_at, settings`,
        [email, name?.trim() || null, passwordHash]
      );
      row = result.rows[0];
    } catch (err) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res
          .status(409)
          .json({ error: "An account with that email already exists." });
      }
      throw err;
    }

    await startVerification(row.user_id, row.email);

    // Signed in straight away, but unverified: the apps show the "confirm
    // your email" screen and every other API answers EMAIL_UNVERIFIED.
    const token = await createSession(row.user_id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.status(201).json({ user: publicUser(row) });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const { password } = req.body ?? {};
    const email = normalizeEmail(req.body?.email);

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const { rows } = await pool.query(
      `SELECT user_id, email, display_name, roles, password, email_verified_at,
              settings
         FROM users
        WHERE email = $1`,
      [email]
    );
    const row = rows[0];

    // Same response — and the same bcrypt cost — whether the email is unknown
    // or the password is wrong, so neither the body nor the response timing
    // can be used to discover which emails have accounts.
    const match = await bcrypt.compare(
      String(password),
      row ? row.password : DUMMY_HASH
    );
    const ok = Boolean(row) && match;
    if (!ok) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    const token = await createSession(row.user_id);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json({ user: publicUser(row) });
  } catch (err) {
    next(err);
  }
});

// Who am I? The browser can't read the httpOnly cookie, so the web app calls
// this on start-up to restore the signed-in user.
authRouter.get("/me", async (req, res, next) => {
  try {
    const row = await getUserBySessionToken(req.cookies?.[SESSION_COOKIE]);
    if (!row) return res.status(401).json({ error: "Not authenticated" });
    res.json({ user: publicUser(row) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- email
// confirmation (SCRUM-43). Sign-up emails a 6-digit code (typed into the web
// or mobile app) and a link (clicked from the inbox); either one confirms.

// Long enough to find the email the next morning.
const VERIFY_TTL_MS = 1000 * 60 * 60 * 24;
// Same guess cap as the password-reset code, for the same reason.
const MAX_VERIFY_ATTEMPTS = 5;
// Keeps a held-down "Resend" button from spamming an inbox.
const RESEND_COOLDOWN_MS = 1000 * 30;

// Issue (or replace) the user's pending confirmation and email it. Sending
// is fire-and-forget so a slow or broken mail provider can't fail sign-up;
// the user can always ask for a new code.
async function startVerification(userId, email) {
  const token = crypto.randomBytes(32).toString("hex");
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await pool.query(
    `INSERT INTO email_verifications (user_id, code_hash, token_hash, expires)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
        SET code_hash = EXCLUDED.code_hash,
            token_hash = EXCLUDED.token_hash,
            attempts = 0,
            created_at = NOW(),
            expires = EXCLUDED.expires`,
    [userId, hashResetToken(code), hashResetToken(token),
      new Date(Date.now() + VERIFY_TTL_MS)]
  );

  const origin = process.env.WEB_ORIGIN || "http://localhost:5173";
  sendVerificationEmail(email, `${origin}/verify-email?token=${token}`, code)
    .catch((err) => {
      console.error(`[verify-email] send to ${email} failed:`, err.message);
    });
}

// Confirm the account and drop its pending code; returns the updated user.
async function markVerified(userId) {
  await pool.query(`DELETE FROM email_verifications WHERE user_id = $1`, [userId]);
  const { rows } = await pool.query(
    `UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, NOW())
      WHERE user_id = $1
      RETURNING user_id, email, display_name, roles, email_verified_at, settings`,
    [userId]
  );
  return rows[0];
}

// Confirm with the code from the email (signed-in app) or the link token
// (from the inbox, possibly on another device, so no session is needed).
authRouter.post("/verify-email", async (req, res, next) => {
  try {
    const { code, token } = req.body ?? {};

    if (token) {
      const { rows } = await pool.query(
        `DELETE FROM email_verifications
          WHERE token_hash = $1 AND expires > NOW()
          RETURNING user_id`,
        [hashResetToken(String(token))]
      );
      if (rows.length === 0) {
        return res.status(400).json({
          error: "This confirmation link is invalid or has expired. Sign in to get a new one.",
        });
      }
      return res.json({ user: publicUser(await markVerified(rows[0].user_id)) });
    }

    const user = await getUserBySessionToken(req.cookies?.[SESSION_COOKIE]);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (user.email_verified_at) return res.json({ user: publicUser(user) });
    if (!code) return res.status(400).json({ error: "Enter the 6-digit code." });

    // Counting the attempt in the lookup keeps racing guesses honest.
    const { rows } = await pool.query(
      `UPDATE email_verifications
          SET attempts = attempts + 1
        WHERE user_id = $1 AND expires > NOW()
        RETURNING code_hash, attempts`,
      [user.user_id]
    );
    const pending = rows[0];
    if (!pending) {
      return res.status(400).json({
        error: "That code has expired. Send yourself a new one.",
      });
    }
    if (pending.attempts > MAX_VERIFY_ATTEMPTS) {
      await pool.query(`DELETE FROM email_verifications WHERE user_id = $1`, [
        user.user_id,
      ]);
      return res.status(400).json({
        error: "Too many wrong codes. Send yourself a new one.",
      });
    }
    const ok = crypto.timingSafeEqual(
      Buffer.from(hashResetToken(String(code).trim())),
      Buffer.from(pending.code_hash)
    );
    if (!ok) {
      return res.status(400).json({ error: "That code isn't right. Check the email and try again." });
    }

    res.json({ user: publicUser(await markVerified(user.user_id)) });
  } catch (err) {
    next(err);
  }
});

// Email a fresh code and link to the signed-in, unconfirmed user.
authRouter.post("/resend-verification", async (req, res, next) => {
  try {
    const user = await getUserBySessionToken(req.cookies?.[SESSION_COOKIE]);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    if (user.email_verified_at) {
      return res.status(400).json({ error: "Your email is already confirmed." });
    }

    const { rows } = await pool.query(
      `SELECT created_at FROM email_verifications WHERE user_id = $1`,
      [user.user_id]
    );
    if (rows[0] && Date.now() - new Date(rows[0].created_at) < RESEND_COOLDOWN_MS) {
      return res.status(429).json({
        error: "A code was just sent. Give it a moment before asking for another.",
      });
    }

    await startVerification(user.user_id, user.email);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Reset links die after an hour; a forgotten password is reset within minutes,
// and anything older is more likely a forgotten inbox than a real attempt.
const RESET_TTL_MS = 1000 * 60 * 60;

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Start a password reset. The response is identical whether or not the email
// has an account, so this endpoint can't be used to discover which emails are
// registered (the web client ignores the status anyway — see web/api/auth.js).
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const { rows } = await pool.query(
      `SELECT user_id FROM users WHERE email = $1`,
      [email]
    );
    const row = rows[0];

    if (row) {
      const token = crypto.randomBytes(32).toString("hex");
      // The emailed 6-digit code lets the mobile app finish the reset in-app
      // (via /verify-reset-code) instead of following the web link.
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
      const expires = new Date(Date.now() + RESET_TTL_MS);

      // A fresh request replaces any earlier link so only the newest works.
      await pool.query(`DELETE FROM password_resets WHERE user_id = $1`, [
        row.user_id,
      ]);
      await pool.query(
        `INSERT INTO password_resets (token_hash, user_id, expires, code_hash)
         VALUES ($1, $2, $3, $4)`,
        [hashResetToken(token), row.user_id, expires, hashResetToken(code)]
      );

      const origin = process.env.WEB_ORIGIN || "http://localhost:5173";
      // Fire-and-forget: the 204 must not wait on (or reveal anything about)
      // the SMTP conversation, so send failures only reach the server log.
      sendPasswordResetEmail(
        email,
        `${origin}/reset-password?token=${token}`,
        code
      ).catch((err) => {
        console.error(`[password-reset] send to ${email} failed:`, err.message);
      });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// A 6-digit code only has a million possibilities, so each reset row allows a
// handful of guesses before it is deleted and the user must request a new one.
const MAX_CODE_ATTEMPTS = 5;

// Exchange the emailed 6-digit code for a reset token (mobile flow). Every
// failure returns the same message so the endpoint can't be used to discover
// which emails have accounts or pending resets.
authRouter.post("/verify-reset-code", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code ?? "").trim();
    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required." });
    }

    const invalid = () =>
      res.status(400).json({ error: "That code is invalid or has expired." });

    // Counting the attempt in the same statement as the lookup keeps racing
    // guesses from sharing one attempt.
    const { rows } = await pool.query(
      `UPDATE password_resets pr
          SET attempts = pr.attempts + 1
         FROM users u
        WHERE u.user_id = pr.user_id
          AND u.email = $1
          AND pr.expires > NOW()
        RETURNING pr.user_id, pr.code_hash, pr.attempts`,
      [email]
    );
    const row = rows[0];
    if (!row || !row.code_hash) return invalid();

    if (row.attempts > MAX_CODE_ATTEMPTS) {
      await pool.query(`DELETE FROM password_resets WHERE user_id = $1`, [
        row.user_id,
      ]);
      return invalid();
    }

    const ok = crypto.timingSafeEqual(
      Buffer.from(hashResetToken(code)),
      Buffer.from(row.code_hash)
    );
    if (!ok) return invalid();

    // Rotate the token so this response becomes the only credential that can
    // finish the reset; the emailed link dies with the old hash.
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `UPDATE password_resets SET token_hash = $1 WHERE user_id = $2`,
      [hashResetToken(token), row.user_id]
    );

    res.json({ token });
  } catch (err) {
    next(err);
  }
});

// Complete a reset with the token from the emailed link. The DELETE doubles as
// the lookup: it atomically consumes the token, so a link can't be used twice
// even by two racing requests.
authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body ?? {};
    if (!token || !password) {
      return res
        .status(400)
        .json({ error: "Token and password are required." });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    const { rows } = await pool.query(
      `DELETE FROM password_resets
        WHERE token_hash = $1
          AND expires > NOW()
        RETURNING user_id`,
      [hashResetToken(token)]
    );
    const row = rows[0];
    if (!row) {
      return res
        .status(400)
        .json({ error: "This reset link is invalid or has expired." });
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    // The reset token arrived by email, which proves the inbox is theirs, so
    // this also confirms an account that was never verified.
    await pool.query(
      `UPDATE users
          SET password = $1,
              email_verified_at = COALESCE(email_verified_at, NOW())
        WHERE user_id = $2`,
      [passwordHash, row.user_id]
    );

    // The password just changed hands; every existing session goes with it so
    // whoever prompted the reset is signed out everywhere.
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [row.user_id]);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const MAX_NAME_LENGTH = 63; // users.display_name is VARCHAR(63)

// Settings page: change the display name and/or the primary group (the group
// whose color the apps take). Send primaryGroupId: null to fall back to the
// first joined group.
authRouter.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const hasName = body.name !== undefined;
    const hasGroup = body.primaryGroupId !== undefined;
    const hasPrefs = body.notificationPrefs !== undefined;
    const hasOrder = body.groupOrder !== undefined;
    if (!hasName && !hasGroup && !hasPrefs && !hasOrder) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    // Only the known switches, and only true or false.
    let prefs = null;
    if (hasPrefs) {
      const sent = body.notificationPrefs;
      const keys = ["push", ...NOTIFICATION_KINDS];
      if (!sent || typeof sent !== "object" || Array.isArray(sent) ||
          Object.entries(sent).some(([key, value]) => !keys.includes(key) || typeof value !== "boolean")) {
        return res.status(400).json({ error: "Invalid notification settings." });
      }
      prefs = sent;
    }

    // The order of the user's group list: group IDs, as dragged on the
    // Groups screen. IDs of groups they're not in are harmless (ignored).
    let order = null;
    if (hasOrder) {
      const sent = body.groupOrder;
      if (!Array.isArray(sent) || sent.length > 500 ||
          sent.some((id) => typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id))) {
        return res.status(400).json({ error: "Invalid group order." });
      }
      order = [...new Set(sent)];
    }

    const name = hasName ? String(body.name ?? "").trim() : null;
    if (hasName && (!name || name.length > MAX_NAME_LENGTH)) {
      return res.status(400).json({
        error: `Name must be 1 to ${MAX_NAME_LENGTH} characters.`,
      });
    }

    let groupId = null;
    if (hasGroup && body.primaryGroupId !== null) {
      // Stored with the group's own capitalization, and only for a group the
      // user actually belongs to.
      const { rows } = await pool.query(
        `SELECT group_id FROM group_members
          WHERE user_id = $1 AND LOWER(group_id) = LOWER($2)`,
        [req.user.id, String(body.primaryGroupId)]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: "You're not a member of that group." });
      }
      groupId = rows[0].group_id;
    }

    const { rows } = await pool.query(
      `UPDATE users
          SET display_name = COALESCE($2, display_name),
              settings = (
                COALESCE(settings::jsonb, '{}'::jsonb)
                || CASE WHEN $3::boolean
                     THEN jsonb_build_object('primaryGroupId', $4::text)
                     ELSE '{}'::jsonb END
                || CASE WHEN $5::jsonb IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('notificationPrefs',
                       COALESCE(settings::jsonb -> 'notificationPrefs', '{}'::jsonb) || $5::jsonb)
                   END
                || CASE WHEN $6::jsonb IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('groupOrder', $6::jsonb)
                   END
              )::json
        WHERE user_id = $1
        RETURNING user_id, email, display_name, roles, email_verified_at, settings`,
      [req.user.id, name, hasGroup, groupId,
        prefs === null ? null : JSON.stringify(prefs),
        order === null ? null : JSON.stringify(order)]
    );
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// Change the password while signed in. Every other session is signed out, so
// a device someone else was using loses access; this one stays signed in.
authRouter.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Enter your current and new password." });
    }
    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    const { rows } = await pool.query(
      "SELECT password FROM users WHERE user_id = $1",
      [req.user.id]
    );
    if (!(await bcrypt.compare(String(currentPassword), rows[0].password))) {
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    await pool.query("UPDATE users SET password = $1 WHERE user_id = $2", [
      passwordHash,
      req.user.id,
    ]);
    await pool.query(
      "DELETE FROM sessions WHERE user_id = $1 AND session_token <> $2",
      [req.user.id, req.cookies[SESSION_COOKIE]]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Deletes the signed-in account and everything that's only theirs: their
// videos (files too), comments, memberships and sign-ins. Both app stores
// require this in the app. A group they own must be handed over or deleted
// first, so a team never loses its group; sessions they started stay for
// everyone else, with no creator.
authRouter.delete("/me", requireAuth, async (req, res, next) => {
  const { password } = req.body ?? {};
  if (!password) {
    return res.status(400).json({ error: "Enter your password to delete your account." });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT password FROM users WHERE user_id = $1",
      [req.user.id]
    );
    if (!rows[0] || !(await bcrypt.compare(String(password), rows[0].password))) {
      return res.status(400).json({ error: "Password is incorrect." });
    }

    const owned = await client.query(
      "SELECT group_id, name FROM groups WHERE owner_id = $1 ORDER BY name",
      [req.user.id]
    );
    if (owned.rowCount > 0) {
      const names = owned.rows.map((group) => group.name).join(", ");
      return res.status(409).json({
        error: `You own ${names}. Transfer ownership or delete ${
          owned.rowCount === 1 ? "it" : "them"
        } first, then delete your account.`,
        groups: owned.rows.map((group) => ({ id: group.group_id, name: group.name })),
      });
    }

    await client.query("BEGIN");
    const files = await client.query(
      `SELECT file_id, preview_file_id, thumbnail_file_id, scrub FROM recording_session_videos
        WHERE user_id = $1 AND file_id IS NOT NULL`,
      [req.user.id]
    );
    // Sign-ins aren't linked to the user row, so they go by hand.
    await client.query("DELETE FROM sessions WHERE user_id = $1", [req.user.id]);
    await client.query("DELETE FROM users WHERE user_id = $1", [req.user.id]);
    await client.query("COMMIT");

    const fileIds = storedFileIds(files.rows);
    if (fileIds.length > 0) {
      // The account is gone either way; a file left behind is only space.
      await storage.remove(fileIds).catch((err) =>
        console.error("Unable to delete a deleted account's videos:", err));
    }
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    await deleteSession(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, {
      ...sessionCookieOptions(),
      maxAge: undefined,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
