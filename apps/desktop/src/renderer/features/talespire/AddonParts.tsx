/**
 * The TaleSpire add-on's building blocks, shared by the status bar, the add-on dialog, Settings, the update prompt and
 * the build page, so each control exists once. Every action goes through the store (stores/talespireLink.ts).
 */
import "./talespire.css";
import { Icon } from "../../ui/Icon";
import { useApp } from "../../stores/app";
import { useTaleSpireLink, type LinkAction } from "../../stores/talespireLink";
import {
  addonSummary,
  folderSourceLabel,
  hotkeyRows,
  isInstalled,
  primaryAction,
  type AddonSummary,
  type Light,
} from "./addonView";

/** The light: colour and shape (dot, ring, halo, plus, triangle, diamond) both carry the state. */
export function StatusLight({ light }: { light: Light }) {
  return <span className={`tslight tslight--${light}`} aria-hidden="true" />;
}

export function useAddonSummary(): AddonSummary {
  const addon = useTaleSpireLink((s) => s.addon);
  const link = useTaleSpireLink((s) => s.link);
  return addonSummary(addon, link);
}

/** The status bar's light and label; opens the add-on dialog. Changes are announced politely. */
export function AddonIndicator() {
  const sum = useAddonSummary();
  const open = useTaleSpireLink((s) => s.openDialog);
  // the dialog announces the state itself while it is open
  const dialogOpen = useTaleSpireLink((s) => s.dialogOpen);
  return (
    <>
      <button
        className={`tsind tsind--${sum.light}`}
        title={`${sum.detail} Click for the TaleSpire add-on.`}
        aria-label={`TaleSpire add-on: ${sum.label}`}
        aria-haspopup="dialog"
        onClick={open}
        data-state={sum.key}
      >
        <StatusLight light={sum.light} />
        <span className="tsind__label">{sum.label}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {dialogOpen ? "" : `TaleSpire add-on: ${sum.label}. ${sum.detail}`}
      </span>
    </>
  );
}

/** The last failure of one of these actions, in plain words. */
export function ActionError({ actions }: { actions: LinkAction[] }) {
  const error = useTaleSpireLink((s) => s.error);
  if (!error || !actions.includes(error.action)) return null;
  return (
    <p className="tserr" role="alert">
      <Icon name="error" size="sm" />
      <span>{error.message}</span>
    </p>
  );
}

/** Asks first, saying exactly what is removed and what stays. */
export function confirmUninstall(): void {
  useApp.getState().askConfirm({
    title: "Uninstall the TaleSpire add-on?",
    body:
      "This removes Slabyrinth Helper (its slabyrinth-helper folder) from TaleSpire's Symbiotes folder. " +
      "TaleSpire keeps the panel's own remembered look and hotkey choices in its web view; they do nothing " +
      "without the add-on. You can install it again at any time.",
    confirm: "Uninstall",
    danger: true,
    onConfirm: () => {
      void useTaleSpireLink
        .getState()
        .uninstall()
        .then((ok) => {
          if (ok)
            useApp
              .getState()
              .toast({ lead: "Removed from TaleSpire.", body: "Slabyrinth Helper is uninstalled." });
        });
    },
  });
}

/** The main button for the add-on's state: Install, Update now, Reinstall, Choose folder… or Open folder. */
export function PrimaryButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const addon = useTaleSpireLink((s) => s.addon);
  const link = useTaleSpireLink((s) => s.link);
  const busy = useTaleSpireLink((s) => s.busy);
  const act = primaryAction(addon, link);
  if (!act) return null;
  const st = useTaleSpireLink.getState();
  const running =
    (act.kind === "install" && busy === "install") ||
    (act.kind === "choose_folder" && busy === "chooseFolder") ||
    (act.kind === "open_folder" && busy === "openFolder");
  return (
    <button
      className={`btn btn--primary${size === "sm" ? " btn--sm" : ""}`}
      disabled={busy !== null}
      onClick={() => {
        if (act.kind === "install") void st.install();
        else if (act.kind === "choose_folder") void st.chooseFolder();
        else void st.openFolder("installed");
      }}
    >
      {running && <span className="spinner spinner--on-accent" aria-hidden="true" />}
      {running
        ? act.kind === "install"
          ? `${act.label === "Install" ? "Installing" : act.label === "Update now" ? "Updating" : "Reinstalling"}…`
          : act.label
        : act.label}
    </button>
  );
}

/** Installed and bundled versions, Update now / Reinstall and Uninstall (showPrimary: false where a setup step offers it). */
export function VersionRow({ showPrimary = true }: { showPrimary?: boolean }) {
  const addon = useTaleSpireLink((s) => s.addon);
  const busy = useTaleSpireLink((s) => s.busy);
  if (!addon) return null;
  const installed = isInstalled(addon);
  const act = primaryAction(addon, useTaleSpireLink.getState().link);
  return (
    <div className="tsrow">
      <dl className="tsfacts">
        <dt>Installed</dt>
        <dd>{addon.installedVersion !== null ? `Version ${addon.installedVersion}` : "Not installed"}</dd>
        <dt>With this app</dt>
        <dd>Version {addon.bundledVersion}</dd>
      </dl>
      <div className="tsbtns">
        {showPrimary && <PrimaryButton />}
        {installed && act === null && (
          <button
            className="btn btn--sm"
            disabled={busy !== null}
            onClick={() => void useTaleSpireLink.getState().install()}
          >
            {busy === "install" && <span className="spinner" aria-hidden="true" />}
            Reinstall
          </button>
        )}
        {installed && (
          <button
            className="btn btn--sm btn--ghost tsdanger"
            disabled={busy !== null}
            onClick={confirmUninstall}
          >
            Uninstall
          </button>
        )}
      </div>
      <ActionError actions={["install", "uninstall"]} />
    </div>
  );
}

