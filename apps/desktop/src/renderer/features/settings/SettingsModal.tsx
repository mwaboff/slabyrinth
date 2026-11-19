/** Settings (UX §8.2–8.8): AI provider · Spending · TaleSpire & assets · Projects & storage · Appearance · About. */
import { useEffect, useRef, useState } from "react";
import "./settings.css";
import "../setup/setup.css";
import "../chat/chat.css";
import { Icon } from "../../ui/Icon";
import { useApp, type SettingsSection } from "../../stores/app";
import { useSettings } from "../../stores/settings";
import { useProject } from "../../stores/project";
import { call, errorMessage } from "../../bridge/client";
import { ApiKeyField, KeyStorageNote, UnreadableKeyNote } from "../setup/Setup";
import { UpdateCheckRow } from "../updates/UpdateChip";

/** Same wording in Settings and Setup. */
export const UPDATE_CHECK_HELP =
  "Once a day Slabyrinth asks GitHub whether a newer version exists. The request is anonymous: no key, no maps, no identifiers. Nothing is downloaded or installed for you.";
import { pickProjectsFolder, pickTaleSpireFolder } from "../../app/folders";
import { EffortControl, ModelList, capsOf, snapEffort } from "../chat/ModelControls";
import { money, relativeTime, roundCost } from "../../lib/format";
import type { AppSettings } from "../../../shared/project";
import type { IpcRequests } from "../../../shared/ipc";

/** v1 main lists only Anthropic; LM Studio is a static "Later" card so users know it is coming (UX §8.4). */
const LATER_LMSTUDIO = {
  id: "lmstudio",
  displayName: "LM Studio (local)",
  nature: "Runs on this PC · no key · no API cost",
  available: false,
};

const NAV: Array<[SettingsSection, string]> = [
  ["ai", "AI provider"],
  ["spending", "Spending"],
  ["talespire", "TaleSpire & assets"],
  ["projects", "Projects & storage"],
  ["appearance", "Appearance"],
  ["about", "About"],
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="srow">
      <span className="srow__label">{label}</span>
      <div className="srow__body">{children}</div>
    </div>
  );
}

export function Check({
  on,
  onChange,
  label,
  help,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  help?: string;
}) {
  return (
    <label className="checkrow">
      <input
        type="checkbox"
        className="sr-only"
        checked={on}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      <span className={`box${on ? " box--on" : ""}`} aria-hidden="true">
        {on && <Icon name="check" />}
      </span>
      <span>
        <span className="checkrow__label">{label}</span>
        {help !== undefined && <small>{help}</small>}
      </span>
    </label>
  );
}

