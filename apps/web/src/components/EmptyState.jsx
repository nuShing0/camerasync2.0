import { Link } from "react-router-dom";

// Shared empty / first-run panel: what's missing, why, and the one action
// that fills it. Pass `to` for a route or `onAction` for a handler; omit both
// when the action lives right beside the panel.
export function EmptyState({ title, children, action, to, onAction, compact }) {
  return (
    <div className={compact ? "empty-state empty-state-compact" : "empty-state"}>
      <style>{css}</style>
      {title && <strong className="empty-state-title">{title}</strong>}
      {children && <p className="empty-state-hint">{children}</p>}
      {action && to && (
        <Link className="empty-state-action" to={to}>
          {action}
        </Link>
      )}
      {action && !to && onAction && (
        <button type="button" className="empty-state-action" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

const css = `
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 28px 16px;
    border: 1px dashed var(--line-strong);
    border-radius: 12px;
    color: var(--text-dim);
    text-align: center;
  }
  .empty-state-compact { padding: 18px 12px; gap: 6px; }
  .empty-state-title {
    color: var(--text-strong);
    font-size: 1.05rem;
    font-weight: 700;
  }
  .empty-state-compact .empty-state-title { font-size: 0.95rem; }
  .empty-state-hint {
    margin: 0;
    max-width: 44ch;
    line-height: 1.6;
    font-size: 0.92rem;
  }
  /* Both selectors so page-level link rules (e.g. ".watch-page a") don't
     recolour the button text. */
  a.empty-state-action,
  button.empty-state-action {
    margin-top: 8px;
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.12s;
  }
  a.empty-state-action:hover,
  button.empty-state-action:hover {
    background: var(--accent-hover);
    color: var(--accent-ink);
  }
`;
