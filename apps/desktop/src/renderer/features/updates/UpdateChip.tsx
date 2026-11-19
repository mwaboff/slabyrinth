/**
 * "Update available" chip + popover (decisions.md "Update notice"). Passive: it never opens by itself, so it can't
 * interrupt a running turn or a dialog. "Download" opens the release page (URL built in main from the validated tag,
 * and checked again by shell:openExternal's allow-list). Release notes are untrusted and shown as plain text only.
 */
import { useRef, useState } from "react";
import "./updates.css";
import { tryCall } from "../../bridge/client";
import { useApp } from "../../stores/app";
import { chipVersion, useUpdates } from "../../stores/updates";
import { useDismiss } from "../../ui/dismiss";

/** What the user does with the download, matched to the real release targets (electron-builder.yml). */
export const INSTALL_TEXT: Record<"win32" | "linux" | "darwin", string> = {
  win32:
    "Run the new installer (Slabyrinth-Setup), or replace your portable .exe with the new one. Your settings, key and maps are kept.",
  linux: "Replace your AppImage with the new one. Your settings, key and maps are kept.",
  darwin: "Install the new version. Your settings, key and maps are kept.",
};

/** Caps the notes for display (main caps them too); line breaks are kept by CSS (pre-wrap). */
export const NOTES_DISPLAY_MAX = 1200;
export function displayNotes(notes: string): string {
  return notes.length > NOTES_DISPLAY_MAX ? `${notes.slice(0, NOTES_DISPLAY_MAX - 1).trimEnd()}…` : notes;
}

export function formatDate(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The popover body, shared by the chip and Settings ▸ About. */
export function UpdateDetails({ onDone, showLater = true }: { onDone?: () => void; showLater?: boolean }) {
  const status = useUpdates((s) => s.status);
  const platform = useApp((s) => s.platform);
  const u = status?.update;
  if (!status || !u) return null;
  const published = formatDate(u.publishedAt);
  const notes = displayNotes(u.notes);
  return (
    <div className="upd">
      <div className="upd__head">
        <b className="upd__title">Slabyrinth {u.version}</b>
        <span className="upd__meta">
          {published !== null ? `Published ${published} · ` : ""}you have {status.currentVersion}
        </span>
      </div>
      {notes !== "" && (
        <>
          <span className="eyebrow">What's new</span>
          <div className="upd__notes" tabIndex={0} aria-label="What's new">
            {notes}
          </div>
        </>
      )}
      <p className="upd__install">{INSTALL_TEXT[platform]}</p>
      <div className="upd__actions">
        <button
          className="btn btn--sm btn--primary"
          onClick={() => {
            void tryCall("shell:openExternal", { url: u.url });
            onDone?.();
          }}
        >
          Download
        </button>
        {!status.skipped && (
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => {
              void useUpdates.getState().skip(u.version);
              onDone?.();
            }}
          >
            Skip this version
          </button>
        )}
        {showLater && (
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => {
              useUpdates.getState().later();
              onDone?.();
            }}
          >
            Later
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings ▸ About: current version, "Check for updates" and its states. */
export function UpdateCheckRow() {
  const status = useUpdates((s) => s.status);
  const state = status?.state ?? "idle";
  const checked = status?.lastCheckedAt ? formatDate(status.lastCheckedAt) : null;
  return (
    <div className="updrow">
      <span className="updrow__state" role="status" aria-live="polite">
        {state === "checking" && (
          <>
            <span className="spinner" /> Checking for updates…
          </>
        )}
        {state === "up_to_date" && <>You're up to date.</>}
        {state === "failed" && <>Couldn't check for updates. Try again later.</>}
        {state === "available" && status?.update && (
          <>
            Slabyrinth {status.update.version} is available{status.skipped ? " (you skipped it)" : ""}.
          </>
        )}
        {state === "idle" && <>{checked !== null ? `Last checked ${checked}.` : "Not checked yet."}</>}
      </span>
      {state === "available" && <UpdateDetails showLater={false} />}
      <button
        className="btn btn--sm"
        disabled={state === "checking"}
        onClick={() => void useUpdates.getState().check()}
      >
        Check for updates
      </button>
    </div>
  );
}

export function UpdateChip() {
  const version = useUpdates(chipVersion);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, pop],
    () => {
      setOpen(false);
    },
    btn,
  );
  if (version === null) return null;
  return (
    <div className="updchip-wrap">
      <button
        ref={btn}
        className="updchip"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="updchip__dot" aria-hidden="true" />
        Update available · {version}
      </button>
      {open && (
        <div ref={pop} className="popover updpop" role="dialog" aria-label="Update available">
          <span className="eyebrow">Update available</span>
          <UpdateDetails
            onDone={() => {
              setOpen(false);
              btn.current?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}