function AiSection({ s }: { s: AppSettings }) {
  const providers = useSettings((x) => x.providers);
  const models = useSettings((x) => x.models);
  const secrets = useSettings((x) => x.secrets);
  const update = useSettings((x) => x.update);
  const [replacing, setReplacing] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const active = providers.find((p) => p.id === s.defaultSelection.providerId) ?? providers[0];
  const caps = capsOf(active);
  const sec = secrets[s.defaultSelection.providerId];
  const model = models.find((m) => m.modelId === s.defaultSelection.modelId);
  const [snapped, setSnapped] = useState<null | NonNullable<AppSettings["defaultSelection"]["effort"]>>(null);
  useEffect(() => {
    if (sec?.hasKey !== true) return;
    void call("providers:check", { providerId: s.defaultSelection.providerId }).then((r) => {
      setCheck(
        r.ok ? { ok: true, text: "Key works · checked just now" } : { ok: false, text: r.error.message },
      );
    });
  }, [sec?.hasKey, s.defaultSelection.providerId]);
  const perPlan = (m: (typeof models)[number]): string | null => {
    if (!caps.hasCost || !m.pricing) return null;
    const mult = { low: 0.6, medium: 1, high: 1.5, xhigh: 2.2, max: 3 }[
      m.effort.supported ? m.effort.default : "medium"
    ];
    const c = roundCost((14000 * m.pricing.inputPerMTok + 6000 * mult * m.pricing.outputPerMTok) / 1_000_000);
    return `${c.startsWith("<") ? c : `≈ ${c}`} per plan`;
  };
  return (
    <>
      <h3>AI provider</h3>
      <p className="lead">Who Slabyrinth talks to when it drafts and edits your maps.</p>
      <div className="providers" role="radiogroup" aria-label="Provider">
        {[...providers.filter((p) => p.available), LATER_LMSTUDIO].map((p) => {
          const on = p.id === active?.id;
          const later = !p.available;
          return (
            <div
              key={p.id}
              role="radio"
              aria-checked={on}
              aria-disabled={later}
              tabIndex={later ? -1 : 0}
              title={
                later ? `${p.displayName.replace(/ \(.*\)/, "")} is planned for a later update.` : undefined
              }
              className={`prov${on ? " prov--on" : ""}${later ? " prov--later" : ""}`}
            >
              <span className={`radio${on ? " radio--on" : ""}`} aria-hidden="true" />
              <b>
                {p.displayName}
                {later && <span className="later-tag">Later</span>}
              </b>
              <span className="prov__d">{p.nature}</span>
              <span className={`prov__st${on && sec?.hasKey === true ? " prov__st--ok" : ""}`}>
                {later ? (
                  "Coming in a later update"
                ) : sec?.hasKey === true ? (
                  <>
                    <Icon name="check" size="sm" /> Connected
                  </>
                ) : (
                  "Not set up"
                )}
              </span>
            </div>
          );
        })}
      </div>
      {active?.needsKey === true && (
        <Row label="API key">
          {sec?.hasKey === true && !replacing ? (
            <>
              <div className="keyfield">
                <span className="keyinput keyinput--static" aria-label="Stored key">
                  <span className="keyinput__field">{sec.hint ?? "sk-ant-…"}</span>
                </span>
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    setReplacing(true);
                  }}
                >
                  Replace
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() =>
                    void call("secrets:clearApiKey", { providerId: active.id }).then(() => {
                      void useSettings.getState().refreshSecrets();
                      setCheck(null);
                    })
                  }
                >
                  Remove
                </button>
              </div>
              {check && (
                <div
                  className={`keystate keystate__row ${check.ok ? "keystate--ok" : "keystate--err"}`}
                  role="status"
                >
                  <Icon name={check.ok ? "check" : "error"} size="sm" /> {check.text}
                </div>
              )}
            </>
          ) : (
            <>
              <UnreadableKeyNote providerId={active.id} />
              {sec?.unreadable === true && (
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() =>
                    void call("secrets:clearApiKey", { providerId: active.id }).then(() => {
                      void useSettings.getState().refreshSecrets();
                      setCheck(null);
                    })
                  }
                >
                  Remove saved key
                </button>
              )}
              <ApiKeyField
                compact
                onValid={() => {
                  setReplacing(false);
                }}
              />
            </>
          )}
          <KeyStorageNote providerId={active.id} className="trust" />
        </Row>
      )}
      <Row label="Default model">
        <ModelList
          models={models}
          value={s.defaultSelection.modelId}
          caps={caps}
          perPlan={perPlan}
          ariaLabel="Default model"
          onPick={(m) => {
            const snap = snapEffort(m, s.defaultSelection.effort);
            setSnapped(snap.snapped ? s.defaultSelection.effort : null);
            void update({
              defaultSelection: { providerId: m.providerId, modelId: m.modelId, effort: snap.effort },
            });
          }}
        />
      </Row>
      {model?.effort.supported === true && (
        <Row label="Default effort">
          <div className="srow__effort">
            <EffortControl
              model={model}
              value={s.defaultSelection.effort}
              snappedFrom={snapped}
              onChange={(effort) => {
                setSnapped(null);
                void update({ defaultSelection: { ...s.defaultSelection, effort } });
              }}
            />
            <Check
              on={s.smartEffort}
              onChange={(v) => void update({ smartEffort: v })}
              label="Smart effort"
              help="Use Balanced for chat-only replies, and your chosen effort when the plan changes."
            />
          </div>
        </Row>
      )}
    </>
  );
}

