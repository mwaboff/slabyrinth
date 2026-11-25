/**
 * The 3D tab (design 4.1–4.2, plain first cut): the map version shown on the Map tab, in 3D, with a small toolbar
 * (frame all, top-down, show up to a level, roofs on/off, how to move), the states in plain words, a readout of the
 * clicked piece, and a still picture when this PC cannot draw 3D. It is never a step: Build and pasting do not wait
 * on it. The toolbar wording and layout are provisional: a design pass shapes the final surface (toolbar, colour key,
 * first-run card).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapPlan } from "@slabyrinth/core";
import { VIEW3D_LIMITS } from "../../../shared/schemas/ipc";
import { call, errorMessage, tryCall } from "../../bridge/client";
import { cellName } from "../../lib/format";
import { useApp } from "../../stores/app";
import { useMap } from "../../stores/map";
import { levelShort } from "../../stores/project";
import { roleWords } from "./engine/roles";
import type { PickInfo, View3dApi, View3dEvents, View3dState } from "./engine/engine";
import { ipcSceneSource } from "./ipcSceneSource";
import type { SceneHeader, SceneSource, SceneTarget } from "./sceneSource";
import { View3dCanvas, type View3dCanvasProps } from "./View3dCanvas";
import "./view3dStage.css";

/** How to move, in one line (also the canvas's accessible description). */
export const MOVE_HINT =
  "Drag to turn · right-drag or Shift-drag to pan · wheel to zoom · WASD to move · arrows to turn · R roofs";

/** A status line and, when there is one, what to do about it. */
interface Note {
  id: string;
  text: string;
  action?: { label: string; run: () => void };
}

/** Why pieces are boxes, in plain words with what to do (from the scene's own reasons). */
export function boxesNote(h: SceneHeader, openSettings: (s: "ai" | "talespire") => void): Note | null {
  if (h.boxes.pieces === 0) return null;
  const reasons = new Set(h.boxes.reasons.map((r) => r.reason));
  if (reasons.has("boxes-requested"))
    return {
      id: "off",
      text: "Showing boxes because the 3D view is off. Turn on “Let Claude look at the map in 3D” in Settings › AI to see TaleSpire's pieces.",
      action: {
        label: "Open AI settings",
        run: () => {
          openSettings("ai");
        },
      },
    };
  if (reasons.has("no-install"))
    return {
      id: "no-install",
      text: "Showing boxes because TaleSpire was not found on this PC. Set its folder in Settings › TaleSpire to see its pieces.",
      action: {
        label: "Open TaleSpire settings",
        run: () => {
          openSettings("talespire");
        },
      },
    };
  if (reasons.has("not-read-yet") || h.pendingDetail > 0)
    return {
      id: "reading",
      text: "Showing boxes because 3D pieces are still being read from TaleSpire (once after each game update). They appear by themselves.",
    };
  return { id: "boxes", text: h.boxes.note };
}

/** The plan element's name as the map shows it (a room's name or key, a feature's type), else its id. */
function elementLabel(plan: MapPlan, id: string): string {
  for (const l of plan.levels) {
    const a = l.areas.find((x) => x.id === id);
    if (a) return a.name ?? (a.key !== undefined ? `Room ${a.key}` : id);
    const f = l.features.find((x) => x.id === id);
    if (f) return f.type.replace(/_/g, " ");
  }
  return id;
}

/** "square H12" in the level's own ruler letters, when the piece came from a plan cell on a known level. */
function squareOf(plan: MapPlan, p: PickInfo): string | null {
  const l = plan.levels.find((x) => x.id === p.levelId);
  if (!p.cell || !l) return null;
  return `square ${cellName(p.cell[0] - l.bounds.x, p.cell[1] - l.bounds.y)}`;
}

