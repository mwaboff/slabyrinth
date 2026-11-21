/** First-run Setup (UX §8.1): 1 Connect Claude · 2 Find TaleSpire · 3 How you play. Only the key step can block. */
import { useEffect, useRef, useState } from "react";
import "./setup.css";
import { Icon, Mark } from "../../ui/Icon";
import { call, errorMessage } from "../../bridge/client";
import { useSettings } from "../../stores/settings";
import { useApp } from "../../stores/app";
import { useProject } from "../../stores/project";
import { newProject, run } from "../../app/actions";
import { pickTaleSpireFolder } from "../../app/folders";
import { Check, SystemPicker, UPDATE_CHECK_HELP } from "../settings/SettingsModal";
import type { ProviderErrorInfo } from "../../../main/agent/provider/types";

export type KeyState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; hint: string }
  /** Stored, but the check failed for a reason other than the key itself (network, server…). */
  | { kind: "unchecked"; message: string }
  | { kind: "error"; message: string };

export function keyErrorText(e: ProviderErrorInfo | null, fallback?: string): string {
  if (!e) return fallback ?? "Couldn't check the key.";
  if (e.kind === "auth")
    return "Anthropic rejected that key. Check you copied all of it, or create a new one in the Console.";
  if (e.kind === "network" || e.kind === "timeout")
    return "Couldn't reach Anthropic. Check your connection and try again.";
  if (e.kind === "permission")
    return "The key is valid, but your account can't make requests right now (usually credit). Check the Anthropic Console.";
  return e.message;
}

export const UNREADABLE_KEY_TEXT =
  "Your saved key could not be read (the system keyring changed). Enter it again.";

/** Shown when a key is saved but main can't decrypt it; entering a new key replaces it. */
export function UnreadableKeyNote({ providerId = "anthropic" }: { providerId?: string }) {
  const unreadable = useSettings((s) => s.secrets[providerId]?.unreadable === true);
  if (!unreadable) return null;
  return (
    <div className="keystate keystate__row keystate--warn" role="status">
      <Icon name="warn" size="sm" /> {UNREADABLE_KEY_TEXT}
    </div>
  );
}

/** Where the key is kept, in the same words in Setup and Settings. Only "os" may claim secure storage. */
export const KEY_STORAGE_TEXT = {
  os: "Your key is encrypted with your system's secure storage and is only ever sent to api.anthropic.com. It is never written into project files.",
  basic_text:
    "No system keyring was found, so your key is stored with weak protection. It is only ever sent to api.anthropic.com and never written into project files.",
  memory_only:
    "No system keyring was found, so the key is kept for this session only and you'll need to enter it again next time.",
  none: "Your key is only ever sent to api.anthropic.com. It is never written into project files.",
} as const;

export function KeyStorageNote({
  providerId = "anthropic",
  className,
}: {
  providerId?: string;
  className?: string;
}) {
  const row = useSettings((s) => s.secrets[providerId]);
  const [failed, setFailed] = useState<string | null>(null);
  const backend = row?.hasKey === true ? row.backend : null;
  const storeAnyway = async (): Promise<void> => {
    setFailed(null);
    try {
      await call("secrets:storeWeak", { providerId });
      await useSettings.getState().refreshSecrets();
    } catch (e) {
      setFailed(errorMessage(e));
    }
  };
  return (
    <div className={className} data-backend={backend ?? "none"}>
      {KEY_STORAGE_TEXT[backend ?? "none"]}
      {backend === "memory_only" && row?.weakAvailable === true && (
        <>
          {" "}
          <button className="btn btn--sm btn--ghost" onClick={() => void storeAnyway()}>
            Store anyway (less secure)
          </button>
        </>
      )}
      {failed !== null && <span className="keystate__row keystate--err">{failed}</span>}
    </div>
  );
}