function MoneyField({
  value,
  onChange,
  label,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
}) {
  const [text, setText] = useState(value === null ? "" : value.toFixed(2));
  return (
    <label className="moneyfield">
      <span className="moneyfield__sign">$</span>
      <input
        className="input"
        inputMode="decimal"
        aria-label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={() => {
          const n = Number(text);
          onChange(text.trim() === "" || !Number.isFinite(n) || n <= 0 ? null : n);
        }}
      />
    </label>
  );
}

function SpendingSection({ s }: { s: AppSettings }) {
  const update = useSettings((x) => x.update);
  const project = useProject((x) => x.snap);
  return (
    <>
      <h3>Spending</h3>
      <p className="lead">Estimates from token counts; your Anthropic bill is authoritative.</p>
      <Row label="Totals">
        <div className="totals">
          <span>This project</span>
          <b>{project ? money(project.conversation.totals.cost?.amount ?? 0) : "—"}</b>
          <span>All time</span>
          <b>{money(s.spending.allTime.cost?.amount ?? 0)}</b>
        </div>
      </Row>
      <Row label="Per action">
        <div className="inline">
          Ask me before a single action over
          <MoneyField
            label="Per-action limit"
            value={s.spending.perActionWarnUsd}
            onChange={(v) => void update({ spending: { ...s.spending, perActionWarnUsd: v } })}
          />
        </div>
      </Row>
      <Row label="Per project">
        <div className="inline">
          Warn me when a project passes
          <MoneyField
            label="Per-project limit"
            value={s.spending.perProjectWarnUsd}
            onChange={(v) => void update({ spending: { ...s.spending, perProjectWarnUsd: v } })}
          />
        </div>
      </Row>
    </>
  );
}

type Palette = IpcRequests["palettes:list"]["res"][number];

function TaleSpireSection({ s }: { s: AppSettings }) {
  const catalog = useSettings((x) => x.catalog);
  const busy = useSettings((x) => x.catalogBusy);
  const update = useSettings((x) => x.update);
  const [report, setReport] = useState<string | null>(null);
  const [palettes, setPalettes] = useState<Palette[]>([]);
  const [pathMsg, setPathMsg] = useState<string | null>(null);
  useEffect(() => {
    void call("palettes:list", undefined).then(setPalettes);
  }, []);
  const refresh = async (): Promise<void> => {
    useSettings.getState().setCatalogBusy(true);
    setReport(null);
    try {
      const r = await call("catalog:refresh", {});
      setReport(
        r.added === 0 && r.removed.length === 0
          ? "Already up to date."
          : `Asset library refreshed — ${r.added} new assets, ${r.removed.length} removed.`,
      );
      await useSettings.getState().refreshCatalog();
    } catch (e) {
      setReport(errorMessage(e));
    } finally {
      useSettings.getState().setCatalogBusy(false);
    }
  };
  const builtin = catalog?.usingBuiltInOnly === true;
  return (
    <>
      <h3>TaleSpire & assets</h3>
      <p className="lead">
        Slabyrinth builds from the asset catalog in your own TaleSpire install. It never changes the install.
      </p>
      <Row label="Asset library">
        <dl className="facts">
          <dt>Source</dt>
          <dd>
            <span className={`dot${builtin ? " dot--warn" : " dot--ok"}`} aria-hidden="true" />
            {builtin ? "Built-in asset set (TaleSpire not found)" : "Your TaleSpire install"}
          </dd>
          <dt>Folder</dt>
          <dd>
            <code className="setup__path">{s.talespire.installPath ?? "Not set"}</code>
            <button
              className="btn btn--sm"
              onClick={() =>
                void pickTaleSpireFolder().then((r) => {
                  if (r) setPathMsg(r.ok ? "Folder set. Reading its asset library…" : r.message);
                })
              }
            >
              <Icon name="folder" size="sm" />
              {s.talespire.installPath === null ? "Locate TaleSpire folder…" : "Change folder…"}
            </button>
            {pathMsg !== null && <span className="muted">{pathMsg}</span>}
          </dd>
          <dt>Assets</dt>
          <dd>
            {(catalog?.assets ?? 0).toLocaleString()} tiles and props
            {catalog?.generatedAt !== null && catalog?.generatedAt !== undefined
              ? ` · scanned ${relativeTime(catalog.generatedAt)}`
              : ""}
          </dd>
          <dt />
          <dd>
            <button className="btn btn--sm" disabled={busy || builtin} onClick={() => void refresh()}>
              {busy ? <span className="spinner" /> : <Icon name="retry" size="sm" />}
              {busy ? "Refreshing…" : "Refresh asset library"}
            </button>
            {report !== null && (
              <span className="muted" role="status">
                {report}
              </span>
            )}
          </dd>
        </dl>
      </Row>
      <Row label="Themes & roles">
        <ul className="palettes">
          {palettes.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>
              <span className="muted">
                {p.source === "bundled" ? "built in" : "yours"}
                {p.issues > 0 ? ` · ${p.issues} missing assets — substitutes in use` : ""}
              </span>
            </li>
          ))}
        </ul>
        <span className="muted">Editing roles (assigning assets to themes) comes in a later update.</span>
      </Row>
      <Row label="Levels in TaleSpire">
        <div className="segctl segctl--fit" role="radiogroup" aria-label="Levels in TaleSpire">
          {(
            [
              ["stacked", "Stacked · 2.5 tiles per storey"],
              ["side_by_side", "Side by side"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              role="radio"
              aria-checked={s.talespire.levelLayout === v}
              onClick={() => void update({ talespire: { ...s.talespire, levelLayout: v } })}
            >
              {l}
            </button>
          ))}
        </div>
        <span className="muted">Either way the whole map is one slab when it fits.</span>
      </Row>
      <Row label="Corner markers">
        <Check
          on={s.talespire.alignmentMarkers}
          onChange={(v) => void update({ talespire: { ...s.talespire, alignmentMarkers: v } })}
          label="Add corner markers to single-slab builds"
          help="Builds split into several parts always get two gravel markers so the parts line up."
        />
      </Row>
      <Row label="Export method">
        <span>Clipboard paste</span>
        <span className="muted">In-game helper (Symbiote) — planned.</span>
      </Row>
    </>
  );
}

