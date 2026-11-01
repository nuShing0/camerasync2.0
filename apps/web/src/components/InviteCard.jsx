import { useEffect, useState } from "react";
import QRCode from "qrcode";

import { formatInviteCode, resetInvite } from "../api/groups.js";

/// A group's invite, three ways to hand it out: the code to read out or type
/// (ABC-DEF), the link to copy or share, and a QR to scan off this screen.
/// Admins can reset it, which retires the old code, link and QR together.
export function InviteCard({ group, canReset, onReset }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const message = `Join ${group.name} on 8kount`;

  useEffect(() => {
    if (!showQr || !group.inviteUrl) return;
    QRCode.toDataURL(group.inviteUrl, { margin: 1, width: 480, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setError("Couldn't make the QR code."));
  }, [showQr, group.inviteUrl]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(group.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this invite link:", group.inviteUrl);
    }
  };

  const share = () => {
    navigator.share({ title: message, text: message, url: group.inviteUrl }).catch(() => {});
  };

  const reset = async () => {
    if (!window.confirm("Reset the invite? The old link, code and QR stop working, so share the new one with anyone still joining.")) return;
    setResetting(true);
    setError("");
    try {
      onReset(await resetInvite(group.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="invite-card">
      <style>{css}</style>
      <span className="invite-label">Invite code</span>
      <strong className="invite-code">{formatInviteCode(group.inviteCode)}</strong>
      <div className="invite-actions">
        {canShare && <button type="button" className="invite-primary" onClick={share}>Share link</button>}
        <button type="button" className={canShare ? "" : "invite-primary"} onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" aria-expanded={showQr} onClick={() => setShowQr((open) => !open)}>
          {showQr ? "Hide QR" : "Show QR"}
        </button>
      </div>
      {showQr && qr && (
        <img className="invite-qr" src={qr} alt={`QR code to join ${group.name}`} />
      )}
      {error && <p role="alert" className="invite-error">{error}</p>}
      {canReset && (
        <button type="button" className="invite-reset" disabled={resetting} onClick={reset}>
          {resetting ? "Resetting..." : "Reset invite"}
        </button>
      )}
    </div>
  );
}

const css = `
  .invite-card { display: flex; flex-direction: column; gap: 10px; }
  .invite-label { color: #8a8a8a; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; }
  .invite-code { font-size: 2rem; font-weight: 800; letter-spacing: 3px; font-variant-numeric: tabular-nums; }
  .invite-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .invite-actions button, .invite-reset {
    height: 38px; padding: 0 16px; border: none; border-radius: 19px;
    background: #1b1b1e; color: #f0f0f0; font: inherit; font-size: 0.88rem; font-weight: 600; cursor: pointer;
  }
  .invite-actions button:hover { background: #26262a; }
  .invite-actions .invite-primary { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
  .invite-qr { width: 220px; max-width: 100%; border-radius: 14px; background: #fff; padding: 10px; box-sizing: border-box; }
  .invite-reset { align-self: flex-start; background: none; padding: 0; height: auto; color: #8a8a90; font-size: 0.82rem; text-decoration: underline; }
  .invite-reset:disabled { opacity: 0.6; cursor: default; }
  .invite-error { margin: 0; color: #ff8a80; font-size: 0.85rem; }
`;
