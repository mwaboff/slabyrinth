/** Export map as PNG popover (UX §6.10, architecture §5.5): same drawDisplayList, OffscreenCanvas, export:savePng. */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DisplayOptions, MapPlan } from "@slabyrinth/core";
import type { ProjectFile } from "../../../shared/project";
import { Icon } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { useMap } from "../../stores/map";
import { useApp } from "../../stores/app";
import { levelShort, orderedLevels, useProject } from "../../stores/project";
import { call, errorMessage } from "../../bridge/client";
import { run as runCall } from "../../app/actions";
import { resolveAsync, useResolved } from "../../map/resolveClient";
import { drawLevel, mapThemeFor, pngSize, printTheme, renderPng } from "../../map/render";
import { useAppliedTheme } from "../../app/theme";

interface PngOpts {
  scope: "level" | "all";
  gm: boolean;
  style: "print" | "screen";
  px: 50 | 70 | 100 | 140;
  grid: boolean;
  numbers: boolean;
  names: boolean;
}

const DEFAULTS: PngOpts = {
  scope: "level",
  gm: true,
  style: "print",
  px: 70,
  grid: true,
  numbers: true,
  names: false,
};

type Saved = NonNullable<ProjectFile["pngExport"]>;

/** Last-used options per project (ProjectSnapshot.pngExport, saved with project:setUiState). */
function fromSaved(s: Saved | null): PngOpts {
  if (!s) return DEFAULTS;
  const px = [50, 70, 100, 140].includes(s.pxPerSquare) ? (s.pxPerSquare as PngOpts["px"]) : 70;
  return {
    scope: s.scope,
    gm: s.gmLayer,
    style: s.style === "screen" ? "screen" : "print",
    px,
    grid: s.grid,
    numbers: s.numbers,
    names: s.names,
  };
}

function toSaved(o: PngOpts): Saved {
  return {
    scope: o.scope,
    style: o.style,
    pxPerSquare: o.px,
    grid: o.grid,
    numbers: o.numbers,
    names: o.names,
    gmLayer: o.gm,
  };
}

function displayOf(o: PngOpts): DisplayOptions {
  return {
    grid: o.grid,
    roomNumbers: o.numbers,
    roomNames: o.names,
    furniture: true,
    gmLayer: o.gm,
    legend: false,
  };
}