/** API key field + check, shared by Setup and Settings ▸ AI provider. */
export function ApiKeyField({ onValid, compact }: { onValid?: () => void; compact?: boolean }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [state, setState] = useState<KeyState>({ kind: "idle" });
  const check = async (value: string): Promise<void> => {
    // The typed key leaves renderer state as soon as it is submitted, whatever the outcome; after a failure the
    // user pastes it again. It lives only in this call's argument until main has it.
    setKey("");
    setShow(false);
    const v = value.trim();
    if (v === "") return;
    setState({ kind: "checking" });
    try {
      // Main stores the key, checks it, and removes it again if Anthropic rejects it (decisions.md).
      const r = await call("secrets:setApiKey", { providerId: "anthropic", apiKey: v, verify: true });
      await useSettings.getState().refreshSecrets();
      const c = r.check;
      if (c === undefined || c.ok) {
        setState({ kind: "valid", hint: useSettings.getState().secrets["anthropic"]?.hint ?? "sk-ant-…" });
        onValid?.();
      } else if (c.error.kind === "auth") {
        setState({ kind: "error", message: `${keyErrorText(c.error)} The key was not saved.` });
      } else {
        setState({
          kind: "unchecked",
          message: `The key was saved, but it could not be checked. ${keyErrorText(c.error)}`,
        });
      }
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  };
  return (
    <div className="keyfield-wrap">
      <div className="keyfield">
        <label className="keyinput">
          <span className="sr-only">Anthropic API key</span>
          <input
            className="keyinput__field"
            type={show ? "text" : "password"}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
            }}
            onPaste={(e) => {
              const t = e.clipboardData.getData("text");
              setTimeout(() => void check(t), 0);
            }}
            onKeyDown={(e) => e.key === "Enter" && void check(key)}
          />
          <button
            type="button"
            className="iconbtn iconbtn--xs"
            aria-label={show ? "Hide key" : "Show key"}
            onClick={() => {
              setShow(!show);
            }}
          >
            <Icon name={show ? "eyeOff" : "eye"} size="sm" />
          </button>
        </label>
        <button
          className={compact === true ? "btn btn--sm" : "btn"}
          disabled={key.trim() === "" || state.kind === "checking"}
          onClick={() => void check(key)}
        >
          Check key
        </button>
      </div>
      <div className="keystate" role="status" aria-live="polite">
        {state.kind === "idle" && (
          <span className="muted">Paste your Anthropic API key. Slabyrinth uses it to talk to Claude.</span>
        )}
        {state.kind === "checking" && (
          <span className="keystate__row">
            <span className="spinner" /> Checking key…
          </span>
        )}
        {state.kind === "valid" && (
          <span className="keystate__row keystate--ok">
            <Icon name="check" size="sm" /> Key works ({state.hint}).
          </span>
        )}
        {state.kind === "unchecked" && (
          <span className="keystate__row keystate--warn">
            <Icon name="warn" size="sm" /> {state.message}
          </span>
        )}
        {state.kind === "error" && (
          <span className="keystate__row keystate--err">
            <Icon name="error" size="sm" /> {state.message}
          </span>
        )}
      </div>
    </div>
  );
}

type TsState =
  | { kind: "scanning" }
  | { kind: "found"; path: string; assets: number }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "invalid"; reason: string };

function TaleSpireStep({ onNext }: { onNext: () => void }) {
  const [st, setSt] = useState<TsState>({ kind: "scanning" });
  const cont = useRef<HTMLButtonElement>(null);
  const scan = (): void => {
    setSt({ kind: "scanning" });
    void runScan();
  };
  const runScan = async (): Promise<void> => {
    try {
      const r = await call("talespire:locate", undefined);
      const f = r.found[0];
      if (!f) {
        setSt({ kind: "missing" });
        return;
      }
      await call("talespire:setPath", { path: f.path });
      const c = await call("catalog:status", undefined);
      if (c.state === "error") setSt({ kind: "unreadable" });
      else setSt({ kind: "found", path: f.path, assets: c.assets });
      await useSettings.getState().refreshCatalog();
    } catch {
      setSt({ kind: "missing" });
    }
  };
  useEffect(() => {
    void runScan();
  }, []);
  useEffect(() => {
    if (st.kind === "missing") cont.current?.focus();
  }, [st.kind]);
  const locate = async (): Promise<void> => {
    const r = await pickTaleSpireFolder();
    if (r === null) return; // cancelled: nothing saved
    if (r.ok) scan();
    else setSt({ kind: "invalid", reason: r.message });
  };
  return (
    <>
      <h2>Find TaleSpire and its assets</h2>
      <p className="setup__lead">
        Slabyrinth builds from the asset catalog in your own TaleSpire install. Official content packs only;
        community and mod.io packs aren't supported yet.
      </p>
      <div className="setup__panel" role="status" aria-live="polite">
        {st.kind === "scanning" && (
          <span className="keystate__row">
            <span className="spinner" /> Looking for TaleSpire… then reading its asset catalog.
          </span>
        )}
        {st.kind === "found" && (
          <div className="setup__found">
            <span className="keystate__row keystate--ok">
              <Icon name="check" size="sm" /> <b>TaleSpire found</b>
            </span>
            <code className="setup__path">{st.path}</code>
            <span className="keystate__row keystate--ok">
              <Icon name="check" size="sm" /> {st.assets.toLocaleString()} assets from the official content
              packs
            </span>
          </div>
        )}
        {(st.kind === "missing" || st.kind === "invalid") && (
          <div className="setup__found">
            <span className="keystate__row keystate--warn">
              <Icon name="warn" size="sm" /> <b>TaleSpire wasn't found on this PC.</b>
            </span>
            <p>
              Slabyrinth will use its <b>built-in asset set</b> (about 125 common tiles and props), so you can
              still design maps and copy slabs into TaleSpire. You won't get the newest tiles and props until
              Slabyrinth can read your install.
            </p>
            {st.kind === "invalid" && <span className="keystate__row keystate--err">{st.reason}</span>}
            <div className="setup__locate">
              <button className="btn" onClick={() => void locate()}>
                <Icon name="folder" /> Locate TaleSpire folder…
              </button>
            </div>
          </div>
        )}
        {st.kind === "unreadable" && (
          <span className="keystate__row keystate--warn">
            <Icon name="warn" size="sm" /> Found TaleSpire, but couldn't read its asset library — a recent
            game update may have changed it. Using the built-in asset set for now.
          </span>
        )}
      </div>
      <div className="setup__nav">
        {st.kind !== "scanning" && (
          <button className="btn btn--ghost" onClick={scan}>
            <Icon name="retry" /> Rescan
          </button>
        )}
        <span className="setup__sp" />
        <button ref={cont} className="btn btn--primary" disabled={st.kind === "scanning"} onClick={onNext}>
          {st.kind === "found" ? "Next" : "Continue without it"}
        </button>
      </div>
    </>
  );
}

