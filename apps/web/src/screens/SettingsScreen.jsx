import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import packageJson from "../../package.json";
import { useAuth } from "../auth/AuthContext.jsx";
import { changePassword, deleteAccount } from "../api/auth.js";
import { getGroups, getPrimaryGroupId } from "../api/groups.js";

const MIN_PASSWORD_LENGTH = 8;

/// The Settings tab: the account (name, email, password, sign out), the
/// primary group whose color the app takes, and an About section. The mobile
/// app's Settings tab has the same sections.
export function SettingsScreen() {
  return (
    <div className="st-page">
      <style>{css}</style>
      <h1>Settings</h1>
      <AccountSection />
      <PrimaryGroupSection />
      <AboutSection />
      <DeleteAccountSection />
    </div>
  );
}

function AccountSection() {
  const { user, updateProfile, logout } = useAuth();
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(user.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");

  const saveName = async (event) => {
    event.preventDefault();
    setSavingName(true);
    setNameError("");
    try {
      await updateProfile({ name });
      setEditingName(false);
    } catch (err) {
      setNameError(err.message);
    } finally {
      setSavingName(false);
    }
  };

  return (
    <section className="st-card">
      <h2>Account</h2>
      <div className="st-row">
        <span className="st-label">Name</span>
        {editingName ? (
          <form className="st-inline-form" onSubmit={saveName}>
            <input value={name} maxLength={63} autoFocus aria-label="Name"
              onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="st-button st-button-primary"
              disabled={savingName || !name.trim()}>
              {savingName ? "Saving..." : "Save"}
            </button>
            <button type="button" className="st-button" disabled={savingName}
              onClick={() => { setEditingName(false); setName(user.name ?? ""); setNameError(""); }}>
              Cancel
            </button>
          </form>
        ) : (
          <span className="st-value">
            {user.name || "—"}
            <button type="button" className="st-link" onClick={() => setEditingName(true)}>
              Edit
            </button>
          </span>
        )}
      </div>
      {nameError && <p role="alert" className="st-error">{nameError}</p>}
      <div className="st-row">
        <span className="st-label">Email</span>
        <span className="st-value">
          {user.email}
          {user.emailVerified && <span className="st-badge">Verified</span>}
        </span>
      </div>
      <PasswordRow />
      <div className="st-actions">
        <button type="button" className="st-button" onClick={logout}>Log out</button>
      </div>
    </section>
  );
}

function PasswordRow() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const update = (field) => (event) =>
    setForm((current) => ({ ...current, [field]: event.target.value }));

  const save = async (event) => {
    event.preventDefault();
    setError("");
    if (form.next.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (form.next !== form.confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setSaving(true);
    try {
      await changePassword({ currentPassword: form.current, newPassword: form.next });
      setForm({ current: "", next: "", confirm: "" });
      setOpen(false);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="st-row">
        <span className="st-label">Password</span>
        <span className="st-value">
          ••••••••
          {!open && (
            <button type="button" className="st-link"
              onClick={() => { setOpen(true); setDone(false); }}>
              Change
            </button>
          )}
        </span>
      </div>
      {done && (
        <p className="st-success">Password changed. Your other devices were signed out.</p>
      )}
      {open && (
        <form className="st-password-form" onSubmit={save}>
          <label>
            Current password
            <input type="password" autoComplete="current-password" required
              value={form.current} onChange={update("current")} />
          </label>
          <label>
            New password
            <input type="password" autoComplete="new-password" required
              value={form.next} onChange={update("next")} />
          </label>
          <label>
            Confirm new password
            <input type="password" autoComplete="new-password" required
              value={form.confirm} onChange={update("confirm")} />
          </label>
          <button type="button" className="st-link st-reset-link"
            disabled={saving}
            onClick={() => navigate("/forgot-password", {
              state: { resetEmail: user.email },
            })}>
            Forgot your current password?
          </button>
          {error && <p role="alert" className="st-error">{error}</p>}
          <div className="st-actions">
            <button type="button" className="st-button" disabled={saving}
              onClick={() => { setOpen(false); setError(""); setForm({ current: "", next: "", confirm: "" }); }}>
              Cancel
            </button>
            <button type="submit" className="st-button st-button-primary" disabled={saving}>
              {saving ? "Saving..." : "Change password"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function PrimaryGroupSection() {
  const { user, updateProfile } = useAuth();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getGroups()
      .then(setGroups)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const primaryId = getPrimaryGroupId(user, groups);

  const change = async (event) => {
    setSaving(true);
    setError("");
    try {
      await updateProfile({ primaryGroupId: event.target.value });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="st-card">
      <h2>Primary group</h2>
      <p>The app uses this group's team color, on every device you sign in on.</p>
      {loading ? <p>Loading groups...</p> : groups.length === 0 ? (
        <p>You're not in a group yet. <Link to="/groups">Find or create one</Link>.</p>
      ) : (
        <select value={primaryId} onChange={change} disabled={saving}
          aria-label="Primary group">
          {groups.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
      )}
      {error && <p role="alert" className="st-error">{error}</p>}
    </section>
  );
}

function AboutSection() {
  return (
    <section className="st-card">
      <h2>About</h2>
      <p>
        <strong>8kount</strong> · version {packageJson.version}
      </p>
      <p>
        Record practices from several phones at once, then review every angle
        together with timestamped comments. Built by a UCF senior design team.
      </p>
      <p><Link to="/privacy">Privacy policy</Link></p>
    </section>
  );
}

// Required by both app stores: anyone who can make an account can delete it.
function DeleteAccountSection() {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const remove = async (event) => {
    event.preventDefault();
    setError("");
    setDeleting(true);
    try {
      await deleteAccount(password);
      // Signs out here too (the server already ended every session).
      await logout();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <section className="st-card st-danger-card">
      <h2>Delete account</h2>
      <p>
        Permanently deletes your account, the videos you recorded and your
        comments. Sessions you started stay for your team. If you own a group,
        hand it over or delete it first.
      </p>
      {!open ? (
        <div className="st-actions">
          <button type="button" className="st-button st-button-danger"
            onClick={() => setOpen(true)}>Delete account</button>
        </div>
      ) : (
        <form className="st-password-form" onSubmit={remove}>
          <label>
            Enter your password to confirm
            <input type="password" autoComplete="current-password" required
              value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p role="alert" className="st-error">{error}</p>}
          <div className="st-actions">
            <button type="button" className="st-button" disabled={deleting}
              onClick={() => { setOpen(false); setPassword(""); setError(""); }}>
              Cancel
            </button>
            <button type="submit" className="st-button st-button-danger" disabled={deleting || !password}>
              {deleting ? "Deleting..." : "Delete my account"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

const css = `
  .st-danger-card h2 { color: #ff8a80; }
  .st-page .st-button-danger { border-color: #c0392b; background: #c0392b; color: #fff; }
  .st-page .st-button-danger:hover:not(:disabled) { background: #a93226; }
  .st-page { max-width: 640px; display: flex; flex-direction: column; gap: 16px; }
  .st-page h1 { margin: 0 0 4px; font-size: 1.8rem; }
  .st-card { padding: 18px 20px; border-radius: 14px; background: #151515; }
  .st-card h2 { margin: 0 0 10px; font-size: 1.1rem; }
  .st-card p { margin: 0 0 10px; color: #aaa; font-size: 0.9rem; line-height: 1.5; }
  .st-card p a { color: var(--accent); }
  .st-row {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px;
    padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.05);
  }
  .st-card h2 + .st-row { border-top: none; }
  .st-label { width: 90px; color: #999; font-weight: 600; font-size: 0.85rem; }
  .st-value { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; overflow-wrap: anywhere; }
  .st-badge {
    padding: 2px 8px; border-radius: 999px; background: #1f3a24; color: #8bd48b;
    font-size: 0.7rem; font-weight: 700;
  }
  .st-link {
    margin-left: auto; padding: 0; border: none; background: none;
    color: var(--accent); font: inherit; font-weight: 600; cursor: pointer;
  }
  .st-inline-form { flex: 1; display: flex; flex-wrap: wrap; gap: 8px; }
  .st-inline-form input, .st-password-form input, .st-card select {
    box-sizing: border-box; padding: 8px 10px; border: 1px solid #3a3a3a; border-radius: 7px;
    background: #262626; color: #f0f0f0; font: inherit;
  }
  .st-inline-form input { flex: 1; min-width: 160px; }
  .st-card select { width: 100%; }
  .st-password-form { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 6px; }
  .st-password-form label { display: flex; flex-direction: column; gap: 6px; color: #ddd; font-size: 0.85rem; font-weight: 600; }
  .st-password-form .st-reset-link { margin: 0; align-self: flex-start; }
  .st-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
  .st-button {
    padding: 8px 14px; border: 1px solid #3a3a3a; border-radius: 7px;
    background: #262626; color: #f0f0f0; font: inherit; font-weight: 600; cursor: pointer;
  }
  .st-button:hover { background: #303030; }
  .st-button:disabled { opacity: 0.5; cursor: default; }
  .st-button-primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); }
  .st-button-primary:hover { background: var(--accent-hover); }
  .st-error { color: #ff8a80 !important; }
  .st-success { color: #8bd48b !important; }
`;