/** The Symbiotes folder: where it is, how it was found, change it, open it; the warnings and the copy left elsewhere. */
export function FolderRow() {
  const addon = useTaleSpireLink((s) => s.addon);
  const busy = useTaleSpireLink((s) => s.busy);
  const platform = useApp((s) => s.platform);
  if (!addon) return null;
  const st = useTaleSpireLink.getState();
  const notFound = addon.state === "not_found";
  return (
    <div className="tsrow">
      <dl className="tsfacts">
        <dt>Symbiotes folder</dt>
        <dd>
          {addon.folder !== null ? <code className="tspath">{addon.folder}</code> : <span>Not found</span>}
          <span className="tag">{folderSourceLabel(addon.folderSource)}</span>
        </dd>
      </dl>
      {addon.folderWarning !== null && (
        <p className="tswarn" role="note">
          <Icon name="warn" size="sm" />
          <span>{addon.folderWarning}</span>
        </p>
      )}
      {platform === "linux" && (notFound || addon.folderSource === "proton") && (
        <p className="tsnote">
          On Linux, TaleSpire runs through Steam Proton, and Slabyrinth only guesses where its folder is. If
          TaleSpire doesn't show the add-on, choose the folder by hand: inside your Steam library,
          steamapps/compatdata/720620/pfx/ drive_c/users/steamuser/AppData/LocalLow/BouncyRock
          Entertainment/TaleSpire/Symbiotes.
        </p>
      )}
      <div className="tsbtns">
        <button
          className={`btn btn--sm${notFound ? " btn--primary" : ""}`}
          disabled={busy !== null}
          onClick={() => void st.chooseFolder()}
        >
          {busy === "chooseFolder" ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <Icon name="folder" size="sm" />
          )}
          Change location…
        </button>
        {addon.folderSource === "manual" && (
          <button
            className="btn btn--sm btn--ghost"
            disabled={busy !== null}
            onClick={() => void st.chooseFolder(true)}
          >
            Use automatic detection
          </button>
        )}
        {addon.folder !== null && (
          <button
            className="btn btn--sm btn--ghost"
            disabled={busy !== null}
            onClick={() => void st.openFolder("installed")}
          >
            <Icon name="ext" size="sm" />
            Open folder
          </button>
        )}
      </div>
      {notFound && addon.tried.length > 0 && (
        <details className="tstried">
          <summary>Places Slabyrinth looked</summary>
          <ul>
            {addon.tried.map((p) => (
              <li key={p}>
                <code className="tspath">{p}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {addon.elsewhere && (
        <div className="tswarn tswarn--box" role="note">
          <Icon name="info" size="sm" />
          <span>
            Another copy of the add-on (version {addon.elsewhere.version}) is still in{" "}
            <code className="tspath">{addon.elsewhere.folder}</code>. TaleSpire may show both.
          </span>
          <span className="tsbtns">
            {!isInstalled(addon) && (
              <button className="btn btn--sm" disabled={busy !== null} onClick={() => void st.move()}>
                Move it here
              </button>
            )}
            <button
              className="btn btn--sm btn--ghost"
              disabled={busy !== null}
              onClick={() => void st.uninstall(true)}
            >
              Remove the old copy
            </button>
          </span>
        </div>
      )}
      <ActionError actions={["chooseFolder", "openFolder"]} />
    </div>
  );
}

/** Installing by hand, for when one click can't: the two folders and two lines. */
export function ManualInstall({ open = false }: { open?: boolean }) {
  const busy = useTaleSpireLink((s) => s.busy);
  const st = useTaleSpireLink.getState();
  return (
    <details className="tsmanual" open={open}>
      <summary>Install it by hand instead</summary>
      <ol>
        <li>Open the add-on files and TaleSpire's Symbiotes folder.</li>
        <li>Copy the slabyrinth-helper folder into the Symbiotes folder. TaleSpire picks it up by itself.</li>
      </ol>
      <div className="tsbtns">
        <button
          className="btn btn--sm"
          disabled={busy !== null}
          onClick={() => void st.openFolder("package")}
        >
          <Icon name="folder" size="sm" />
          Show the add-on files
        </button>
        <button
          className="btn btn--sm"
          disabled={busy !== null}
          onClick={() => void st.openFolder("installed")}
        >
          <Icon name="folder" size="sm" />
          Open the Symbiotes folder
        </button>
      </div>
    </details>
  );
}

/** The hotkeys as the app holds them; changed in the add-on panel, not here. */
export function HotkeyList({ compact = false }: { compact?: boolean }) {
  const link = useTaleSpireLink((s) => s.link);
  const rows = hotkeyRows(link);
  if (!link) return null;
  const fallback = link.hotkeys.state !== "off" && link.hotkeys.state !== "active";
  return (
    <div className="tshot">
      <ul
        className={`tshot__list${compact ? " tshot__list--compact" : ""}`}
        aria-label="Hotkeys in TaleSpire"
      >
        {rows.map((r) => (
          <li key={r.action} className={r.ok ? "" : "tshot--off"}>
            <span className="tshot__name">{r.name}</span>
            {r.combo !== null ? <span className="kbd">{r.combo.replaceAll("+", " ")}</span> : <span>—</span>}
            {!compact && <span className="muted">{r.state}</span>}
          </li>
        ))}
      </ul>
      {link.hotkeys.wayland && (
        <p className="tsnote">
          On this Linux desktop the system may refuse these keys or ask you first. The buttons in the add-on
          panel always work.
        </p>
      )}
      {fallback && (
        <p className="tswarn" role="note">
          <Icon name="warn" size="sm" />
          <span>Some keys don't work right now. Use the buttons in the add-on panel.</span>
        </p>
      )}
    </div>
  );
}
