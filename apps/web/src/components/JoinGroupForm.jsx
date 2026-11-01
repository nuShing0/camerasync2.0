import { useEffect, useState } from "react";

import { getInvite, inviteCodeFrom, joinWithInvite, requestToJoin } from "../api/groups.js";
import { groupTile } from "../theme/groupTheme.js";

/// Joining a group: paste the invite link or type its code, see which group
/// it is, and join. Without an invite, ask to join by the group's exact ID
/// and an admin lets you in.
export function JoinGroupForm({ onJoined }) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="join-form">
      <style>{css}</style>
      {asking
        ? <AskToJoin onBack={() => setAsking(false)} />
        : <WithInvite onJoined={onJoined} onAsk={() => setAsking(true)} />}
    </div>
  );
}

function WithInvite({ onJoined, onAsk }) {
  const [text, setText] = useState("");
  const [group, setGroup] = useState(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const code = inviteCodeFrom(text);

  // Looks the code up once it's complete, shortly after typing stops.
  useEffect(() => {
    setGroup(null);
    setError("");
    if (code.length < 6) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLooking(true);
      getInvite(code)
        .then((found) => { if (!cancelled) setGroup(found); })
        .catch((err) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setLooking(false); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [code]);

  const join = async () => {
    setJoining(true);
    setError("");
    try {
      onJoined(await joinWithInvite(code));
    } catch (err) {
      setError(err.message);
      setJoining(false);
    }
  };

  const tile = group && groupTile(group);

  return (
    <>
      <label className="join-field">
        Invite code or link
        <input type="text" value={text} autoComplete="off" spellCheck={false}
          placeholder="ABC-DEF or a link"
          onChange={(event) => setText(event.target.value)} />
      </label>
      <p className="join-hint">Get it from your coach or anyone in the group: a link, a code, or a QR to scan with your phone.</p>
      {looking && <p className="join-hint">Looking up the invite...</p>}
      {error && <p role="alert" className="join-error">{error}</p>}
      {group && (
        <div className="join-preview" style={tile ? { background: tile.fill, color: tile.ink } : undefined}>
          <span>
            <strong>{group.name}</strong>
            <small>{group.memberCount} {group.memberCount === 1 ? "member" : "members"}</small>
          </span>
          {group.isMember ? (
            <button type="button" onClick={() => onJoined(group)}>Open</button>
          ) : (
            <button type="button" disabled={joining} onClick={join}>
              {joining ? "Joining..." : "Join"}
            </button>
          )}
        </div>
      )}
      {group?.isMember && <p className="join-hint">You're already in this group.</p>}
      <button type="button" className="join-switch" onClick={onAsk}>
        No invite? Ask to join with the group's ID
      </button>
    </>
  );
}

function AskToJoin({ onBack }) {
  const [id, setId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const send = async (event) => {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      setResult(await requestToJoin(id.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  if (result) {
    return (
      <>
        <p className="join-done">
          {result.status === "member"
            ? `You're already in ${result.group.name}.`
            : `Request sent to ${result.group.name}. You'll be in once an admin approves it.`}
        </p>
        <button type="button" className="join-switch" onClick={onBack}>Have an invite instead?</button>
      </>
    );
  }

  return (
    <form onSubmit={send} className="join-ask">
      <label className="join-field">
        Group ID
        <input type="text" value={id} required autoComplete="off" spellCheck={false}
          placeholder="The group's exact ID"
          onChange={(event) => setId(event.target.value.replace(/[^a-zA-Z0-9]/g, ""))} />
      </label>
      <p className="join-hint">An admin of the group gets your request and can let you in.</p>
      {error && <p role="alert" className="join-error">{error}</p>}
      <button type="submit" className="join-submit" disabled={sending || !id}>
        {sending ? "Sending..." : "Ask to join"}
      </button>
      <button type="button" className="join-switch" onClick={onBack}>Have an invite instead?</button>
    </form>
  );
}

const css = `
  .join-form, .join-ask { display: flex; flex-direction: column; gap: 12px; margin-top: 6px; }
  .join-field { display: flex; flex-direction: column; gap: 6px; color: #ddd; font-size: 0.85rem; font-weight: 600; }
  .join-field input {
    box-sizing: border-box; height: 46px; padding: 0 16px; border: 1px solid #2e2e32; border-radius: 23px;
    background: #111113; color: #f0f0f0; font: inherit; font-size: 1rem; letter-spacing: 0.5px;
  }
  .join-field input:focus { outline: none; border-color: var(--accent); }
  .join-hint { margin: 0; color: #8a8a8a; font-size: 0.85rem; line-height: 1.45; }
  .join-error { margin: 0; color: #ff8a80; font-size: 0.88rem; }
  .join-done { margin: 0; color: #e8e8e8; line-height: 1.5; }
  .join-preview {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 18px; border-radius: 18px; background: #1b1b1e; color: #f0f0f0;
  }
  .join-preview span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .join-preview strong { font-size: 1.2rem; font-weight: 800; overflow-wrap: anywhere; }
  .join-preview small { opacity: 0.75; font-size: 0.82rem; }
  .join-preview button, .join-submit {
    flex: 0 0 auto; height: 42px; padding: 0 22px; border: none; border-radius: 21px;
    background: #111; color: #fff; font: inherit; font-weight: 700; cursor: pointer;
  }
  .join-submit { background: var(--accent); color: var(--accent-ink); }
  .join-preview button:disabled, .join-submit:disabled { opacity: 0.6; cursor: default; }
  .join-switch {
    align-self: flex-start; padding: 0; border: none; background: none; color: var(--accent);
    font: inherit; font-size: 0.88rem; font-weight: 600; cursor: pointer;
  }
  .join-switch:hover { text-decoration: underline; }
`;