export function Setup() {
  const [step, setStep] = useState(0);
  const [keyOk, setKeyOk] = useState(false);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const finish = async (): Promise<void> => {
    await update({ setupCompleted: true });
    useApp.getState().setRoute("home");
    await useProject.getState().loadList();
    await newProject();
  };
  const theme = settings?.ui.theme ?? "dark";
  return (
    <div className="setup-scrim">
      <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <div className="setup__head">
          <Mark size={28} />
          <span id="setup-title" className="setup__title">
            Welcome to Slabyrinth
          </span>
          <ol className="setup__dots" aria-label={`Step ${step + 1} of 3`}>
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className={i === step ? "is-current" : i < step ? "is-done" : ""}
                aria-current={i === step ? "step" : undefined}
              />
            ))}
          </ol>
        </div>
        <div className="setup__body">
          {step === 0 && (
            <>
              <h2>Connect Claude</h2>
              <p className="setup__lead">
                Slabyrinth drafts and edits maps with Claude on your own Anthropic API key, so you only pay
                for what you use.
              </p>
              <UnreadableKeyNote />
              <ApiKeyField
                onValid={() => {
                  setKeyOk(true);
                }}
              />
              <KeyStorageNote className="setup__trust" />
              <button
                className="btn btn--link"
                onClick={() =>
                  void run(
                    "shell:openExternal",
                    { url: "https://console.anthropic.com/settings/keys" },
                    "Couldn't open the page.",
                  )
                }
              >
                Get a key at console.anthropic.com
              </button>
              <div className="setup__nav">
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  Skip for now
                </button>
                <span className="setup__sp" />
                <button
                  className="btn btn--primary"
                  disabled={!keyOk}
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  Next
                </button>
              </div>
            </>
          )}
          {step === 1 && (
            <TaleSpireStep
              onNext={() => {
                setStep(2);
              }}
            />
          )}
          {step === 2 && (
            <>
              <h2>How you play</h2>
              <p className="setup__lead">Defaults for new maps. You can change both later in Settings.</p>
              <div className="setup__row">
                <span className="setup__label">Game system</span>
                <SystemPicker
                  value={settings?.defaultSystem ?? null}
                  onChange={(v) => void update({ defaultSystem: v })}
                />
              </div>
              <div className="setup__row">
                <span className="setup__label">Theme</span>
                <div className="segctl" role="radiogroup" aria-label="Theme">
                  {(
                    [
                      ["dark", "Dark"],
                      ["light", "Light"],
                      ["system", "Match system"],
                    ] as const
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      role="radio"
                      aria-checked={theme === v}
                      onClick={() => settings && void update({ ui: { ...settings.ui, theme: v } })}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setup__row">
                <span className="setup__label">Updates</span>
                <Check
                  on={settings?.updates.autoCheck ?? true}
                  onChange={(v) => void update({ updates: { autoCheck: v } })}
                  label="Check for updates automatically"
                  help={`${UPDATE_CHECK_HELP} You can change this later in Settings ▸ About.`}
                />
              </div>
              <div className="setup__nav">
                <button
                  className="btn btn--ghost"
                  onClick={() => {
                    setStep(1);
                  }}
                >
                  <Icon name="left" /> Back
                </button>
                <span className="setup__sp" />
                <button className="btn btn--primary" onClick={() => void finish()}>
                  Start mapping
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
