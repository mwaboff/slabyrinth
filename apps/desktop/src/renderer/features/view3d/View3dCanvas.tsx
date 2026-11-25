/**
 * The bare 3D viewer: a focusable canvas that fills its container, hosting the engine. Props give it a SceneSource and
 * a build id; callbacks report progress, errors, state and picks; the ref is the engine's imperative API (View3dApi),
 * so the tab's surface can add buttons, menus and shortcuts. No toolbar and no copy beyond the accessible name and the
 * error text: the surface is designed separately.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { targetKey, type SceneProgress, type SceneSource, type SceneTarget } from "./sceneSource";
import type { RenderBackend } from "./engine/backend";
import {
  View3dEngine,
  type EngineOptions,
  type PickInfo,
  type View3dApi,
  type View3dError,
  type View3dEvents,
  type View3dState,
  type ViewStats,
} from "./engine/engine";
import { GlUnavailable, createGlBackend, type GlBackendHandlers } from "./gl/glBackend";
import { attachInput, KEYS, type KeyBindings } from "./input";
import "./view3d.css";

/** Device-pixel ratio cap: sharper is not worth the fill cost on a map this busy. */
export const MAX_DPR = 1.5;

export interface View3dCanvasProps {
  source: SceneSource;
  /** The plan version or build to show (opened again when it changes). */
  target: SceneTarget;
  onProgress?: (p: SceneProgress) => void;
  onError?: (e: View3dError) => void;
  onState?: (s: View3dState) => void;
  onPick?: (p: PickInfo | null) => void;
  onHover?: (p: PickInfo | null) => void;
  onFrame?: (s: ViewStats) => void;
  /** A new header: the first scene, or the detailed one that replaced the boxes scene. */
  onHeader?: (h: View3dEvents["header"]) => void;
  /** Mesh detail streaming: resident of those with detail, and requests in flight. */
  onDetail?: (d: View3dEvents["detail"]) => void;
  /** The canvas's accessible name (default "3D view of the map"). */
  label?: string;
  /** Id of the element that says how to move (the canvas's accessible description). */
  describedBy?: string;
  maxDpr?: number;
  keyBindings?: KeyBindings;
  options?: EngineOptions;
  className?: string;
  /** Replaces the WebGL2 backend (tests). */
  createBackend?: (canvas: HTMLCanvasElement, handlers: GlBackendHandlers) => RenderBackend;
  ref?: Ref<View3dApi | null>;
}

/** The plain sentence for an error the viewer shows in place of the picture. */
export function errorText(e: View3dError): string {
  switch (e.code) {
    case "no-webgl2":
      return "3D needs graphics acceleration (WebGL2), which isn't available here.";
    case "init-failed":
      return "The graphics driver could not start the 3D view.";
    case "source":
      return e.sourceCode === "not-found"
        ? "There is no 3D scene for this version of the map."
        : e.sourceCode === "no-plan"
          ? "There's no plan to show in 3D yet."
          : e.sourceCode === "cancelled"
            ? "Loading the 3D scene was stopped."
            : `The 3D scene could not be loaded: ${e.message}`;
  }
}

export function View3dCanvas(props: View3dCanvasProps): React.JSX.Element {
  const { source, target, label, className, ref } = props;
  const key = targetKey(target);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<View3dEngine | null>(null);
  const [error, setError] = useState<View3dError | null>(null);
  // the latest props, read by long-lived listeners
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  // create the engine on the canvas (once per mount)
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let eng: View3dEngine | null = null;
    const handlers: GlBackendHandlers = {
      onLost: () => eng?.contextLost(),
      onRestored: () => eng?.contextRestored(),
    };
    let backend: RenderBackend | null = null;
    let failure: View3dError | null = null;
    try {
      backend = (latest.current.createBackend ?? createGlBackend)(el, handlers);
    } catch (e) {
      failure =
        e instanceof GlUnavailable
          ? { code: e.reason, message: e.message }
          : { code: "init-failed", message: e instanceof Error ? e.message : String(e) };
    }
    eng = new View3dEngine(backend, el, latest.current.options);
    const offs = [
      eng.on("state", (s) => {
        if (s.kind === "error") {
          setError(s.error);
          latest.current.onError?.(s.error);
        } else setError(null);
        latest.current.onState?.(s);
      }),
      eng.on("progress", (p) => latest.current.onProgress?.(p)),
      eng.on("pick", (p) => latest.current.onPick?.(p)),
      eng.on("hover", (p) => latest.current.onHover?.(p)),
      eng.on("frame", (s) => latest.current.onFrame?.(s)),
      eng.on("header", (h) => latest.current.onHeader?.(h)),
      eng.on("detail", (d) => latest.current.onDetail?.(d)),
    ];
    if (failure) eng.fail(failure);
    const detach = attachInput(el, eng, () => latest.current.keyBindings ?? KEYS);
    setEngine(eng);
    return () => {
      detach();
      for (const off of offs) off();
      eng.dispose();
      setEngine(null);
    };
  }, []);

  // size: follow the container, device pixels capped
  useEffect(() => {
    const box = wrap.current;
    if (!engine || !box) return;
    const fit = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, latest.current.maxDpr ?? MAX_DPR);
      const w = Math.max(1, box.clientWidth);
      const h = Math.max(1, box.clientHeight);
      engine.resize(Math.round(w * dpr), Math.round(h * dpr));
    };
    fit();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", fit);
      return () => {
        window.removeEventListener("resize", fit);
      };
    }
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => {
      ro.disconnect();
    };
  }, [engine]);

  // the scene (opened again when the target's key changes, not on every new target object)
  useEffect(() => {
    if (!engine || engine.state.kind === "error") return;
    engine.open(source, latest.current.target);
    return () => {
      engine.close();
    };
  }, [engine, source, key]);

  useImperativeHandle(ref, () => engine as View3dApi, [engine]);

  return (
    <div ref={wrap} className={className ? `view3d ${className}` : "view3d"}>
      <canvas
        ref={canvas}
        className="view3d__canvas"
        role="application"
        aria-label={label ?? "3D view of the map"}
        aria-roledescription="3D view"
        aria-describedby={props.describedBy}
        tabIndex={0}
        hidden={error !== null && (error.code === "no-webgl2" || error.code === "init-failed")}
      />
      {error ? (
        <p className="view3d__error" role="alert">
          {errorText(error)}
        </p>
      ) : null}
    </div>
  );
}
