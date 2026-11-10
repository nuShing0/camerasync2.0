import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext.jsx";
import {
  requestPasswordReset,
  resetPassword,
  verifyResetCode,
} from "../api/auth.js";
import { PasswordInput } from "../components/PasswordInput.jsx";

// In-app password reset, one step per Figma desktop frame (246:457, 258:432,
// 258:451): request a 6-digit code by email, verify it, choose a new password.
// The emailed link still works too — it lands on /reset-password as before.
const STEPS = { email: "email", code: "code", password: "password", done: "done" };

const CODE_LENGTH = 6;

export function ForgotPasswordScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();

  const [step, setStep] = useState(STEPS.email);
  const [email, setEmail] = useState(() => location.state?.resetEmail ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // The single-use token from verify-reset-code that authorizes the final
  // reset-password call.
  const tokenRef = useRef(null);

  const run = async (action) => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await action();
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const sendCode = (e) => {
    e.preventDefault();
    if (!email.trim()) {
      setError("Please enter your email.");
      return;
    }
    run(async () => {
      await requestPasswordReset(email.trim());
      setCode("");
      setStep(STEPS.code);
    });
  };

  const resendCode = () => {
    run(async () => {
      await requestPasswordReset(email.trim());
      setCode("");
      setNotice("A new code is on its way.");
    });
  };

  const verify = (e) => {
    e.preventDefault();
    if (code.length !== CODE_LENGTH) {
      setError("Please enter the 6-digit code.");
      return;
    }
    run(async () => {
      tokenRef.current = await verifyResetCode({ email: email.trim(), code });
      setStep(STEPS.password);
    });
  };

  const reset = (e) => {
    e.preventDefault();
    if (!password) {
      setError("Please enter a new password.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    run(async () => {
      await resetPassword({ token: tokenRef.current, password });
      if (isAuthenticated) await logout();
      setStep(STEPS.done);
    });
  };

  const heading = {
    [STEPS.email]: "Forgot Password",
    [STEPS.code]: "Enter Code",
    [STEPS.password]: "Reset Password",
    [STEPS.done]: "Reset Password",
  }[step];

  const subtitle = {
    [STEPS.email]:
      "Enter your email and we'll send you a code to reset your password.",
    [STEPS.code]: "Enter the 6-digit code sent to your email",
    [STEPS.password]: "Enter and confirm your new password below.",
    [STEPS.done]: "",
  }[step];

  return (
    <div style={styles.page}>
      <style>{css}</style>

      <div style={styles.column}>
        <h1 style={styles.title}>{heading}</h1>
        {subtitle && <p style={styles.subtitle}>{subtitle}</p>}

        {error && <div style={styles.error}>{error}</div>}
        {notice && <div style={styles.notice}>{notice}</div>}

        {step === STEPS.email && (
          <form onSubmit={sendCode} style={styles.form} noValidate>
            <label style={styles.label}>
              Email
              <input
                className="fp-input"
                type="email"
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <button className="fp-button" type="submit" disabled={submitting}>
              {submitting ? "Please wait…" : "Send Code"}
            </button>
            <button
              type="button"
              className="fp-link"
              onClick={() => navigate(isAuthenticated ? "/settings" : "/login")}
            >
              {isAuthenticated ? "Back to Settings" : "Back to Sign In"}
            </button>
          </form>
        )}

        {step === STEPS.code && (
          <form onSubmit={verify} style={styles.form} noValidate>
            <CodeBoxes code={code} onChange={setCode} />
            <button className="fp-button" type="submit" disabled={submitting}>
              {submitting ? "Please wait…" : "Verify"}
            </button>
            <button
              type="button"
              className="fp-link"
              onClick={resendCode}
              disabled={submitting}
            >
              Resend Code
            </button>
          </form>
        )}

        {step === STEPS.password && (
          <form onSubmit={reset} style={styles.form} noValidate>
            <label style={styles.label}>
              New Password
              <PasswordInput
                className="fp-input"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>
            <label style={styles.label}>
              Confirm Password
              <PasswordInput
                className="fp-input"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
              />
            </label>
            <button className="fp-button" type="submit" disabled={submitting}>
              {submitting ? "Please wait…" : "Reset Password"}
            </button>
          </form>
        )}

        {step === STEPS.done && (
          <div style={styles.form}>
            <div style={styles.notice}>
              Your password has been reset. Sign in with your new password.
            </div>
            <button
              className="fp-button"
              type="button"
              onClick={() => navigate("/login", { replace: true })}
            >
              Go to Sign In
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Six display boxes over one invisible input, so the code is a single string
// and the keyboard behaves normally (paste, backspace, autofill).
export function CodeBoxes({ code, onChange }) {
  const inputRef = useRef(null);
  const [focused, setFocused] = useState(false);

  return (
    <div
      style={styles.codeWrap}
      onClick={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        style={styles.codeInput}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        value={code}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) =>
          onChange(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
        }
      />
      <div style={styles.codeRow}>
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <div
            key={i}
            style={{
              ...styles.codeBox,
              ...(focused && i === Math.min(code.length, CODE_LENGTH - 1)
                ? styles.codeBoxActive
                : null),
            }}
          >
            {code[i] ?? ""}
          </div>
        ))}
      </div>
    </div>
  );
}

const GOLD = "#ead217";
const SURFACE = "#1a1a18";
const MUTED = "#8e8e93";

const styles = {
  page: {
    minHeight: "100vh",
    background: "#000",
    display: "flex",
    justifyContent: "center",
    fontFamily: "system-ui, sans-serif",
    padding: "1rem",
  },
  column: {
    width: "100%",
    maxWidth: 448,
    marginTop: "12vh",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  title: {
    margin: 0,
    textAlign: "center",
    color: GOLD,
    fontSize: "2.2rem",
    fontWeight: 800,
    letterSpacing: "0.5px",
  },
  subtitle: {
    margin: "0 0 0.8rem",
    textAlign: "center",
    color: MUTED,
    fontSize: "0.85rem",
  },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: "0.8rem",
    fontWeight: 500,
    color: "#fff",
  },
  error: {
    background: "#2a1a1a",
    color: "#ff8a80",
    border: "1px solid #5a2a2a",
    borderRadius: 8,
    padding: "0.6rem 0.8rem",
    fontSize: "0.85rem",
    lineHeight: 1.4,
  },
  notice: {
    background: SURFACE,
    color: GOLD,
    border: `1px solid ${GOLD}`,
    borderRadius: 8,
    padding: "0.6rem 0.8rem",
    fontSize: "0.85rem",
    lineHeight: 1.4,
  },
  // The real input sits invisibly over the boxes so clicks focus it.
  codeWrap: { position: "relative", cursor: "text" },
  codeInput: {
    position: "absolute",
    inset: 0,
    opacity: 0,
    width: "100%",
    border: "none",
    background: "transparent",
  },
  codeRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    pointerEvents: "none",
  },
  codeBox: {
    width: 52,
    height: 60,
    background: SURFACE,
    borderRadius: 10,
    border: "1px solid transparent",
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontSize: "1.4rem",
    fontWeight: 600,
  },
  codeBoxActive: { border: `1.5px solid ${GOLD}` },
};

const css = `
  .fp-input {
    font: inherit;
    padding: 0.85rem 0.9rem;
    background: ${SURFACE};
    color: #f0f0f0;
    border: 1px solid transparent;
    border-radius: 10px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .fp-input::placeholder { color: #5c5c5e; }
  .fp-input:focus {
    border-color: ${GOLD};
    box-shadow: 0 0 0 3px rgba(234,210,23,0.15);
  }
  .fp-button {
    font: inherit;
    font-weight: 600;
    margin-top: 0.4rem;
    padding: 0.85rem;
    border: none;
    border-radius: 12px;
    background: ${GOLD};
    color: #000;
    cursor: pointer;
    transition: background 0.15s;
  }
  .fp-button:hover:not(:disabled) { background: #f5e24a; }
  .fp-button:disabled { opacity: 0.5; cursor: default; }
  .fp-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    color: ${GOLD};
    cursor: pointer;
    align-self: center;
  }
  .fp-link:hover:not(:disabled) { text-decoration: underline; }
  .fp-link:disabled { opacity: 0.5; cursor: default; }
`;

// Shared with VerifyEmailScreen so the code-entry pages look the same.
export { styles as codePageStyles, css as codePageCss, CODE_LENGTH };