/** Default game system (AppSettings.defaultSystem; replaced whole by settings:update). Shared with Setup. */
export function SystemPicker({
  value,
  onChange,
}: {
  value: AppSettings["defaultSystem"];
  onChange: (v: AppSettings["defaultSystem"]) => void;
}) {
  const [other, setOther] = useState(value?.otherName ?? "");
  return (
    <div className="inline">
      <div className="segctl" role="radiogroup" aria-label="Game system">
        {(
          [
            ["daggerheart", "Daggerheart"],
            ["dnd5e", "D&D 5e"],
            ["other", "Other / none"],
          ] as const
        ).map(([v, l]) => (
          <button
            key={v}
            role="radio"
            aria-checked={value?.system === v}
            onClick={() => {
              onChange(
                v === "other" && other.trim() !== "" ? { system: v, otherName: other.trim() } : { system: v },
              );
            }}
          >
            {l}
          </button>
        ))}
      </div>
      {value?.system === "other" && (
        <input
          className="input sys-other"
          aria-label="Which system"
          placeholder="Which system? (optional)"
          value={other}
          maxLength={40}
          onChange={(e) => {
            setOther(e.target.value);
          }}
          onBlur={() => {
            onChange(
              other.trim() === "" ? { system: "other" } : { system: "other", otherName: other.trim() },
            );
          }}
        />
      )}
    </div>
  );
}