function Seg<T extends string | boolean | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segctl segctl--sm" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={value === v}
          onClick={() => {
            onChange(v);
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function PngExport({
  anchor,
  plan,
  version,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  plan: MapPlan;
  version: number;
}) {
  const snap = useProject((s) => s.snap);
  const levelId = useMap((s) => s.levelId);
  const close = (): void => {
    useMap.getState().setPng(false);
  };
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<HTMLCanvasElement>(null);
  useDismiss(true, [ref, anchor], close, anchor);
  const [o, setO] = useState<PngOpts>(() => fromSaved(snap?.pngExport ?? null));
  const [busy, setBusy] = useState(false);
  const appTheme = useAppliedTheme();
  const theme = o.style === "print" ? printTheme() : mapThemeFor(appTheme);
  const { data } = useResolved(plan, version, displayOf(o));
  const lid = levelId ?? orderedLevels(plan)[0]?.id ?? "";
  const list = data?.lists[lid] ?? null;
  const size = list ? pngSize(list, o.px) : null;
  const level = plan.levels.find((l) => l.id === lid);
  const nameFor = (id: string): string => {
    const l = plan.levels.find((x) => x.id === id);
    return `${snap?.name ?? "Map"} – ${levelShort(plan, id)} ${l?.name ?? ""} – ${o.gm ? "GM" : "Player"}`;
  };
  const set = (p: Partial<PngOpts>): void => {
    const next = { ...o, ...p };
    setO(next);
    const saved = toSaved(next);
    // keep the local snapshot in step so reopening the popover shows the saved choice
    const cur = useProject.getState().snap;
    if (cur) useProject.setState({ snap: { ...cur, pngExport: saved } });
    call("project:setUiState", { pngExport: saved }).catch(() => undefined);
  };

  useEffect(() => {
    const cv = prev.current;
    if (!cv || !list) return;
    const w = cv.clientWidth;
    const vb = list.viewBox;
    const scale = w / vb.w;
    const h = Math.round(vb.h * scale);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLevel(ctx, list, theme, { scale, ox: -vb.x * scale, oy: -vb.y * scale, w, h });
  }, [list, theme]);

  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await resolveAsync(plan, version, displayOf(o));
      const ids = o.scope === "all" ? orderedLevels(plan).map((l) => l.id) : [lid];
      const files: Array<{ levelId: string; pngBase64: string }> = [];
      for (const id of ids) {
        const l = r.lists[id];
        if (l)
          files.push({
            levelId: id,
            pngBase64: await renderPng(l, theme, { pxPerCell: o.px, background: "theme" }),
          });
      }
      const res = await call("export:savePng", {
        suggestedName:
          o.scope === "all" ? `${snap?.name ?? "Map"} – ${o.gm ? "GM" : "Player"}` : nameFor(lid),
        files,
        options: {
          levels: o.scope === "all" ? "all" : [lid],
          pxPerCell: o.px,
          version,
          display: displayOf(o),
          mapThemeId: theme.id,
          keyPanel: false,
          background: "theme",
        },
      });
      if (res) {
        close();
        const lead =
          o.scope === "all"
            ? `Exported ${files.length} levels (${o.gm ? "GM" : "player-safe"}).`
            : `Exported ${levelShort(plan, lid)} ${level?.name ?? ""} (${o.gm ? "GM" : "player-safe"}).`;
        const p0 = res.paths[0];
        useApp.getState().toast(
          p0 !== undefined
            ? {
                lead,
                action: {
                  label: "Show in folder",
                  run: () => void runCall("project:revealInFolder", { path: p0 }, "Couldn't show the file."),
                },
              }
            : { lead },
        );
      }
    } catch (e) {
      useApp.getState().toast({
        lead: "Couldn't save the image.",
        body: `Choose another folder and try again. ${errorMessage(e)}`,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const big = size !== null && (size.width > 8000 || size.height > 8000);
  const sizeText = useMemo(
    () => (size ? `${size.width.toLocaleString()}×${size.height.toLocaleString()}` : "…"),
    [size],
  );

  return (
    <div ref={ref} className="popover pngpop" role="dialog" aria-label="Export PNG">
      <div className="pngpop__h">Export PNG</div>
      <div className="pp-row">
        <span>Levels</span>
        <Seg
          label="Levels"
          value={o.scope}
          options={[
            ["level", "This level"],
            ["all", "All levels"],
          ]}
          onChange={(scope) => {
            set({ scope });
          }}
        />
      </div>
      <div className="pp-row">
        <span>Version</span>
        <Seg
          label="Version"
          value={o.gm}
          options={[
            [true, "GM"],
            [false, "Player-safe"],
          ]}
          onChange={(gm) => {
            set({ gm });
          }}
        />
      </div>
      <div className="pp-row">
        <span>Style</span>
        <Seg
          label="Style"
          value={o.style}
          options={[
            ["print", "Print (light)"],
            ["screen", "As on screen"],
          ]}
          onChange={(style) => {
            set({ style });
          }}
        />
      </div>
      <div className="pp-row">
        <span>Size</span>
        <div className="pp-size">
          <select
            className="select"
            aria-label="Pixels per square"
            value={o.px}
            onChange={(e) => {
              set({ px: Number(e.target.value) as PngOpts["px"] });
            }}
          >
            {[50, 70, 100, 140].map((n) => (
              <option key={n} value={n}>
                {n} px per square
              </option>
            ))}
          </select>
          <span className="muted">{sizeText}</span>
        </div>
      </div>
      {big && (
        <p className="pngpop__warn">Very large image ({sizeText}). Some apps can't open images this big.</p>
      )}
      <div className="pp-checks">
        {(
          [
            ["grid", "Grid"],
            ["numbers", "Room numbers"],
            ["names", "Room names"],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              className="sr-only"
              checked={o[k]}
              onChange={(e) => {
                set({ [k]: e.target.checked });
              }}
            />
            <span className={`box${o[k] ? " box--on" : ""}`} aria-hidden="true">
              {o[k] && <Icon name="check" />}
            </span>
            {l}
          </label>
        ))}
      </div>
      <div className="pp-prev">
        <canvas ref={prev} className="pp-prev__cv" aria-label="Preview" role="img" />
        <span>
          Preview · {o.scope === "all" ? `${plan.levels.length} files, one per level` : `${nameFor(lid)}.png`}
        </span>
      </div>
      <div className="pp-f">
        <button className="btn btn--sm btn--ghost" onClick={close}>
          Cancel
        </button>
        <button className="btn btn--sm btn--primary" disabled={busy || !list} onClick={() => void run()}>
          {busy ? <span className="spinner" /> : null}
          Export…
        </button>
      </div>
    </div>
  );
}
