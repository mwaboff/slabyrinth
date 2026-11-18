/** App header under the native window frame (UX §4; native frame per lead ruling): menu · mark/wordmark · project name · save state · stepper · cost · theme · settings. */
import { useRef, useState } from "react";
import { Icon, Mark } from "../ui/Icon";
import { useDismiss } from "../ui/dismiss";
import { useApp } from "../stores/app";
import { useProject, phaseOf, latestBuild } from "../stores/project";
import { useSettings, shortModelName, EFFORT_LABEL } from "../stores/settings";
import { useMap } from "../stores/map";
import { useChat } from "../stores/chat";
import { goHome, renameProject } from "./actions";
import { AppMenu } from "./AppMenu";
import { money, tokens, relativeTime } from "../lib/format";
import { toggleTheme, useAppliedTheme } from "./theme";

function ProjectName() {
  const name = useProject((s) => s.snap?.name ?? "");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (editing)
    return (
      <input
        className="input projname__input"
        aria-label="Project name"
        value={value}
        maxLength={60}
        autoFocus
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onBlur={() => {
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void renameProject(value);
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  return (
    <button
      className="projname__btn"
      title="Rename project"
      onClick={() => {
        setValue(name);
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}

function Stepper() {
  const snap = useProject((s) => s.snap);
  const setTab = useMap((s) => s.setTab);
  const setBriefOpen = useApp((s) => s.setBriefOpen);
  const focus = useChat((s) => s.focusComposer);
  if (!snap) return null;
  const phase = phaseOf(snap);
  const build = latestBuild(snap);
  const briefDone = snap.head > 0;
  const planDone = snap.approvedVersion !== null && snap.approvedVersion === snap.head;
  const buildDone = build !== null && build.versionNumber === snap.approvedVersion;
  const planLabel = snap.head > 0 ? `Plan v${snap.head}` : "Plan";
  const steps = [
    {
      n: 1,
      label: "Brief",
      done: briefDone,
      current: phase === "brief",
      disabled: false,
      run: () => {
        setBriefOpen(true);
        focus();
      },
    },
    {
      n: 2,
      label: planLabel,
      done: planDone,
      current: phase === "plan",
      disabled: snap.head === 0,
      run: () => {
        setTab("map");
      },
      title: snap.head === 0 ? "Draw a plan first" : undefined,
    },
    {
      n: 3,
      label: "Build",
      done: buildDone,
      current: phase === "build",
      disabled: snap.approvedVersion === null,
      run: () => {
        setTab("build");
      },
      title: snap.approvedVersion === null ? "Approve a plan version first" : undefined,
    },
  ];
  return (
    <nav className="stepper" aria-label="Project progress">
      {steps.map((s, i) => (
        <span key={s.n} style={{ display: "contents" }}>
          {i > 0 && (
            <span className="step__chev" aria-hidden="true">
              ›
            </span>
          )}
          <button
            className={`step${s.done && !s.current ? " step--done" : ""}${s.current ? " step--current" : ""}`}
            disabled={s.disabled}
            title={s.title}
            aria-current={s.current ? "step" : undefined}
            onClick={s.run}
          >
            <span className="step__dot">{s.done && !s.current ? <Icon name="check" size="xs" /> : s.n}</span>
            {s.label}
            {s.done && <span className="sr-only">(done)</span>}
          </button>
        </span>
      ))}
    </nav>
  );
}

function CostMeter() {
  const snap = useProject((s) => s.snap);
  const route = useApp((s) => s.route);
  const settings = useSettings((s) => s.settings);
  const models = useSettings((s) => s.models);
  const providers = useSettings((s) => s.providers);
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
  const providerId =
    snap?.conversation.selection.providerId ?? settings?.defaultSelection.providerId ?? "anthropic";
  const hasCost = providers.find((p) => p.id === providerId)?.hasCost ?? true;
  if (!hasCost) return <span className="tag">Local · no API cost</span>;
  const allTime = settings?.spending.allTime.cost?.amount ?? 0;
  if (route !== "workspace" || !snap) return <span className="cost">{money(allTime)} all time</span>;
  const totals = snap.conversation.totals;
  const amount = totals.cost?.amount ?? 0;
  const tok = totals.usage.inputTokens + totals.usage.outputTokens + totals.usage.cacheReadTokens;
  const limit = settings?.spending.perProjectWarnUsd ?? null;
  const over = limit !== null && amount > limit;
  const calls = snap.conversation.items
    .filter((i) => i.type === "assistant" && snap.conversation.meta[i.id] !== undefined)
    .slice(-5)
    .reverse()
    .map((i) => ({ id: i.id, at: i.createdAt, meta: snap.conversation.meta[i.id] }));
  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btn}
        className={`cost${over ? " cost--warn" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Spend on this project (estimate)"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {money(amount)} · {over ? `over ${money(limit, 0)}` : tokens(tok)}
      </button>
      {open && (
        <div ref={pop} className="popover costpop" role="dialog" aria-label="Spending">
          <span className="eyebrow">Spending</span>
          <div className="costpop__totals">
            <span>This project</span>
            <b>{money(amount)}</b>
            <span>All time</span>
            <b>{money(allTime + amount)}</b>
          </div>
          {calls.length > 0 && (
            <>
              <span className="eyebrow">Last {calls.length} calls</span>
              <ul className="costpop__calls">
                {calls.map(({ id, at, meta }) =>
                  meta ? (
                    <li key={id}>
                      <span>
                        {shortModelName(meta.servedBy.modelId, models)}
                        {meta.effortUsed
                          ? ` · ${EFFORT_LABEL[meta.effortUsed] ?? meta.effortUsed}`
                          : ""} · {relativeTime(at)}
                      </span>
                      <span>
                        {tokens(meta.usage.inputTokens + meta.usage.outputTokens)} ·{" "}
                        {meta.cost ? money(meta.cost.amount) : "—"}
                      </span>
                    </li>
                  ) : null,
                )}
              </ul>
            </>
          )}
          <span className="costpop__note">
            Warnings at{" "}
            {settings?.spending.perActionWarnUsd !== null && settings
              ? money(settings.spending.perActionWarnUsd)
              : "—"}{" "}
            per action and {limit !== null ? money(limit) : "—"} per project. Estimates from token counts;
            your Anthropic bill is authoritative.
          </span>
          <button
            className="btn btn--link"
            onClick={() => {
              useApp.getState().openSettings("spending");
            }}
          >
            Change limits in Settings
          </button>
        </div>
      )}
    </div>
  );
}

export function TitleBar() {
  const route = useApp((s) => s.route);
  const menuOpen = useApp((s) => s.menuOpen);
  const setMenu = useApp((s) => s.setMenu);
  const offline = useApp((s) => s.banners.offline);
  const saveState = useProject((s) => s.saveState);
  const hasProject = useProject((s) => s.snap !== null);
  const pref = useSettings((s) => s.settings?.ui.theme ?? "dark");
  const theme = useAppliedTheme();
  const menuBtn = useRef<HTMLButtonElement>(null);
  const inWorkspace = route === "workspace" && hasProject;
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header className="titlebar">
      <button
        ref={menuBtn}
        className="iconbtn"
        aria-label="App menu (Alt)"
        title="Menu (Alt)"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenu(!menuOpen);
        }}
      >
        <Icon name="menu" />
      </button>
      {menuOpen && <AppMenu anchor={menuBtn} />}
      <button
        className="brand"
        title="Home (Ctrl+Shift+H)"
        onClick={() => void goHome()}
        disabled={route === "setup"}
      >
        <Mark />
        Slabyrinth
      </button>
      {inWorkspace && (
        <>
          <span className="crumb" aria-hidden="true">
            /
          </span>
          <div className="projname">
            <ProjectName />
          </div>
          <span className={`saved${saveState === "failed" ? " saved--failed" : ""}`} role="status">
            {saveState === "saving" ? "Saving…" : saveState === "failed" ? "Couldn't save" : "Saved"}
          </span>
        </>
      )}
      <div className="titlebar__center">{inWorkspace && <Stepper />}</div>
      {route !== "setup" && <CostMeter />}
      {offline && <span className="statusdot" title="You're offline" role="img" aria-label="Offline" />}
      <button
        className="iconbtn"
        aria-label={`Theme: ${pref === "system" ? "match system" : theme}. Switch to ${next}`}
        title={`Theme: ${pref === "system" ? `Match system (${theme})` : theme === "dark" ? "Dark" : "Light"}`}
        onClick={toggleTheme}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </button>
      <button
        className="iconbtn"
        aria-label="Settings (Ctrl+,)"
        title="Settings (Ctrl+,)"
        onClick={() => {
          useApp.getState().openSettings();
        }}
      >
        <Icon name="gear" />
      </button>
    </header>
  );
}
