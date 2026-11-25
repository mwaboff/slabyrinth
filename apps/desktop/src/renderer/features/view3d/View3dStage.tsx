/**
 * The 3D tab (design 4.1–4.2): the map version shown on the Map tab, piece for piece as TaleSpire will get it, in
 * plain colours. Around the canvas: a toolbar (frame all, top-down, roofs, cut height once roofs are off, the version
 * it shows, Controls), the stage bar's level tabs as the one "show up to" control (LevelCutTabs), the colour key on
 * the right (it hides kinds of piece), the clicked piece's card, a first-use hint, move buttons, and every state in
 * plain words with what to do. It is never a step: Build and pasting do not wait on it, and the status bar's
 * Approve / Build button stays where it is.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapPlan } from "@slabyrinth/core";
import type { ColourClass } from "@slabyrinth/scene3d";
import { VIEW3D_LIMITS } from "../../../shared/schemas/ipc";
import { call, errorMessage, tryCall } from "../../bridge/client";
import { useApp } from "../../stores/app";
import { useMap } from "../../stores/map";
import { levelShort, useProject } from "../../stores/project";
import { useView3d } from "../../stores/view3d";
import { Icon, type IconName } from "../../ui/Icon";
import { useTsBannerShown } from "../../app/Banners";
import { MOVE_SUMMARY } from "./controls";
import type { PickInfo, View3dApi, View3dEvents, View3dState } from "./engine/engine";
import { ipcSceneSource } from "./ipcSceneSource";
import { levelsAbove } from "./LevelCutTabs";
import type { SceneHeader, SceneSource, SceneTarget } from "./sceneSource";
import { View3dCanvas, errorText, type View3dCanvasProps } from "./View3dCanvas";
import {
  ColourKey,
  ControlsButton,
  CutHeight,
  HintCard,
  NavCluster,
  Readout,
  cutRange,
} from "./View3dPanels";
import "./view3dStage.css";

/** A status line over the canvas and, when there is one, what to do about it. */
export interface Note {
  id: string;
  text: string;
  busy?: boolean;
  icon?: IconName;
  action?: { label: string; run: () => void };
}

/**
 * Why pieces are boxes, in plain words with what to do (from the scene's own reasons). When the app's banner already
 * says TaleSpire wasn't found, the note only says what that means here, with no second "locate" button.
 */
export function boxesNote(
  h: SceneHeader,
  openSettings: (s: "ai" | "talespire") => void,
  bannerShown: boolean,
): Note | null {
  if (h.boxes.pieces === 0) return null;
  const reasons = new Set(h.boxes.reasons.map((r) => r.reason));
  if (reasons.has("boxes-requested"))
    return {
      id: "off",
      text: "Every piece is a plain box because 3D pieces are turned off.",
      action: {
        label: "Turn on in Settings",
        run: () => {
          openSettings("ai");
        },
      },
    };
  if (reasons.has("no-install"))
    return bannerShown
      ? { id: "no-install", text: "Every piece is a plain box of its real size until TaleSpire is found." }
      : {
          id: "no-install",
          text: "Every piece is a plain box of its real size: TaleSpire wasn't found on this PC.",
          action: {
            label: "Locate TaleSpire…",
            run: () => {
              openSettings("talespire");
            },
          },
        };
  // "reading" only while main is reading them: pieces it already tried and could not read stay boxes for good
  if (h.pendingDetail > 0)
    return {
      id: "reading",
      busy: true,
      text: "Reading TaleSpire's pieces (once after each game update). Plain boxes until then; the real shapes appear by themselves.",
    };
  return { id: "boxes", text: h.boxes.note };
}