/** What the clicked piece is: its role (else its colour class), name, level, plan element and square. */
export function Readout({ plan, pick, onClear }: { plan: MapPlan; pick: PickInfo; onClear: () => void }) {
  const what = roleWords(pick.role) ?? pick.classLabel;
  const square = squareOf(plan, pick);
  return (
    <section className="v3read" aria-label="Selected piece">
      <p className="v3read__what">
        <b>{what}</b> · {pick.name}
      </p>
      <p>
        {levelShort(plan, pick.levelId)} {pick.levelName}
        {pick.elementId !== null ? ` · ${elementLabel(plan, pick.elementId)}` : ""}
        {square !== null ? ` · ${square}` : ""}
      </p>
      {pick.stand === "box" && <p className="muted">Shown as a box of its real size</p>}
      <button className="tool" onClick={onClear}>
        Clear
      </button>
    </section>
  );
}

/** Without WebGL2: a software picture of the same version from main (view3d:shot), overview or one level. */
function StillPicture({ target, levelId }: { target: SceneTarget; levelId: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<{ url: string; caption: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const version = target.version;
  useEffect(() => {
    const live = { now: true };
    let url: string | null = null;
    const el = box.current;
    const clamp = (n: number): number =>
      Math.max(VIEW3D_LIMITS.shotMinPx, Math.min(1600, VIEW3D_LIMITS.shotMaxPx, Math.round(n)));
    const width = clamp(el?.clientWidth ?? 960);
    const height = clamp(el?.clientHeight ?? 640);
    void (async () => {
      try {
        const h = await call("view3d:open", version !== undefined ? { version } : {});
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
  }, [version, levelId]);
  return (
    <div ref={box} className="v3still">
      <p className="v3still__why">
        3D needs graphics acceleration, which isn't available here, so this is a still picture. The 3D
        pictures Claude uses still work.
      </p>
      {img ? (
        <img className="v3still__img" src={img.url} alt={img.caption} />
      ) : failed !== null ? (
        <p role="alert">The picture could not be made: {failed}</p>
      ) : (
        <p role="status">Drawing a picture of the map…</p>
      )}
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
  const mapLevel = useMap((s) => s.levelId);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<View3dState>({ kind: "idle" });
  const [header, setHeader] = useState<SceneHeader | null>(null);
  const [detail, setDetail] = useState<View3dEvents["detail"] | null>(null);
  const [far, setFar] = useState(false);
  const [pick, setPick] = useState<PickInfo | null>(null);
  const [noGl, setNoGl] = useState(false);
  const [cut, setCut] = useState<number | null>(null);
  const [roofsHidden, setRoofsHidden] = useState(false);
  // the scene's levels (lowest first); before a scene, or without one, the plan's in the same order
  const levelOptions =
    header?.levels ??
    plan.levels
      .map((l, i) => ({ l, i }))
      .sort((a, b) => a.l.elevation - b.l.elevation || a.i - b.i)
      .map(({ l }, index) => ({ id: l.id, name: l.name, index }));

  // the filters follow the controls (and are applied again to a new scene)
  useEffect(() => {
    api.current?.setCutLevel(cut);
  }, [cut, header]);
  useEffect(() => {
    api.current?.setRoofsHidden(roofsHidden);
  }, [roofsHidden, header]);

  // test builds only (`--mode test`): the e2e suite reads the tab's viewer (its last frame and its filters)
  useEffect(() => {
    if (import.meta.env.MODE !== "test") return;
    (window as unknown as { __slabyrinthView3dTab?: unknown }).__slabyrinthView3dTab = {
      api: api.current,
      state: state.kind,
      noGl,
    };
  });

  // a level tab click (or PgUp/PgDn) on the stage bar shows up to that level: only a change of the map's level
  // moves the cut (not the level the tab opened on, nor a new scene)
  const [seenLevel, setSeenLevel] = useState(mapLevel);
  if (mapLevel !== seenLevel) {
    setSeenLevel(mapLevel);
    const i = levelOptions.findIndex((l) => l.id === mapLevel);
    if (i >= 0) setCut(i);
  }

  const notes: Note[] = [];
  if (state.kind === "loading") {
    const p = state.progress;
    notes.push({
      id: "layout",
      text:
        p && p.stage === "layout" && p.total > 0
          ? `Laying out the map in 3D… ${p.done.toLocaleString()} of ${p.total.toLocaleString()} pieces`
          : "Laying out the map in 3D…",
      action: {
        label: "Stop",
        run: () => {
          source.cancel();
        },
      },
    });
  }
  if (state.kind === "lost")
    notes.push({ id: "lost", text: "The graphics card was reset; the view comes back by itself." });
  if (header && state.kind !== "error") {
    if (detail && detail.inFlight > 0)
      notes.push({
        id: "detail",
        text: `Loading detail ${detail.resident.toLocaleString()} of ${detail.total.toLocaleString()} · boxes until they arrive`,
      });
    const b = boxesNote(header, openSettings);
    if (b) notes.push(b);
    if (header.limited !== null) notes.push({ id: "limited", text: header.limited });
    else if (far) notes.push({ id: "far", text: "This map is very large, so far parts are simplified." });
  }

  const ready = state.kind === "ready" && !noGl;
  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="3D view">
        <span className="toolbar__txt">
          <b>3D of v{version}</b> · what TaleSpire will get
        </span>
        <span className="tsep" aria-hidden="true" />
        <button className="tool" disabled={!ready} onClick={() => api.current?.frameAll()}>
          Frame all
        </button>
        <button className="tool" disabled={!ready} onClick={() => api.current?.topDown()}>
          Top-down
        </button>
        <span className="tsep" aria-hidden="true" />
        <label className="toolbar__txt v3tools__label">
          Show up to
          <select
            className="select"
            aria-label="Show up to"
            value={cut === null ? "" : String(cut)}
            disabled={levelOptions.length < 2}
            onChange={(e) => {
              setCut(e.target.value === "" ? null : Number(e.target.value));
            }}
          >
            <option value="">All levels</option>
            {levelOptions.map((l) => (
              <option key={l.id} value={String(l.index)}>
                {levelShort(plan, l.id)} {l.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`tool${roofsHidden ? "" : " tool--on"}`}
          aria-pressed={!roofsHidden}
          disabled={noGl}
          title="Roofs on or off (R)"
          onClick={() => {
            setRoofsHidden(!roofsHidden);
          }}
        >
          Roofs
        </button>
        <span className="toolbar__sp" />
        <span id="v3-hint" className="toolbar__note muted v3tools__hint">
          {MOVE_HINT}
        </span>
      </div>
      <div
        className="v3stage"
        onKeyDown={(e) => {
          // R on the focused canvas: roofs on/off (the canvas's own keys move the camera)
          if (
            e.key.toLowerCase() === "r" &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.metaKey &&
            e.target instanceof HTMLCanvasElement
          ) {
            e.preventDefault();
            setRoofsHidden((h) => !h);
          }
        }}
      >
        {noGl ? (
          <StillPicture target={target} levelId={cut === null ? null : (levelOptions[cut]?.id ?? null)} />
        ) : (
          <View3dCanvas
            key={attempt}
            ref={api}
            {...(createBackend ? { createBackend } : {})}
            source={source}
            target={target}
            describedBy="v3-hint"
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
              setFar(st.limited || st.lodChunks[2] > 0);
            }}
          />
        )}
        {state.kind === "error" && state.error.code === "source" && (
          <div className="v3stage__retry">
            <button
              className="btn btn--ghost"
              onClick={() => {
                setState({ kind: "idle" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {notes.length > 0 && (
          <ul className="v3notes" role="status" aria-live="polite" aria-label="3D view status">
            {notes.map((n) => (
              <li key={n.id} className="v3notes__item">
                <span>{n.text}</span>
                {n.action && (
                  <button className="btn btn--ghost btn--sm" onClick={n.action.run}>
                    {n.action.label}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {pick && (
          <Readout
            plan={plan}
            pick={pick}
            onClear={() => {
              api.current?.select(null);
              setPick(null);
            }}
          />
        )}
      </div>
    </>
  );
}
