import { Icon } from "../ui/Icon";
import { useApp } from "../stores/app";

/** Always-dark toasts, bottom centre, polite (errors assertive) — UX §10, token sheet "Toast". */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      <div aria-live="polite" className="sr-only">
        {toasts
          .filter((t) => t.tone !== "error")
          .map((t) => `${t.lead} ${t.body ?? ""}`)
          .join(" ")}
      </div>
      <div aria-live="assertive" className="sr-only">
        {toasts
          .filter((t) => t.tone === "error")
          .map((t) => `${t.lead} ${t.body ?? ""}`)
          .join(" ")}
      </div>
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.tone ? ` toast--${t.tone}` : ""}`}>
          <Icon name={t.tone === "error" ? "error" : t.tone === "warn" ? "warn" : "check"} />
          <span>
            <b>{t.lead}</b>
            {t.body !== undefined && ` ${t.body}`}
          </span>
          {t.action && (
            <button
              className="toast__action"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
