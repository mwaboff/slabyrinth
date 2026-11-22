/**
 * The add-on's update prompt (a dialog, when main says the installed copy is older and was not updated by itself)
 * and the quiet notice after the automatic update at start (a dismissible banner, not a dialog).
 */
import { useRef } from "react";
import { Icon } from "../../ui/Icon";
import { useModal } from "../../ui/modal";
import { useApp } from "../../stores/app";
import { autoUpdated, updatePromptOpen, useTaleSpireLink } from "../../stores/talespireLink";
import { ActionError, ManualInstall } from "./AddonParts";

export function AddonUpdatePrompt() {
  const addon = useTaleSpireLink((s) => s.addon);
  const snoozed = useTaleSpireLink((s) => s.promptSnoozed);
  const dialogOpen = useTaleSpireLink((s) => s.dialogOpen);
  const route = useApp((s) => s.route);
  // the add-on dialog already offers the update; Setup comes first
  if (!updatePromptOpen(addon) || snoozed || dialogOpen || route === "setup" || route === "boot") return null;
  return <PromptBody />;
}

function PromptBody() {
  const addon = useTaleSpireLink((s) => s.addon);
  const busy = useTaleSpireLink((s) => s.busy);
  const error = useTaleSpireLink((s) => s.error);
  const snooze = useTaleSpireLink((s) => s.snoozePrompt);
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, snooze);
  if (!addon) return null;
  const st = useTaleSpireLink.getState();
  const failed = error?.action === "install";
  return (
    <div className="scrim">
      <div
        ref={dialog}
        className="dialog tsprompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tsprompt-title"
        aria-describedby="tsprompt-body"
      >
        <h2 id="tsprompt-title">Update the TaleSpire add-on?</h2>
        <p id="tsprompt-body">
          Slabyrinth Helper {addon.installedVersion ?? ""} in TaleSpire is older than the one that comes with
          this Slabyrinth ({addon.bundledVersion}). Update it so the two work together.
        </p>
        {addon.prompt.reason !== null && <p className="tsnote">{addon.prompt.reason}</p>}
        <ActionError actions={["install", "dismissPrompt"]} />
        {failed && <ManualInstall open />}
        <div className="dialog__actions tsprompt__actions">
          <button className="btn btn--link" disabled={busy !== null} onClick={() => void st.dismissPrompt()}>
            Don't ask again for this version
          </button>
          <span className="tsprompt__sp" />
          <button className="btn" onClick={snooze}>
            Not now
          </button>
          <button
            className="btn btn--primary"
            disabled={busy !== null}
            data-autofocus
            onClick={() =>
              void st.install().then((ok) => {
                if (ok)
                  useApp.getState().toast({
                    lead: "Add-on updated.",
                    body: "TaleSpire picks it up by itself.",
                  });
              })
            }
          >
            {busy === "install" && <span className="spinner spinner--on-accent" aria-hidden="true" />}
            {busy === "install" ? "Updating…" : failed ? "Try again" : "Update now"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Slabyrinth Helper was updated (0.2.0 → 0.3.0)", once, under the title bar. */
export function AddonUpdatedNotice() {
  const addon = useTaleSpireLink((s) => s.addon);
  const dismissed = useTaleSpireLink((s) => s.noticeDismissed);
  const dismiss = useTaleSpireLink((s) => s.dismissNotice);
  const u = autoUpdated(addon);
  if (!u || dismissed) return null;
  return (
    <div className="banner tsnotice" role="status">
      <Icon name="check" className="banner__icon tsnotice__icon" />
      <span className="banner__text">
        <b>Slabyrinth Helper was updated ({u.from !== null ? `${u.from} → ${u.to}` : `to ${u.to}`}).</b>{" "}
        TaleSpire picks it up by itself.
      </span>
      <span className="banner__actions">
        <button className="btn btn--sm btn--ghost" onClick={dismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
