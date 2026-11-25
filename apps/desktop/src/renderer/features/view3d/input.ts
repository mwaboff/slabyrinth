/**
 * Mouse and keyboard on the viewer's canvas. Mouse: left drag orbits, right drag or Shift + left drag pans, the wheel
 * zooms toward the point under the cursor, a click (no drag) picks and selects, hovering reports the piece under the
 * pointer (once per frame at most). Keyboard (canvas focused): the KEYS table, which the surface may replace; arrows
 * turn and tilt (Shift: pan) as the design's keyboard map says, so they never fight WASD.
 */
import type { View3dEngine } from "./engine/engine";

export type KeyAction =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "up"
  | "down"
  | "turnLeft"
  | "turnRight"
  | "tiltUp"
  | "tiltDown"
  | "zoomIn"
  | "zoomOut"
  | "frameAll"
  | "frameSelection"
  | "topDown"
  | "clearSelection";

/**
 * Keys (KeyboardEvent.key, lower case) per action. Shift makes moves faster, and makes the turn keys pan instead
 * (design 4.2: arrows turn and tilt, Shift+arrows pan; WASD flies, Q/E down and up).
 */
export type KeyBindings = Readonly<Record<KeyAction, readonly string[]>>;

export const KEYS: KeyBindings = {
  forward: ["w"],
  back: ["s"],
  left: ["a"],
  right: ["d"],
  turnLeft: ["arrowleft"],
  turnRight: ["arrowright"],
  tiltUp: ["arrowup"],
  tiltDown: ["arrowdown"],
  up: ["e"],
  down: ["q"],
  zoomIn: ["+", "="],
  zoomOut: ["-", "_"],
  frameAll: ["home", "0"],
  frameSelection: ["f"],
  topDown: ["t"],
  clearSelection: ["escape"],
};

/** The action a key does, or null. */
export function actionOf(key: string, bindings: KeyBindings): KeyAction | null {
  const k = key.toLowerCase();
  for (const [action, keys] of Object.entries(bindings) as [KeyAction, readonly string[]][])
    if (keys.includes(k)) return action;
  return null;
}

/** The fly direction of the held actions. */
export function moveOf(held: ReadonlySet<KeyAction>): { forward: number; right: number; up: number } {
  const d = (a: KeyAction, b: KeyAction): number => (held.has(a) ? 1 : 0) - (held.has(b) ? 1 : 0);
  return { forward: d("forward", "back"), right: d("right", "left"), up: d("up", "down") };
}

const DRAG_PX = 4;
const ORBIT_DEG_PER_PX = 0.3;
const ZOOM_STEP = 1.25;
/** One press of a turn key: degrees turned or tilted, or (with Shift) pixels panned. */
const TURN_DEG = 10;
const PAN_PX = 60;

/** Wires the canvas's input to the engine; returns the undo. */
export function attachInput(
  el: HTMLElement,
  engine: View3dEngine,
  bindings: () => KeyBindings = () => KEYS,
): () => void {
  let drag: { id: number; x: number; y: number; mode: "orbit" | "pan"; moved: boolean } | null = null;
  let hoverPending: { x: number; y: number } | null = null;
  let hoverFrame: number | null = null;
  const held = new Set<KeyAction>();
  let shift = false;

  const updateMove = (): void => {
    const m = moveOf(held);
    engine.setMove(m.forward, m.right, m.up, shift);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (drag) return;
    const pan = e.button === 2 || (e.button === 0 && e.shiftKey) || e.button === 1;
    if (e.button !== 0 && !pan) return;
    el.focus({ preventScroll: true });
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: pan ? "pan" : "orbit", moved: false };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.mode === "orbit") engine.orbit(-dx * ORBIT_DEG_PER_PX, dy * ORBIT_DEG_PER_PX);
      else engine.pan(dx, dy);
      return;
    }
    if (e.buttons !== 0) return;
    // hover: at most one pick per animation frame
    hoverPending = { x: e.clientX, y: e.clientY };
    hoverFrame ??= requestAnimationFrame(() => {
      hoverFrame = null;
      const p = hoverPending;
      hoverPending = null;
      if (p) engine.hoverAt(p.x, p.y);
    });
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasClick = !drag.moved && drag.mode === "orbit";
    drag = null;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (wasClick) engine.clickAt(e.clientX, e.clientY);
  };

  const onPointerLeave = (): void => {
    if (!drag) engine.hoverOut();
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-400, Math.min(400, e.deltaY * lines));
    engine.zoom(Math.exp(dy * 0.0015), e.clientX, e.clientY);
  };

  const onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = actionOf(e.key, bindings());
    shift = e.shiftKey;
    if (!action) {
      if (e.key === "Shift") updateMove();
      return;
    }
    e.preventDefault();
    switch (action) {
      case "forward":
      case "back":
      case "left":
      case "right":
      case "up":
      case "down":
        held.add(action);
        updateMove();
        return;
      case "turnLeft":
      case "turnRight":
      case "tiltUp":
      case "tiltDown": {
        const sx = action === "turnLeft" ? -1 : action === "turnRight" ? 1 : 0;
        const sy = action === "tiltUp" ? 1 : action === "tiltDown" ? -1 : 0;
        if (e.shiftKey) engine.pan(-sx * PAN_PX, sy * PAN_PX);
        else engine.orbit(sx * TURN_DEG, sy * TURN_DEG);
        return;
      }
      case "zoomIn":
        engine.zoom(1 / ZOOM_STEP);
        return;
      case "zoomOut":
        engine.zoom(ZOOM_STEP);
        return;
      case "frameAll":
        engine.frameAll();
        return;
      case "frameSelection":
        engine.frameSelection();
        return;
      case "topDown":
        engine.topDown();
        return;
      case "clearSelection":
        engine.select(null);
        return;
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    shift = e.shiftKey;
    const action = actionOf(e.key, bindings());
    if (action) held.delete(action);
    // a released Shift changes the speed; a released letter may arrive upper-case after Shift was let go
    if (e.key.length === 1) {
      for (const a of held) if (bindings()[a].includes(e.key.toLowerCase())) held.delete(a);
    }
    updateMove();
  };

  const onBlur = (): void => {
    held.clear();
    shift = false;
    updateMove();
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("pointerleave", onPointerLeave);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", onContextMenu);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("keyup", onKeyUp);
  el.addEventListener("blur", onBlur);
  return () => {
    if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerUp);
    el.removeEventListener("pointerleave", onPointerLeave);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("contextmenu", onContextMenu);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("keyup", onKeyUp);
    el.removeEventListener("blur", onBlur);
    onBlur();
  };
}
