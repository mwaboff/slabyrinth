import * as fs from "node:fs";
import * as path from "node:path";

/** Window bounds persistence (userData/window-state.json), clamped to a visible display. */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 800, maximized: false };

export function loadWindowState(file: string): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WindowState>;
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (!num(raw.width) || !num(raw.height)) return { ...DEFAULT_WINDOW_STATE };
    const s: WindowState = {
      width: Math.max(960, Math.min(raw.width, 10_000)),
      height: Math.max(600, Math.min(raw.height, 10_000)),
      maximized: raw.maximized === true,
    };
    if (num(raw.x) && num(raw.y)) {
      s.x = raw.x;
      s.y = raw.y;
    }
    return s;
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

/** Drops the position when the window would not overlap any display's work area by at least 100×60 px. */
export function clampToDisplays(state: WindowState, workAreas: Rect[]): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const { x, y, width, height } = { ...state, x: state.x, y: state.y };
  const visible = workAreas.some((a) => {
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const h = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
    return w >= 100 && h >= 60;
  });
  if (visible) return state;
  return { width: state.width, height: state.height, maximized: state.maximized };
}

export function saveWindowState(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // cosmetic: ignore
  }
}
