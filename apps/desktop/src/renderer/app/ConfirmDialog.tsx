import { useEffect, useRef } from "react";
import { useApp } from "../stores/app";

export function ConfirmDialog() {
  const c = useApp((s) => s.confirm);
  const close = (): void => {
    useApp.getState().askConfirm(null);
  };
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (c) ok.current?.focus();
  }, [c]);
  if (!c) return null;
  return (
    <div
      className="scrim"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <h2 id="confirm-title">{c.title}</h2>
        <p id="confirm-body">{c.body}</p>
        <div className="dialog__actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            ref={ok}
            className={c.danger === true ? "btn btn--danger" : "btn btn--primary"}
            onClick={() => {
              close();
              c.onConfirm();
            }}
          >
            {c.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