/** Without a graphics card that can draw 3D: a still picture of the same version from main (view3d:shot). */
function StillPicture({
  target,
  levelId,
  version,
}: {
  target: SceneTarget;
  levelId: string | null;
  version: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<{ url: string; caption: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const v = target.version;
  useEffect(() => {
    const live = { now: true };
    let url: string | null = null;
    const el = box.current;
    const clamp = (n: number): number =>
      Math.max(VIEW3D_LIMITS.shotMinPx, Math.min(1600, VIEW3D_LIMITS.shotMaxPx, Math.round(n)));
    const width = clamp(el?.clientWidth ?? 960);
    const height = clamp((el?.clientHeight ?? 640) - 48);
    void (async () => {
      try {
        const h = await call("view3d:open", v !== undefined ? { version: v } : {});
        try {
          const shot = await call("view3d:shot", {
            sceneId: h.sceneId,
            shot: levelId !== null ? `level:${levelId}` : "overview",
            width,
            height,
          });
          if (!live.now) return;
          url = URL.createObjectURL(new Blob([shot.png.slice()], { type: "image/png" }));
          setImg({ url, caption: shot.caption });
          setFailed(null);
        } finally {
          // the picture is made: release the scene (a failure here only leaves it until the next open)
          const closed = await tryCall("view3d:close", { sceneId: h.sceneId });
          if (!closed.ok) console.warn(`view3d:close failed: ${closed.error.message}`);
        }
      } catch (e) {
        if (live.now) setFailed(errorMessage(e));
      }
    })();
    return () => {
      live.now = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [v, levelId]);
  return (
    <div ref={box} className="v3still">
      <p className="v3still__why">
        <Icon name="info" size="sm" />
        Your graphics card can't show the 3D view on this PC, so this is a still picture of v{version}. The
        level tabs still choose what it shows, and Claude's 3D pictures still work.
      </p>
      {img ? (
        <img className="v3still__img" src={img.url} alt={img.caption} />
      ) : failed !== null ? (
        <p role="alert">The picture couldn't be made: {failed}</p>
      ) : (
        <p role="status" className="v3still__wait">
          <span className="spinner" aria-hidden="true" />
          Drawing a picture of the map…
        </p>
      )}
    </div>
  );
}

/** Laying out, or an error with what to do: a card in the middle of the canvas. */
function CentreCard({ children, alert }: { children: React.ReactNode; alert?: boolean }) {
  return (
    <div className="v3centre">
      <div className="v3centre__card" role={alert === true ? "alert" : "status"}>
        {children}
      </div>
    </div>
  );
}

export function View3dStage({
  plan,
  version,
  source: given,
  createBackend,
}: {
  plan: MapPlan;
  version: number;
  /** The scene source (default: main, through the bridge). */
  source?: SceneSource;
  /** Replaces the WebGL2 backend (tests). */
  createBackend?: View3dCanvasProps["createBackend"];
}) {
  const source = useMemo(() => given ?? ipcSceneSource(), [given]);
  const target = useMemo<SceneTarget>(() => ({ version }), [version]);
  const api = useRef<View3dApi | null>(null);
  const openSettings = useApp((s) => s.openSettings);
  const bannerShown = useTsBannerShown();
  const head = useProject((s) => s.snap?.head ?? version);
  const keyCollapsed = useMap((s) => s.keyCollapsed);
  const toggleKey = useMap((s) => s.toggleKey);
  const cutLevelId = useView3d((s) => s.cutLevelId);
  const roofsHidden = useView3d((s) => s.roofsHidden);
  const hiddenClasses = useView3d((s) => s.hiddenClasses);
  const cutHeight = useView3d((s) => s.cutHeight);
  const hintDismissed = useView3d((s) => s.hintDismissed);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<View3dState>({ kind: "idle" });
  const [header, setHeader] = useState<SceneHeader | null>(null);
  const [detail, setDetail] = useState<View3dEvents["detail"] | null>(null);
  const [far, setFar] = useState(false);
  const [seen, setSeen] = useState(0);
  const [pick, setPick] = useState<PickInfo | null>(null);
  const [noGl, setNoGl] = useState(false);

  // the scene's levels (lowest first); before a scene, or without one, the plan's in the same order
  const levelOptions =
    header?.levels ??
    plan.levels
      .map((l, i) => ({ l, i }))
      .sort((a, b) => a.l.elevation - b.l.elevation || a.i - b.i)
      .map(({ l }, index) => ({ id: l.id, name: l.name, index, bounds: null }));
  const cutIndex = cutLevelId === null ? null : levelOptions.findIndex((l) => l.id === cutLevelId);
  const cut = cutIndex === null || cutIndex < 0 ? null : cutIndex;
  const ready = state.kind === "ready" && !noGl;
  const range = ready ? cutRange(header, cut) : null;

  // the filters follow the tab's choices (and are applied again to a new scene)
  useEffect(() => {
    api.current?.setCutLevel(cut);
  }, [cut, header]);
  useEffect(() => {
    api.current?.setRoofsHidden(roofsHidden);
  }, [roofsHidden, header]);
  useEffect(() => {
    api.current?.setHiddenClasses(hiddenClasses);
  }, [hiddenClasses, header]);
  // the cut height applies while it is offered (roofs off, a level taller than a storey and its roof)
  const cutOffered = range !== null && roofsHidden;
  useEffect(() => {
    api.current?.setCutHeight(cutOffered ? cutHeight : null);
  }, [cutHeight, cutOffered, header]);
  // a level picked on the tabs is framed (the camera turns to look into it); "All levels" keeps the camera
  const lastCut = useRef(cutLevelId);
  useEffect(() => {
    if (lastCut.current === cutLevelId) return;
    lastCut.current = cutLevelId;
    if (cut !== null && ready) api.current?.frameLevel(cut);
  }, [cutLevelId, cut, ready]);

  // test builds only (`--mode test`): the e2e suite reads the tab's viewer (its last frame and its filters)
  useEffect(() => {
    if (import.meta.env.MODE !== "test") return;
    (window as unknown as { __slabyrinthView3dTab?: unknown }).__slabyrinthView3dTab = {
      api: api.current,
      state: state.kind,
      noGl,
    };
  });

  const notes: Note[] = [];
  if (state.kind === "lost")
    notes.push({
      id: "lost",
      busy: true,
      text: "Your graphics card was reset. The view comes back by itself.",
    });
  if (header && state.kind !== "error") {
    const b = boxesNote(header, openSettings, bannerShown);
    if (detail && detail.inFlight > 0 && b?.id !== "reading")
      notes.push({
        id: "detail",
        busy: true,
        text: `Loading 3D pieces: ${detail.resident.toLocaleString()} of ${detail.total.toLocaleString()}. Plain boxes until they arrive.`,
      });
    if (b) notes.push(b);
    if (header.limited !== null) notes.push({ id: "limited", text: header.limited });
    else if (far) notes.push({ id: "far", text: "This map is very large, so far parts are simplified." });
  }

  // what is hidden right now, in one line with one way back
  const hiddenWords: string[] = [];
  if (cut !== null)
    for (const l of levelsAbove(plan, levelOptions[cut]?.id ?? ""))
      hiddenWords.push(`${levelShort(plan, l.id)} ${l.name}`);
  if (roofsHidden) hiddenWords.push("roofs");
  if (range && roofsHidden && cutHeight !== null)
    hiddenWords.push(`everything above ${String(Math.round((cutHeight - range.floor) * 5))} ft`);
  for (const c of header?.classes ?? [])
    if (hiddenClasses.includes(c.id as ColourClass) && c.id !== "roof")
      hiddenWords.push(c.label.toLowerCase());
  if (ready && hiddenWords.length > 0)
    notes.unshift({
      id: "hidden",
      icon: "eyeOff",
      text: `Hidden: ${hiddenWords.join(", ")}.`,
      action: {
        label: "Show everything",
        run: () => {
          const v = useView3d.getState();
          v.setCutLevel(null);
          v.setRoofsHidden(false);
          v.showAllClasses();
          v.setCutHeight(null);
        },
      },
    });

  const allBoxes = header !== null && header.boxes.pieces >= header.counts.instances;
  const layoutProgress = state.kind === "loading" ? state.progress : null;
  const roofSeen = header !== null && ((seen >>> header.classes.findIndex((c) => c.id === "roof")) & 1) === 1;
  const showKey = !noGl;

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="3D view">
        <div className="tgroup">
          <button
            className="tool"
            disabled={!ready}
            title="Frame the whole map (0)"
            onClick={() => api.current?.frameAll()}
          >
            <Icon name="fit" />
            Frame all
          </button>
          <button
            className="tool"
            disabled={!ready}
            title="Look straight down (T)"
            onClick={() => api.current?.topDown()}
          >
            <Icon name="topDown" />
            Top-down
          </button>
        </div>
        <span className="tsep" aria-hidden="true" />
        <div className="tgroup">
          <button
            className={`tool${roofsHidden ? " tool--on" : ""}`}
            aria-pressed={roofsHidden}
            disabled={!ready || !roofSeen}
            title={
              !ready || roofSeen ? "Hide the roofs to look inside buildings (R)" : "This map has no roofs"
            }
            onClick={() => {
              useView3d.getState().setRoofsHidden(!roofsHidden);
            }}
          >
            <Icon name="roof" />
            Hide roofs
          </button>
          {range && roofsHidden && <CutHeight range={range} disabled={!ready} />}
        </div>
        <span className="toolbar__sp" />
        <span className="toolbar__txt v3tools__what">
          <b>v{version}</b>
          {version !== head ? " (an older version)" : ""} as TaleSpire will get it
        </span>
        <span className="tsep" aria-hidden="true" />
        <ControlsButton />
      </div>
      <div
        className={`v3content${!showKey ? " v3content--nokey" : keyCollapsed ? " v3content--keyless" : ""}`}
      >
        <div
          className="v3stage"
          onKeyDown={(e) => {
            if (!(e.target instanceof HTMLCanvasElement) || !api.current) return;
            // Esc clears the engine's selection on the canvas; the card goes with it
            if (e.key === "Escape") setPick(null);
            // Enter on the focused view: what is in the middle of it (the keyboard's click)
            if (e.key !== "Enter") return;
            e.preventDefault();
            const r = e.target.getBoundingClientRect();
            const p = api.current.pickAt(r.left + r.width / 2, r.top + r.height / 2);
            api.current.select(p ? p.id : null);
            setPick(p);
          }}
        >
          <p id="v3-move" className="sr-only">
            {MOVE_SUMMARY}
          </p>
          {noGl ? (
            <StillPicture
              target={target}
              levelId={cut === null ? null : (levelOptions[cut]?.id ?? null)}
              version={version}
            />
          ) : (
            <View3dCanvas
              key={attempt}
              ref={api}
              {...(createBackend ? { createBackend } : {})}
              source={source}
              target={target}
              label={`3D view of v${String(version)}`}
              describedBy="v3-move"
              showError={false}
              onState={(s) => {
                setState(s);
                if (s.kind === "error" && (s.error.code === "no-webgl2" || s.error.code === "init-failed"))
                  setNoGl(true);
              }}
              onHeader={(h) => {
                setHeader(h);
                setPick(null);
              }}
              onDetail={setDetail}
              onPick={setPick}
              onFrame={(st) => {
                const f = st.limited || st.lodChunks[2] > 0;
                setFar((x) => (x === f ? x : f));
                const s = api.current?.classesSeen() ?? 0;
                setSeen((x) => (x === s ? x : s));
              }}
            />
          )}

          {state.kind === "loading" && header === null && (
            <CentreCard>
              <span className="v3centre__t">
                <span className="spinner" aria-hidden="true" />
                Laying out v{version} in 3D…
              </span>
              {layoutProgress && layoutProgress.stage === "layout" && layoutProgress.total > 0 && (
                <>
                  <span
                    className="v3bar"
                    role="progressbar"
                    aria-label="Laying out"
                    aria-valuemin={0}
                    aria-valuemax={layoutProgress.total}
                    aria-valuenow={layoutProgress.done}
                  >
                    <i
                      style={{
                        width: `${String(Math.round((layoutProgress.done / layoutProgress.total) * 100))}%`,
                      }}
                    />
                  </span>
                  <span className="muted">
                    {layoutProgress.done.toLocaleString()} of {layoutProgress.total.toLocaleString()} pieces
                  </span>
                </>
              )}
              <button
                className="btn btn--sm"
                onClick={() => {
                  source.cancel();
                }}
              >
                Stop
              </button>
            </CentreCard>
          )}
          {state.kind === "error" && state.error.code === "source" && (
            <CentreCard alert>
              <span>{errorText(state.error)}</span>
              {state.error.sourceCode !== "no-plan" && (
                <button
                  className="btn btn--sm"
                  onClick={() => {
                    setState({ kind: "idle" });
                    setHeader(null);
                    setAttempt((n) => n + 1);
                  }}
                >
                  <Icon name="retry" size="sm" />
                  Try again
                </button>
              )}
            </CentreCard>
          )}

          {ready && !hintDismissed && <HintCard version={version} hasKey={showKey && !keyCollapsed} />}
          {pick && (
            <Readout
              plan={plan}
              pick={pick}
              allBoxes={allBoxes}
              onClear={() => {
                api.current?.select(null);
                setPick(null);
              }}
            />
          )}
          <ul className="v3notes" role="status" aria-live="polite" aria-label="3D view status">
            {notes.map((n) => (
              <li key={n.id} className="v3notes__item">
                {n.busy === true ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <Icon name={n.icon ?? "info"} size="sm" className="v3notes__icon" />
                )}
                <span>{n.text}</span>
                {n.action && (
                  <button className="btn btn--sm" onClick={n.action.run}>
                    {n.action.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!noGl && <NavCluster api={api} disabled={!ready} />}
        </div>
        {showKey &&
          (keyCollapsed ? (
            <button
              className="keyrail"
              aria-label="Show colour key (Ctrl+])"
              title="Show colour key (Ctrl+])"
              onClick={() => {
                toggleKey(true);
              }}
            >
              <Icon name="left" />
            </button>
          ) : (
            <ColourKey header={header} seen={seen} disabled={!ready} />
          ))}
      </div>
    </>
  );
}
