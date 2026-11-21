/** App-wide, non-blocking banners under the title bar (UX §10): TaleSpire not found, no key, offline, save failure. */
import { useState } from "react";
import { Icon } from "../ui/Icon";
import { useApp } from "../stores/app";
import { useSettings } from "../stores/settings";
import { errorMessage } from "../bridge/client";
import { run } from "./actions";
import { pickTaleSpireFolder } from "./folders";

export function Banners() {
  const route = useApp((s) => s.route);
  const banners = useApp((s) => s.banners);
  const dismissed = useApp((s) => s.tsBannerDismissed);
  const secrets = useSettings((s) => s.secrets);
  const settings = useSettings((s) => s.settings);
  const [dontRemind, setDontRemind] = useState(false);
  const [locating, setLocating] = useState(false);
  if (route === "setup" || route === "boot") return <div />;
  const noKey = settings !== null && secrets["anthropic"]?.hasKey === false;
  const showTs = banners.tsMissing && !dismissed && settings?.suppressAssetWarning !== true;

  const locate = async (): Promise<void> => {
    setLocating(true);
    try {
      const r = await pickTaleSpireFolder();
      if (r === null) return; // cancelled
      if (r.ok) useApp.getState().toast({ lead: "TaleSpire found.", body: "Reading its asset library…" });
      else useApp.getState().toast({ lead: "That isn't a TaleSpire folder.", body: r.message, tone: "warn" });
    } catch (e) {
      useApp.getState().toast({ lead: "Couldn't look for TaleSpire.", body: errorMessage(e), tone: "error" });
    } finally {
      setLocating(false);
    }
  };

  return (
    <div>
      {banners.saveFailed !== null && (
        <div className="banner banner--danger" role="alert">
          <Icon name="error" className="banner__icon" />
          <span className="banner__text">
            <b>Couldn't save "{banners.saveFailed}".</b> Slabyrinth can't write to the projects folder. Your
            work is kept in memory — choose another location.
          </span>
          <span className="banner__actions">
            <button
              className="btn btn--sm"
              onClick={() => void run("project:saveCopyAs", undefined, "Couldn't save a copy.")}
            >
              Save a copy as…
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                useApp.getState().openSettings("projects");
              }}
            >
              Change projects folder
            </button>
          </span>
        </div>
      )}
      {noKey && (
        <div className="banner" role="status">
          <Icon name="key" className="banner__icon" />
          <span className="banner__text">
            <b>Add your Anthropic API key to start.</b> Slabyrinth uses your own key; it stays on this
            computer.
          </span>
          <span className="banner__actions">
            <button
              className="btn btn--sm"
              onClick={() => {
                useApp.getState().openSettings("ai");
              }}
            >
              Add key
            </button>
          </span>
        </div>
      )}
      {banners.offline && (
        <div className="banner" role="status">
          <Icon name="warn" className="banner__icon" />
          <span className="banner__text">
            <b>You're offline.</b> You can browse plans, edit notes and build; chatting needs a connection.
          </span>
        </div>
      )}
      {showTs && (
        <div className="banner" role="status">
          <Icon name="warn" className="banner__icon" />
          <span className="banner__text">
            <b>TaleSpire wasn't found.</b> Using Slabyrinth's built-in asset set, so the newest tiles and
            props aren't available. You can still create and export maps.
          </span>
          <span className="banner__actions">
            <label className="check">
              <input
                type="checkbox"
                className="sr-only"
                checked={dontRemind}
                onChange={(e) => {
                  setDontRemind(e.target.checked);
                }}
              />
              <span className={`box${dontRemind ? " box--on" : ""}`} aria-hidden="true">
                {dontRemind && <Icon name="check" />}
              </span>
              Don't remind me
            </label>
            <button className="btn btn--sm" disabled={locating} onClick={() => void locate()}>
              {locating ? <span className="spinner" /> : <Icon name="folder" size="sm" />}
              Locate TaleSpire folder…
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                useApp.getState().dismissTsBanner();
                if (dontRemind) void useSettings.getState().update({ suppressAssetWarning: true });
              }}
            >
              Continue without it
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
