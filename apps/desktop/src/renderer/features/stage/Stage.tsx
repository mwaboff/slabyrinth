/** The stage (UX §6–7, §9): Map/Build tabs + level tabs, toolbar, canvas + room key / history, status bar. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./stage.css";
import type { MapPlan, PlanDiff } from "@slabyrinth/core";
import { Icon, Mark } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { displayOptions, useMap, type Layers } from "../../stores/map";
import { latestBuild, levelShort, orderedLevels, phaseOf, roomCount, useProject } from "../../stores/project";
import { useChat } from "../../stores/chat";
import { useSettings } from "../../stores/settings";
import { useBuild } from "../../stores/build";
import { useApp } from "../../stores/app";
import { call, tryCall } from "../../bridge/client";
import { useResolved, type Resolved } from "../../map/resolveClient";
import { MapView } from "../../map/MapView";
import { relativeTime, roundCost, roundSeconds, slabEstimate, sqSize } from "../../lib/format";
import { editRoomText, restoreVersion, run, sendPrepared } from "../../app/actions";
import { RoomKey } from "./RoomKey";
import { ApprovePopover } from "./ApprovePopover";
import { IssuesChip } from "./Issues";
import { HistoryPanel } from "./HistoryPanel";
import { PngExport } from "./PngExport";
import { BuildView, BuildToolbar } from "../build/BuildView";
import { View3dStage } from "../view3d/View3dStage";
import { briefSummary } from "../chat/BriefCard";
import { runPhase, useRunPhase, verb } from "../chat/activity";
import { AddonIndicator } from "../talespire/AddonParts";

// ───────────── stage bar ─────────────

function LevelTab({ id, plan, on }: { id: string; plan: MapPlan; on: boolean }) {
  const setLevel = useMap((s) => s.setLevel);
  const [editing, setEditing] = useState(false);
  const l = plan.levels.find((x) => x.id === id);
  const [name, setName] = useState(l?.name ?? "");
  if (!l) return null;
  const short = levelShort(plan, id);
  if (editing)
    return (
      <input
        className="input levelrename"
        autoFocus
        aria-label={`Rename ${short}`}
        value={name}
        maxLength={60}
        onChange={(e) => {
          setName(e.target.value);
        }}
        onBlur={() => {
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (name.trim() !== "" && name.trim() !== l.name) void editRoomText(id, { name: name.trim() });
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  return (
    <button
      role="tab"
      aria-selected={on}
      className={`tab${on ? " tab--on" : ""}`}
      title={`${short} ${l.name} · ${sqSize(l.bounds.w, l.bounds.h)} · ${roomCount(plan, id)} rooms — double-click to rename`}
      onClick={() => {
        setLevel(id);
      }}
      onDoubleClick={() => {
        setName(l.name);
        setEditing(true);
      }}
    >
      <span className="tab__lv">{short}</span>
      <span className="tab__name">{l.name}</span>
    </button>
  );
}

function StageBar({ plan }: { plan: MapPlan | null }) {
  const tab = useMap((s) => s.tab);
  const setTab = useMap((s) => s.setTab);
  const levelId = useMap((s) => s.levelId);
  const snap = useProject((s) => s.snap);
  const levels = orderedLevels(plan);
  const approved = snap?.approvedVersion !== null && snap?.approvedVersion !== undefined;
  const lowest = [...levels].sort((a, b) => a.elevation - b.elevation)[0];
  return (
    <div className="stagebar">
      <div role="tablist" aria-label="Stage" className="stagebar__group">
        <button
          role="tab"
          aria-selected={tab === "map"}
          className={`tab${tab === "map" ? " tab--on" : ""}`}
          onClick={() => {
            setTab("map");
          }}
          title="Map (Ctrl+1)"
        >
          Map
        </button>
        <button
          role="tab"
          aria-selected={tab === "3d"}
          aria-disabled={plan === null}
          className={`tab${tab === "3d" ? " tab--on" : ""}${plan === null ? " tab--disabled" : ""}`}
          title={plan !== null ? "3D (Ctrl+3)" : "3D shows the map once there's a plan"}
          onClick={() => {
            if (plan !== null) setTab("3d");
          }}
        >
          3D
        </button>
        <button
          role="tab"
          aria-selected={tab === "build"}
          aria-disabled={!approved}
          className={`tab${tab === "build" ? " tab--on" : ""}${!approved ? " tab--disabled" : ""}`}
          title={approved ? "Build (Ctrl+2)" : "Approve a plan version first"}
          onClick={() => {
            if (approved) setTab("build");
          }}
        >
          Build
        </button>
      </div>
      <span className="vsep" aria-hidden="true" />
      {plan === null ? (
        <span className="tab tab--disabled tab--static">No levels yet</span>
      ) : (
        <div role="tablist" aria-label="Levels" className="stagebar__group">
          {levels.map((l) => (
            <LevelTab key={l.id} id={l.id} plan={plan} on={l.id === levelId} />
          ))}
          {tab === "map" && (
            <button
              className="tab tab--add"
              aria-label="Add a level (asks Slabyrinth)"
              title="Add a level (asks Slabyrinth)"
              onClick={() => {
                useChat
                  .getState()
                  .setDraft(`Add a level below ${lowest ? levelShort(plan, lowest.id) : "L1"}: `);
                useChat.getState().focusComposer();
              }}
            >
              <Icon name="plus" />
            </button>
          )}
        </div>
      )}
      {plan !== null && tab === "map" && <IssuesChip plan={plan} />}
    </div>
  );
}

// ───────────── toolbar ─────────────

const LAYER_LABELS: Array<[keyof Layers, string]> = [
  ["grid", "Grid"],
  ["roomNumbers", "Room numbers"],
  ["roomNames", "Room names"],
  ["furniture", "Furniture"],
  ["gmLayer", "GM layer (traps, secret doors)"],
];

function LayersMenu() {
  const [open, setOpen] = useState(false);
  const layers = useMap((s) => s.layers);
  const toggle = useMap((s) => s.toggleLayer);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, menu],
    () => {
      setOpen(false);
    },
    btn,
  );
  return (
    <span className="toolwrap">
      <button
        ref={btn}
        className="tool"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="layers" />
        Layers
        <Icon name="down" size="xs" />
      </button>
      {open && (
        <div ref={menu} className="menu toolmenu" role="menu" aria-label="Layers">
          {LAYER_LABELS.map(([k, l]) => (
            <button
              key={k}
              role="menuitemcheckbox"
              aria-checked={layers[k]}
              className="menu__item"
              onClick={() => {
                toggle(k);
              }}
            >
              <span className={`box${layers[k] ? " box--on" : ""}`} aria-hidden="true">
                {layers[k] && <Icon name="check" />}
              </span>
              {l}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function CompareControl() {
  const snap = useProject((s) => s.snap);
  const compare = useMap((s) => s.compare);
  const setCompare = useMap((s) => s.setCompare);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, menu],
    () => {
      setOpen(false);
    },
    btn,
  );
  if (!snap || snap.head <= 1) return null;
  const parent = snap.versions.find((v) => v.number === snap.head)?.parentNumber ?? snap.head - 1;
  const against = compare.against ?? parent;
  return (
    <span className="toolwrap">
      <button
        className={`tool${compare.on ? " tool--on" : ""}`}
        aria-pressed={compare.on}
        title="Compare (C)"
        onClick={() => {
          setCompare({ on: !compare.on, against });
        }}
      >
        <Icon name="compare" />
        Compare v{against}
      </button>
      <button
        ref={btn}
        className="tool tool--narrow"
        aria-label="Compare with another version"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="down" size="xs" />
      </button>
      {open && (
        <div ref={menu} className="menu toolmenu" role="menu">
          {[...snap.versions]
            .filter((v) => v.number !== snap.head)
            .sort((a, b) => b.number - a.number)
            .map((v) => (
              <button
                key={v.number}
                role="menuitemradio"
                aria-checked={against === v.number}
                className="menu__item"
                onClick={() => {
                  setCompare({ on: true, against: v.number });
                  setOpen(false);
                }}
              >
                v{v.number} · {v.summary}
              </button>
            ))}
        </div>
      )}
    </span>
  );
}

function MapToolbar({ plan, version }: { plan: MapPlan; version: number }) {
  const tool = useMap((s) => s.tool);
  const setTool = useMap((s) => s.setTool);
  const zoom = useMap((s) => s.zoom);
  const historyOpen = useMap((s) => s.historyOpen);
  const setHistory = useMap((s) => s.setHistory);
  const pngOpen = useMap((s) => s.pngOpen);
  const setPng = useMap((s) => s.setPng);
  const versions = useProject((s) => s.snap?.versions.length ?? 0);
  const pngBtn = useRef<HTMLButtonElement>(null);
  const z = (n: number): void => void window.dispatchEvent(new CustomEvent("slab:zoom", { detail: n }));
  return (
    <div className="toolbar" role="toolbar" aria-label="Map tools">
      <div className="tgroup" role="radiogroup" aria-label="Tool">
        <button
          className={`tool${tool === "select" ? " tool--on" : ""}`}
          role="radio"
          aria-checked={tool === "select"}
          aria-label="Select (V)"
          title="Select (V)"
          onClick={() => {
            setTool("select");
          }}
        >
          <Icon name="cursor" />
        </button>
        <button
          className={`tool${tool === "pan" ? " tool--on" : ""}`}
          role="radio"
          aria-checked={tool === "pan"}
          aria-label="Pan (hold Space)"
          title="Pan (hold Space)"
          onClick={() => {
            setTool("pan");
          }}
        >
          <Icon name="hand" />
        </button>
      </div>
      <span className="tsep" />
      <div className="tgroup">
        <button
          className="tool"
          aria-label="Zoom out (−)"
          title="Zoom out (−)"
          onClick={() => {
            z(Math.max(0.25, zoom / 1.25));
          }}
        >
          <Icon name="minus" />
        </button>
        <button
          className="tool tool--zoom"
          title="Fit (0) / 100% (1)"
          onClick={() =>
            window.dispatchEvent(new CustomEvent(zoom === 1 ? "slab:fit" : "slab:zoom", { detail: 1 }))
          }
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          className="tool"
          aria-label="Zoom in (+)"
          title="Zoom in (+)"
          onClick={() => {
            z(Math.min(4, zoom * 1.25));
          }}
        >
          <Icon name="plus" />
        </button>
        <button
          className="tool"
          aria-label="Fit level (0)"
          title="Fit level (0)"
          onClick={() => window.dispatchEvent(new CustomEvent("slab:fit"))}
        >
          <Icon name="fit" />
        </button>
      </div>
      <span className="tsep" />
      <div className="tgroup">
        <LayersMenu />
        <CompareControl />
      </div>
      <span className="toolbar__sp" />
      <div className="tgroup">
        <button
          className={`tool${historyOpen ? " tool--on" : ""}`}
          aria-pressed={historyOpen}
          title="History (H)"
          onClick={() => {
            setHistory(!historyOpen);
          }}
        >
          <Icon name="history" />
          History · {versions}
        </button>
        <span className="tsep" />
        <span className="toolwrap">
          <button
            ref={pngBtn}
            className={`tool${pngOpen ? " tool--on" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={pngOpen}
            title="Export map as PNG (Ctrl+Shift+E)"
            onClick={() => {
              setPng(!pngOpen);
            }}
          >
            <Icon name="image" />
            Export PNG
          </button>
          {pngOpen && <PngExport anchor={pngBtn} plan={plan} version={version} />}
        </span>
      </div>
    </div>
  );
}

// ───────────── empty / generating ─────────────

function EmptyStage() {
  const snap = useProject((s) => s.snap);
  const live = useChat((s) => s.live);
  const est = useChat((s) => s.estimate);
  const sel = useChat((s) => s.selection);
  const models = useSettings((s) => s.models);
  const stop = useChat((s) => s.stop);
  if (!snap) return null;
  const b = snap.brief;
  const drafting =
    live !== null && (live.tools.some((t) => t.name === "create_plan") || live.progress !== null);
  const fp = b.footprint?.value;
  const lv = b.levels?.value;
  const [l1] = briefSummary(b);
  return (
    <div className="empty">
      <div className="empty__card">
        <Mark size={44} />
        {drafting ? (
          <>
            <h2>Drafting the plan</h2>
            <p className="empty__p">{live.progress?.label ?? "Reading the brief"}…</p>
            <div className="empty__bar" aria-hidden="true">
              <i />
            </div>
            <button className="btn" onClick={() => void stop()}>
              Stop
            </button>
          </>
        ) : (
          <>
            <h2>No map yet</h2>
            <p className="empty__p">
              Chat on the left to settle the brief. When you're ready, I'll draw a plan here — every room
              numbered, with notes for you.
            </p>
            <button
              className="btn btn--primary btn--lg"
              disabled={!b.mapType || live !== null}
              onClick={() => void sendPrepared("Draw the first plan from the brief.", "plan")}
            >
              Draw the first plan
            </button>
            <div className="empty__est">
              {b.mapType ? (
                <>
                  {est?.costUsd !== null && est?.costUsd !== undefined
                    ? `≈ ${roundCost(est.costUsd * 6)} · `
                    : ""}
                  {est?.seconds !== null && est?.seconds !== undefined
                    ? `${roundSeconds(est.seconds * 4).replace("~", "about ")} · `
                    : ""}
                  {sel
                    ? models.find((m) => m.modelId === sel.modelId)?.displayName.replace(/\s[\d.]+$/, "")
                    : ""}
                </>
              ) : (
                "Tell me what kind of place it is first."
              )}
            </div>
            <ul className="checklist">
              <li className={b.mapType ? "ok" : "todo"}>
                <Icon name={b.mapType ? "check" : "minus"} size="sm" />
                Map type{b.mapType ? ` — ${b.mapType.value}` : ""}
              </li>
              <li className={b.system || b.party ? "ok" : "todo"}>
                <Icon name={b.system || b.party ? "check" : "minus"} size="sm" />
                Game and party{l1.includes("·") ? ` — ${l1.split(" · ").slice(1).join(", ")}` : " — optional"}
              </li>
              <li className={fp || lv ? "ok" : "todo"}>
                <Icon name={fp || lv ? "check" : "minus"} size="sm" />
                Size{lv ? ` — ${lv.count} level${lv.count === 1 ? "" : "s"}` : ""}
                {fp
                  ? `, about ${fp.widthSq}×${fp.heightSq} squares`
                  : lv
                    ? ""
                    : " — optional, I'll choose if you don't"}
              </li>
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────── status bar ─────────────

function AssetChip() {
  const catalog = useSettings((s) => s.catalog);
  const busy = useSettings((s) => s.catalogBusy);
  if (!catalog) return null;
  const builtin = catalog.usingBuiltInOnly;
  return (
    <button
      className={`assetchip${builtin ? " assetchip--warn" : ""}`}
      title={
        builtin
          ? "TaleSpire not found — using the built-in asset set. Click to locate it."
          : "Asset library: read from your TaleSpire install"
      }
      onClick={() => {
        useApp.getState().openSettings("talespire");
      }}
    >
      {busy ? <span className="spinner" /> : <i aria-hidden="true" />}
      {busy
        ? "Updating assets…"
        : builtin
          ? "Built-in assets"
          : `Assets · ${catalog.assets.toLocaleString()}${catalog.generatedAt !== null ? ` · ${relativeTime(catalog.generatedAt).replace(" ago", "")}` : ""}`}
    </button>
  );
}

function StatusBar({ plan }: { plan: MapPlan | null }) {
  const snap = useProject((s) => s.snap);
  const tab = useMap((s) => s.tab);
  const levelId = useMap((s) => s.levelId);
  const approveOpen = useMap((s) => s.approveOpen);
  const setApprove = useMap((s) => s.setApprove);
  const live = useChat((s) => s.live);
  const phase_ = runPhase(live);
  const building = useBuild((s) => s.building);
  const approveBtn = useRef<HTMLButtonElement>(null);
  const [estChunks, setEstChunks] = useState<number | null>(null);
  const head = snap?.head ?? 0;
  useEffect(() => {
    if (head > 0)
      void tryCall("compile:estimate", {}).then((r) => {
        if (r.ok) setEstChunks(r.value.estimatedChunks);
      });
  }, [head]);
  if (!snap) return null;
  const phase = phaseOf(snap);
  if (phase === "brief" || !plan) {
    return (
      <footer className="statusbar">
        <span>Brief · nothing drawn yet</span>
        <span className="statusbar__sp" />
        <AssetChip />
        <AddonIndicator />
        <button
          className="btn btn--primary"
          disabled={!snap.brief.mapType || live !== null}
          title={live !== null ? "Slabyrinth is working" : undefined}
          onClick={() => void sendPrepared("Draw the first plan from the brief.", "plan")}
        >
          Draw the first plan
        </button>
      </footer>
    );
  }
  const level = plan.levels.find((l) => l.id === levelId);
  const v = snap.versions.find((x) => x.number === snap.head);
  const build = latestBuild(snap);
  if (tab === "build") {
    return (
      <footer className="statusbar">
        <span>Build of v{build?.versionNumber ?? snap.approvedVersion}</span>
        <span className="statusbar__sp" />
        <AssetChip />
        <AddonIndicator />
        <button
          className="btn btn--ghost"
          onClick={() => {
            useMap.getState().setTab("map");
          }}
        >
          Back to plan
        </button>
      </footer>
    );
  }
  const approvedHead = snap.approvedVersion === snap.head;
  return (
    <footer className="statusbar">
      {level && (
        <span className="statusbar__strong">{`${levelShort(plan, level.id)} · ${sqSize(level.bounds.w, level.bounds.h)}`}</span>
      )}
      <span className="dotsep">·</span>
      <span>{roomCount(plan, levelId ?? undefined)} rooms</span>
      {phase_ !== "idle" ? (
        <>
          <span className="dotsep">·</span>
          <span className="statusbar__live" role="status">
            <span className="spinner" aria-hidden="true" />
            {verb(phase_, snap.head, live?.newVersions.length ?? 0)}…
          </span>
        </>
      ) : (
        v && (
          <>
            <span className="dotsep">·</span>
            <span>
              v{v.number} by {v.author === "ai" ? "Slabyrinth" : v.author === "user" ? "you" : "restore"} ·{" "}
              {relativeTime(v.createdAt)}
            </span>
          </>
        )
      )}
      <span className="statusbar__sp" />
      <AssetChip />
      <AddonIndicator />
      <span className="muted">
        {plan.levels.length} level{plan.levels.length === 1 ? "" : "s"}
        {estChunks !== null ? ` · ${slabEstimate(estChunks)}` : ""}
      </span>
      {approvedHead ? (
        <button
          className="btn btn--primary"
          disabled={building}
          onClick={() => {
            useMap.getState().setTab("build");
            if (!build || build.versionNumber !== snap.head) void useBuild.getState().run(snap.head);
          }}
        >
          {build && build.versionNumber === snap.head ? "Open build" : "Build for TaleSpire"}
          <Icon name="right" />
        </button>
      ) : (
        <span className="toolwrap toolwrap--up">
          <button
            ref={approveBtn}
            className="btn btn--primary"
            disabled={live !== null}
            aria-haspopup="dialog"
            aria-expanded={approveOpen}
            title={
              live !== null
                ? "Available when the revision finishes"
                : "Approve current version (Ctrl+Shift+A)"
            }
            onClick={() => {
              setApprove(!approveOpen);
            }}
          >
            Approve plan v{snap.head}
            <Icon name="right" />
          </button>
          {approveOpen && <ApprovePopover version={snap.head} anchor={approveBtn} />}
        </span>
      )}
    </footer>
  );
}

// ───────────── map content ─────────────

function useCompare(): { diff: PlanDiff; old: Resolved | null } | null {
  const snap = useProject((s) => s.snap);
  const compare = useMap((s) => s.compare);
  const layers = useMap((s) => s.layers);
  const [state, setState] = useState<{ key: string; diff: PlanDiff; plan: MapPlan } | null>(null);
  const against = compare.against ?? snap?.versions.find((v) => v.number === snap.head)?.parentNumber ?? 0;
  const key = `${snap?.projectId ?? ""}:${against}:${snap?.head ?? 0}`;
  useEffect(() => {
    if (!compare.on || !snap || against <= 0) return;
    let alive = true;
    void Promise.all([
      call("plan:diff", { from: against, to: snap.head }),
      call("plan:getVersion", { version: against }),
    ]).then(([diff, plan]) => {
      if (alive) setState({ key, diff, plan });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare.on, key]);
  const old = useResolved(
    compare.on && state?.key === key ? state.plan : null,
    against,
    displayOptions(layers),
  ).data;
  const active = compare.on && state?.key === key;
  const diff = active ? state.diff : null;
  // stable identity so the memoised MapView only redraws when the comparison really changes
  return useMemo(() => (diff ? { diff, old } : null), [diff, old]);
}

function CompareChips({ diff }: { diff: PlanDiff }) {
  const select = useMap((s) => s.select);
  const ids = [...diff.areas.added, ...diff.areas.changed];
  const [i, setI] = useState(0);
  return (
    <button
      className="comparechip"
      title="Cycle through the changed rooms"
      onClick={() => {
        const id = ids[i % Math.max(1, ids.length)];
        if (id !== undefined) {
          select({ areaIds: [id], featureIds: [], openingIds: [], linkIds: [] });
          window.dispatchEvent(new CustomEvent("slab:reveal", { detail: id }));
        }
        setI(i + 1);
      }}
    >
      {diff.areas.added.length} added · {diff.areas.changed.length} changed · {diff.areas.removed.length}{" "}
      removed
    </button>
  );
}

export function MapContent({ plan, version }: { plan: MapPlan; version: number }) {
  const layers = useMap((s) => s.layers);
  const levelId = useMap((s) => s.levelId);
  const setLevel = useMap((s) => s.setLevel);
  const historyOpen = useMap((s) => s.historyOpen);
  const keyCollapsed = useMap((s) => s.keyCollapsed);
  const toggleKey = useMap((s) => s.toggleKey);
  const preview = useMap((s) => s.previewVersion);
  const setPreview = useMap((s) => s.preview);
  const snap = useProject((s) => s.snap);
  // Derived booleans only: subscribing to the whole live turn would re-render (and redraw) on every token.
  const runPhaseNow = useRunPhase();
  const newVersions = useChat((s) => s.live?.newVersions.length ?? 0);
  const revising = runPhaseNow !== "idle";
  const stop = useChat((s) => s.stop);
  const [fetched, setFetched] = useState<{ v: number; plan: MapPlan } | null>(null);
  useEffect(() => {
    if (preview === null) return;
    void run("plan:getVersion", { version: preview }, `Couldn't load v${preview}.`, (p) => {
      setFetched({ v: preview, plan: p });
    });
  }, [preview]);
  const previewPlan = preview !== null && fetched?.v === preview ? fetched.plan : null;
  const shownPlan = previewPlan ?? plan;
  const shownVersion = preview ?? version;
  const opts = useMemo(() => displayOptions(layers), [layers]);
  const { data, error } = useResolved(shownPlan, shownVersion, opts);
  const shortOf = useCallback((id: string) => levelShort(shownPlan, id), [shownPlan]);
  const setIssues = useMap((s) => s.setIssues);
  // The Issues chip, map markers and approve step describe the head version, never an old preview.
  useEffect(() => {
    if (preview === null && data) setIssues(data.issues);
  }, [data, preview, setIssues]);
  const compare = useCompare();
  const levels = orderedLevels(shownPlan);
  useEffect(() => {
    if (levels.length > 0 && !levels.some((l) => l.id === levelId)) setLevel(levels[0]?.id ?? "");
  }, [levels, levelId, setLevel]);
  const lid = levelId ?? levels[0]?.id ?? "";
  const resolvedLevel = data?.resolved.levels.find((l) => l.id === lid);
  const list = data?.lists[lid];

  const pv = snap?.versions.find((v) => v.number === preview);
  return (
    <div className={`content${keyCollapsed ? " content--keyless" : ""}`}>
      <div className="content__map">
        {revising && <div className="revisebar" aria-hidden="true" />}
        {preview !== null && pv && (
          <div className="oldbanner" role="status">
            <span>
              Viewing v{pv.number} ({relativeTime(pv.createdAt)}), read only.
            </span>
            <button className="btn btn--sm" onClick={() => void restoreVersion(pv.number)}>
              Restore this version
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setPreview(null);
              }}
            >
              Back to latest
            </button>
          </div>
        )}
        {compare && preview === null && <CompareChips diff={compare.diff} />}
        {revising && (
          <div
            className="revising"
            title="The map will update when this finishes. You can keep looking around."
          >
            <span className="spinner" aria-hidden="true" />
            {verb(runPhaseNow, snap?.head ?? 0, newVersions)}…
            <button className="btn btn--sm btn--ghost" title="Stop (Esc)" onClick={() => void stop()}>
              Stop
            </button>
          </div>
        )}
        {data && resolvedLevel && list ? (
          <MapView
            data={data}
            levelId={lid}
            levelName={resolvedLevel.name}
            readOnly={preview !== null}
            compare={preview === null ? compare : null}
            levelShort={shortOf}
          />
        ) : (
          <div className="canvas canvas--loading" role="status">
            {error !== null ? `The map couldn't be drawn: ${error}` : <span className="spinner" />}
          </div>
        )}
      </div>
      {keyCollapsed ? (
        <button
          className="keyrail"
          aria-label="Show room key (Ctrl+])"
          title="Show room key (Ctrl+])"
          onClick={() => {
            toggleKey(true);
          }}
        >
          <Icon name="left" />
          <span className="keyrail__n">
            {resolvedLevel?.areas.filter((a) => a.key !== undefined).length ?? 0}
          </span>
        </button>
      ) : historyOpen ? (
        <HistoryPanel />
      ) : (
        data &&
        resolvedLevel &&
        list && (
          <RoomKey
            level={resolvedLevel}
            links={data.resolved.links}
            list={list}
            plan={shownPlan}
            readOnly={preview !== null}
            short={levelShort(shownPlan, lid)}
          />
        )
      )}
    </div>
  );
}

export function Stage() {
  const snap = useProject((s) => s.snap);
  const tab = useMap((s) => s.tab);
  // 3D shows the version being viewed on the Map (head, or the one previewed from history)
  const previewVersion = useMap((s) => s.previewVersion);
  const plan = snap?.plan ?? null;
  const phase = phaseOf(snap);
  // Below 1500 px the room key starts collapsed (UX §3.2).
  useEffect(() => {
    if (window.innerWidth < 1500) useMap.getState().toggleKey(false);
  }, []);
  return (
    <main className="stage" aria-label="Stage">
      <StageBar plan={plan} />
      {tab === "build" && snap?.approvedVersion !== null ? (
        <>
          <BuildToolbar />
          <BuildView />
        </>
      ) : phase === "brief" || !plan ? (
        <>
          <div className="toolbar">
            <span className="toolbar__sp" />
            <span className="muted toolbar__note">Map tools appear once there's a plan</span>
          </div>
          <EmptyStage />
        </>
      ) : tab === "3d" ? (
        <View3dStage plan={plan} version={previewVersion ?? snap?.head ?? 0} />
      ) : (
        <>
          <MapToolbar plan={plan} version={snap?.head ?? 0} />
          <MapContent plan={plan} version={snap?.head ?? 0} />
        </>
      )}
      <StatusBar plan={plan} />
    </main>
  );
}