function ProjectsSection({ s }: { s: AppSettings }) {
  const update = useSettings((x) => x.update);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <h3>Projects & storage</h3>
      <p className="lead">Each map is one .slabyrinth file. Projects save automatically on every change.</p>
      <Row label="Projects folder">
        <div className="inline">
          <code className="setup__path">{s.projects.folder}</code>
          <button
            className="btn btn--sm"
            onClick={() =>
              void pickProjectsFolder().then((r) => {
                if (r) setMsg(r.ok ? "New projects are saved here." : r.message);
              })
            }
          >
            <Icon name="folder" size="sm" />
            Change folder…
          </button>
        </div>
        {msg !== null && <span className="muted">{msg}</span>}
      </Row>
      <Row label="Game system">
        <SystemPicker value={s.defaultSystem} onChange={(v) => void update({ defaultSystem: v })} />
        <span className="muted">New maps start with this in the brief.</span>
      </Row>
      <Row label="On launch">
        <div className="segctl segctl--fit" role="radiogroup" aria-label="On launch">
          {(
            [
              ["home", "Show Home"],
              ["last_project", "Reopen last project"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              role="radio"
              aria-checked={s.ui.onLaunch === v}
              onClick={() => void update({ ui: { ...s.ui, onLaunch: v } })}
            >
              {l}
            </button>
          ))}
        </div>
      </Row>
    </>
  );
}

function AppearanceSection({ s }: { s: AppSettings }) {
  const update = useSettings((x) => x.update);
  return (
    <>
      <h3>Appearance</h3>
      <p className="lead">Dark is the default. The PNG export has its own print style.</p>
      <Row label="Theme">
        <div className="segctl segctl--fit" role="radiogroup" aria-label="Theme">
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
              aria-checked={s.ui.theme === v}
              onClick={() => void update({ ui: { ...s.ui, theme: v } })}
            >
              {l}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Map style">
        <span>Follows the app theme</span>
        <span className="muted">
          Ink-on-white (higher contrast) <span className="later-tag">Later</span>
        </span>
      </Row>
    </>
  );
}

function AboutSection({ s }: { s: AppSettings }) {
  const version = useApp((x) => x.version);
  const update = useSettings((x) => x.update);
  const [dataPath, setDataPath] = useState("");
  useEffect(() => {
    void call("app:getInfo", undefined).then((i) => {
      setDataPath(i.userDataPath);
    });
  }, []);
  return (
    <>
      <h3>About Slabyrinth</h3>
      <p className="lead">Design maps with Claude. Build them in TaleSpire.</p>
      <Row label="Version">{version}</Row>
      <Row label="Updates">
        <UpdateCheckRow />
        <Check
          on={s.updates.autoCheck}
          onChange={(v) => void update({ updates: { autoCheck: v } })}
          label="Check for updates automatically"
          help={UPDATE_CHECK_HELP}
        />
      </Row>
      <Row label="Data folder">
        <code className="setup__path">{dataPath}</code>
        <span className="muted">
          Settings and logs live here. Your API key is kept in the system's secure storage, not in this
          folder.
        </span>
      </Row>
      <Row label="Fonts">Cinzel, Lora and Source Sans 3, under the SIL Open Font Licence.</Row>
    </>
  );
}

export function SettingsModal() {
  const section = useApp((x) => x.settingsOpen) ?? "ai";
  const open = useApp((x) => x.openSettings);
  const close = useApp((x) => x.closeSettings);
  const s = useSettings((x) => x.settings);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>(".snav__item[aria-current='page']")?.focus();
    return () => prev?.focus();
  }, []);
  if (!s) return null;
  const foot =
    section === "ai"
      ? "New projects start with these. Each project remembers its own model and effort."
      : section === "spending"
        ? "Limits apply to every project."
        : "Changes save as you make them.";
  return (
    <div
      className="scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="snav" aria-label="Settings sections">
          <h2 id="settings-title">Settings</h2>
          {NAV.map(([id, label]) => (
            <button
              key={id}
              className="snav__item"
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                open(id);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sbody">
          <div className="sscroll">
            {section === "ai" && <AiSection s={s} />}
            {section === "spending" && <SpendingSection s={s} />}
            {section === "talespire" && <TaleSpireSection s={s} />}
            {section === "projects" && <ProjectsSection s={s} />}
            {section === "appearance" && <AppearanceSection s={s} />}
            {section === "about" && <AboutSection s={s} />}
          </div>
          <div className="sfoot">
            <span>{foot}</span>
            <button className="btn btn--primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
