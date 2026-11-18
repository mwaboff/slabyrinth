/**
 * Interactive map canvas (UX §6, architecture §5.4): draws through render-canvas drawDisplayList, zoom/pan,
 * hover + click selection via core hitTest, selection bar, compare outlines, changed-room pulse, rulers,
 * coordinates. Keyboard: arrows pan, +/−/0/1 zoom (global), Tab cycles rooms, R/Enter references, E edits.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayList, HitTarget, PlanDiff, ResolvedLevel } from "@slabyrinth/core";
import { Icon } from "../ui/Icon";
import { useMap, emptySel, PX_PER_CELL, MIN_ZOOM, MAX_ZOOM, type Sel } from "../stores/map";
import { useChat } from "../stores/chat";
import { cssVar, useAppliedTheme } from "../app/theme";
import { colLetters, ftSize } from "../lib/format";
import {
  drawLevel,
  drawOverlay,
  drawSelectedBadges,
  hitAt,
  mapThemeFor,
  overlayItems,
  splitLabels,
  toCell,
  type View,
} from "./render";
import type { Resolved } from "./resolveClient";
import { roomA11yLabel, roomExits } from "./exits";

export interface MapViewProps {
  data: Resolved;
  levelId: string;
  levelName: string;
  readOnly: boolean;
  compare: { diff: PlanDiff; old: Resolved | null } | null;
  levelShort: (id: string) => string;
}

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function selFromHit(h: HitTarget | null): Sel {
  const s = emptySel();
  if (!h) return s;
  if (h.kind === "area") s.areaIds = [h.id];
  else if (h.kind === "feature") s.featureIds = [h.id];
  else if (h.kind === "opening") s.openingIds = [h.id];
  else if (h.kind === "link") s.linkIds = [h.id];
  return s;
}

function mergeSel(a: Sel, b: Sel): Sel {
  const u = (x: string[], y: string[]): string[] => [...new Set([...x, ...y])];
  return {
    areaIds: u(a.areaIds, b.areaIds),
    featureIds: u(a.featureIds, b.featureIds),
    openingIds: u(a.openingIds, b.openingIds),
    linkIds: u(a.linkIds, b.linkIds),
  };
}

export function referenceSelection(level: ResolvedLevel, sel: Sel): void {
  const chat = useChat.getState();
  for (const id of sel.areaIds) {
    const a = level.areas.find((x) => x.id === id);
    if (a)
      chat.addRef({
        type: "room",
        id,
        levelId: level.id,
        label: a.name ?? `Room ${a.key ?? ""}`,
        ...(a.key !== undefined ? { key: a.key } : {}),
      });
  }
  for (const id of sel.featureIds) {
    const f = level.features.find((x) => x.id === id);
    const inA = f?.area !== undefined ? level.areas.find((x) => x.id === f.area) : undefined;
    if (f)
      chat.addRef({
        type: "feature",
        id,
        levelId: level.id,
        label: `${f.label ?? f.type.replace(/_/g, " ")}${inA?.key !== undefined ? ` · ${inA.key}` : ""}`,
      });
  }
  for (const id of sel.openingIds)
    chat.addRef({
      type: "opening",
      id,
      levelId: level.id,
      label: level.openings.find((o) => o.id === id)?.kind.replace(/_/g, " ") ?? "Opening",
    });
  chat.focusComposer();
}

/** Draw-effect runs (dev counter used by tests to prove chat streaming does not redraw the map). */
export const mapDrawStats = { runs: 0 };

export const MapView = memo(function MapView({
  data,
  levelId,
  levelName,
  readOnly,
  compare,
  levelShort,
}: MapViewProps) {
  const appTheme = useAppliedTheme();
  const theme = useMemo(() => mapThemeFor(appTheme), [appTheme]);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const shadow = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const zoom = useMap((s) => s.zoom);
  const pan = useMap((s) => s.pan);
  const setView = useMap((s) => s.setView);
  const fitTick = useMap((s) => s.fitTick);
  const tool = useMap((s) => s.tool);
  const sel = useMap((s) => s.sel);
  const hover = useMap((s) => s.hover);
  const hoverCell = useMap((s) => s.hoverCell);
  const setHover = useMap((s) => s.setHover);
  const select = useMap((s) => s.select);
  const pulse = useMap((s) => s.pulse);
  const issues = useMap((s) => s.issues);
  const issuesOpen = useMap((s) => s.issuesOpen);
  const editRoom = useMap((s) => s.editRoom);
  const [space, setSpace] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tick, setTick] = useState(0);
  const drag = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    panning: boolean;
    moved: boolean;
  } | null>(null);
  const hoverRaf = useRef<number | null>(null);

  const level = data.resolved.levels.find((l) => l.id === levelId) ?? null;
  const list: DisplayList | null = data.lists[levelId] ?? null;
  const scale = PX_PER_CELL * zoom;
  const view: View = { scale, ox: pan[0], oy: pan[1], w: size.w, h: size.h };

  // size
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
    };
  }, []);

  const fit = useCallback(() => {
    if (!level || size.w === 0) return;
    const b = level.bounds;
    const pad = 48;
    const z = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min((size.w - pad * 2) / (b.w * PX_PER_CELL), (size.h - pad * 2) / (b.h * PX_PER_CELL)),
      ),
    );
    const s = z * PX_PER_CELL;
    setView(z, [(size.w - b.w * s) / 2 - b.x * s, (size.h - b.h * s) / 2 - b.y * s]);
  }, [level, size.w, size.h, setView]);

  // fit on first show, on level change, on fit requests and when the level's bounds change
  const boundsKey = level
    ? `${level.id}:${level.bounds.x},${level.bounds.y},${level.bounds.w},${level.bounds.h}`
    : "";
  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, fitTick, size.w > 0]);

  const zoomAt = useCallback(
    (z: number, cx: number, cy: number) => {
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
      const s0 = PX_PER_CELL * zoom;
      const s1 = PX_PER_CELL * nz;
      const [gx, gy] = [(cx - pan[0]) / s0, (cy - pan[1]) / s0];
      setView(nz, [cx - gx * s1, cy - gy * s1]);
    },
    [zoom, pan, setView],
  );

  useEffect(() => {
    const onZoom = (e: Event): void => {
      zoomAt((e as CustomEvent<number>).detail, size.w / 2, size.h / 2);
    };
    const onFit = (): void => {
      fit();
    };
    const onReveal = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      const a = level?.areas.find((x) => x.id === id);
      if (!a) return;
      const cx = (a.bbox.x + a.bbox.w / 2) * scale + pan[0];
      const cy = (a.bbox.y + a.bbox.h / 2) * scale + pan[1];
      if (cx < 40 || cy < 40 || cx > size.w - 40 || cy > size.h - 40)
        setView(zoom, [pan[0] + size.w / 2 - cx, pan[1] + size.h / 2 - cy]);
    };
    window.addEventListener("slab:zoom", onZoom);
    window.addEventListener("slab:fit", onFit);
    const onRevealCell = (e: Event): void => {
      const [cx, cy] = (e as CustomEvent<[number, number]>).detail;
      setView(zoom, [size.w / 2 - (cx + 0.5) * scale, size.h / 2 - (cy + 0.5) * scale]);
    };
    window.addEventListener("slab:reveal", onReveal);
    window.addEventListener("slab:revealCell", onRevealCell);
    return () => {
      window.removeEventListener("slab:zoom", onZoom);
      window.removeEventListener("slab:fit", onFit);
      window.removeEventListener("slab:reveal", onReveal);
      window.removeEventListener("slab:revealCell", onRevealCell);
    };
  }, [zoomAt, fit, level, scale, pan, size, zoom, setView]);

  // space = temporary pan
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === "Space" && document.activeElement === wrap.current) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // pulse animation driver
  useEffect(() => {
    if (!pulse) return;
    const dur = reducedMotion() ? 2000 : 900;
    let raf = 0;
    const loop = (): void => {
      setTick((t) => t + 1);
      if (Date.now() - pulse.at < dur) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [pulse]);

  // draw — only when something drawn changes (never per streamed chat token)
  useEffect(() => {
    mapDrawStats.runs++;
    const cv = canvas.current;
    if (!cv || !list || !level || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    // labels go last (after selection, compare outlines and plan-check markers) so they stay readable
    const parts = splitLabels(list);
    drawLevel(ctx, parts.base, theme, view);
    drawOverlay(
      ctx,
      list,
      overlayItems(level, data.resolved.links, sel, readOnly ? null : hover),
      theme,
      view,
    );

    // compare outlines (UX §2.3): added solid + NEW, changed dashed + Δ, removed ghosted + ✕
    if (compare) {
      const tag = (x: number, y: number, text: string, color: string): void => {
        ctx.font = `600 11px ${theme.fontFamily}`;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y - 16, w, 16, 3);
        ctx.fill();
        ctx.fillStyle = theme.colors["label"] ?? "transparent";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + 5, y - 8);
      };
      const outline = (
        rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
        color: string,
        dash: number[],
        fill: string | null,
      ): void => {
        ctx.beginPath();
        for (const r of rings)
          r.forEach(([x, y], i) => {
            if (i === 0) ctx.moveTo(view.ox + x * scale, view.oy + y * scale);
            else ctx.lineTo(view.ox + x * scale, view.oy + y * scale);
          });
        ctx.closePath();
        if (fill !== null) {
          ctx.fillStyle = fill;
          ctx.globalAlpha = 0.22;
          ctx.fill("evenodd");
          ctx.globalAlpha = 1;
        }
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      const cNew = cssVar("--map-new");
      const cChg = theme.colors["accent"] ?? cNew;
      const cDel = cssVar("--map-removed");
      for (const a of level.areas) {
        if (compare.diff.areas.added.includes(a.id)) {
          outline(a.outline, cNew, [], null);
          tag(view.ox + a.bbox.x * scale + 4, view.oy + a.bbox.y * scale + 2, "NEW", cNew);
        } else if (compare.diff.areas.changed.includes(a.id)) {
          outline(a.outline, cChg, [8, 4], null);
          tag(view.ox + a.bbox.x * scale + 4, view.oy + a.bbox.y * scale + 2, "Δ changed", cChg);
        }
      }
      const oldLevel = compare.old?.resolved.levels.find((l) => l.id === levelId);
      for (const a of oldLevel?.areas ?? []) {
        if (!compare.diff.areas.removed.includes(a.id)) continue;
        outline(a.outline, cDel, [4, 4], cDel);
        tag(view.ox + a.bbox.x * scale + 4, view.oy + a.bbox.y * scale + 2, "✕ removed", cDel);
      }
    }

    // changed rooms pulse once (300 ms); reduced motion: a static outline for 2 s
    if (pulse) {
      const t = Date.now() - pulse.at;
      const rm = reducedMotion();
      const alpha = rm
        ? t < 2000
          ? 1
          : 0
        : t < 900
          ? Math.sin((Math.min(t, 300) / 300) * Math.PI) * (t < 300 ? 1 : 0) +
            (t >= 300 ? Math.max(0, 1 - (t - 300) / 600) * 0.6 : 0)
          : 0;
      if (alpha > 0) {
        ctx.save();
        ctx.globalAlpha = alpha;
        for (const a of level.areas) {
          if (!pulse.ids.includes(a.id)) continue;
          ctx.beginPath();
          for (const r of a.outline)
            r.forEach(([x, y], i) => {
              if (i === 0) ctx.moveTo(view.ox + x * scale, view.oy + y * scale);
              else ctx.lineTo(view.ox + x * scale, view.oy + y * scale);
            });
          ctx.closePath();
          ctx.strokeStyle = theme.colors["accent"] ?? "transparent";
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // plan-check markers: shape + glyph, not colour alone (error = solid triangle, warning = outlined triangle,
    // note = circled i, notes only while the Issues list is open)
    if (!readOnly) {
      for (const is of issues) {
        if (is.levelId !== levelId || !is.cell) continue;
        if (is.severity === "info" && !issuesOpen) continue;
        const x = view.ox + (is.cell[0] + 0.5) * scale;
        const y = view.oy + (is.cell[1] + 0.5) * scale;
        const r = Math.max(7, Math.min(11, scale * 0.38));
        const col = cssVar(
          is.severity === "error" ? "--danger-fill" : is.severity === "warning" ? "--warning" : "--info",
        );
        ctx.save();
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (is.severity === "info") ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
        else {
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r * 1.05, y + r * 0.8);
          ctx.lineTo(x - r * 1.05, y + r * 0.8);
          ctx.closePath();
        }
        ctx.fillStyle = is.severity === "error" ? col : cssVar("--surface");
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.font = `700 ${Math.round(r * 1.1)}px ${theme.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = is.severity === "error" ? cssVar("--surface") : col;
        ctx.fillText(is.severity === "info" ? "i" : "!", x, y + (is.severity === "info" ? 0 : r * 0.12));
        ctx.restore();
      }
    }

    drawLevel(ctx, parts.labels, theme, view);
    drawSelectedBadges(ctx, list, sel.areaIds, theme, view, cssVar("--accent-fill"), cssVar("--on-accent"));

    // rulers (zoom ≥ 75%): column letters and row numbers along the level's top and left edges
    if (zoom >= 0.75) {
      const b = level.bounds;
      ctx.save();
      ctx.font = `500 10px ${theme.fontFamily}`;
      ctx.fillStyle = cssVar("--muted");
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const every = scale < 22 ? 2 : 1;
      for (let i = 0; i < b.w; i += every)
        ctx.fillText(colLetters(i), view.ox + (b.x + i + 0.5) * scale, view.oy + b.y * scale - 4);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let j = 0; j < b.h; j += every)
        ctx.fillText(String(j + 1), view.ox + b.x * scale - 5, view.oy + (b.y + j + 0.5) * scale);
      ctx.restore();
    }

    // shadow plate under the map bounds
    const sh = shadow.current;
    if (sh) {
      const b = level.bounds;
      sh.style.transform = `translate(${view.ox + b.x * scale}px, ${view.oy + b.y * scale}px)`;
      sh.style.width = `${b.w * scale}px`;
      sh.style.height = `${b.h * scale}px`;
    }
    // view is derived from zoom/pan/size, all listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    list,
    level,
    size.w,
    size.h,
    theme,
    zoom,
    pan,
    sel,
    hover,
    readOnly,
    compare,
    pulse,
    tick,
    issues,
    issuesOpen,
    levelId,
    data.resolved.links,
  ]);

  // pointer handling
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const panning = tool === "pan" || space || e.button === 1;
    drag.current = { x: e.clientX, y: e.clientY, ox: pan[0], oy: pan[1], panning, moved: false };
    if (panning) {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    }
  };
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrap.current?.getBoundingClientRect();
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)];
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.panning) {
        setView(zoom, [d.ox + dx, d.oy + dy]);
        return;
      }
    }
    if (!level) return;
    const [px, py] = local(e);
    if (hoverRaf.current !== null) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = null;
      const h = hitAt(level, data.resolved.links, view, px, py);
      const [cx, cy] = toCell(view, px, py);
      setHover(h, h ? [Math.floor(cx), Math.floor(cy)] : null);
    });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || d.panning || d.moved || !level) return;
    const [px, py] = local(e);
    const h = hitAt(level, data.resolved.links, view, px, py);
    const s = selFromHit(h);
    if (h?.kind === "cell" || h === null) {
      select(emptySel());
      return;
    }
    select(e.shiftKey ? mergeSel(sel, s) : s);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!level) return;
    const [px, py] = local(e);
    const h = hitAt(level, data.resolved.links, view, px, py);
    if (h?.kind === "link") {
      const l = data.resolved.links.find((x) => x.id === h.id);
      const other = l ? (l.fromLevel === levelId ? l.toLevel : l.fromLevel) : null;
      if (other !== null) useMap.getState().setLevel(other);
      return;
    }
    const s = selFromHit(h);
    if (s.areaIds.length + s.featureIds.length > 0) {
      select(s);
      referenceSelection(level, s);
    }
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const [px, py] = local(e);
    if (e.ctrlKey || (e.deltaX === 0 && !e.shiftKey)) {
      zoomAt(zoom * Math.pow(1.0015, -e.deltaY), px, py);
    } else if (e.shiftKey) {
      setView(zoom, [pan[0] - e.deltaY, pan[1]]);
    } else {
      setView(zoom, [pan[0] - e.deltaX, pan[1] - e.deltaY]);
    }
  };

  const rooms = useMemo(
    () =>
      level
        ? level.areas
            .filter((a) => a.key !== undefined)
            .sort((a, b) => Number(a.key) - Number(b.key) || (a.key ?? "").localeCompare(b.key ?? ""))
        : [],
    [level],
  );
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!level) return;
    const step = 2 * scale;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
      const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
      setView(zoom, [pan[0] + dx, pan[1] + dy]);
    } else if (e.key === "Tab" && rooms.length > 0 && sel.areaIds.length > 0) {
      e.preventDefault();
      const i = rooms.findIndex((r) => r.id === sel.areaIds[0]);
      const next = rooms[(i + (e.shiftKey ? rooms.length - 1 : 1)) % rooms.length];
      if (next) {
        select({ ...emptySel(), areaIds: [next.id] });
        window.dispatchEvent(new CustomEvent("slab:reveal", { detail: next.id }));
      }
    } else if (e.key === "Escape") {
      select(emptySel());
    } else if (
      (e.key === "r" || e.key === "R" || e.key === "Enter") &&
      (sel.areaIds.length > 0 || sel.featureIds.length > 0)
    ) {
      e.preventDefault();
      referenceSelection(level, sel);
    } else if ((e.key === "e" || e.key === "E") && sel.areaIds[0] !== undefined && !readOnly) {
      e.preventDefault();
      editRoom(sel.areaIds[0]);
    } else if (e.key === "Home" && rooms[0]) {
      select({ ...emptySel(), areaIds: [rooms[0].id] });
    }
  };

  // selection bar position
  const selArea = level?.areas.find((a) => a.id === sel.areaIds[0]);
  const selFeature = level?.features.find((f) => f.id === sel.featureIds[0]);
  const anchor = selArea
    ? { x: selArea.bbox.x + selArea.bbox.w / 2, y: selArea.bbox.y }
    : selFeature
      ? { x: selFeature.at[0] + selFeature.size[0] / 2, y: selFeature.at[1] }
      : null;
  const barLeft = anchor ? Math.max(170, Math.min(size.w - 170, view.ox + anchor.x * scale)) : 0;
  const barTop = anchor ? Math.max(52, view.oy + anchor.y * scale - 10) : 0;
  const inArea =
    selFeature?.area !== undefined ? level?.areas.find((a) => a.id === selFeature.area) : undefined;

  const coords = (() => {
    if (!level || !hoverCell) return null;
    const lx = hoverCell[0] - level.bounds.x;
    const ly = hoverCell[1] - level.bounds.y;
    if (lx < 0 || ly < 0 || lx >= level.bounds.w || ly >= level.bounds.h) return null;
    return `${colLetters(lx)}${ly + 1} · ${lx * 5} ft E, ${ly * 5} ft S`;
  })();

  const announce = selArea
    ? roomA11yLabel(
        selArea.key,
        selArea.name,
        selArea.bbox.w * 5,
        selArea.bbox.h * 5,
        roomExits(level as ResolvedLevel, data.resolved.links, selArea.id),
      )
    : "";
  const cursor =
    tool === "pan" || space
      ? dragging
        ? "grabbing"
        : "grab"
      : hover &&
          (hover.kind === "area" ||
            hover.kind === "feature" ||
            hover.kind === "link" ||
            hover.kind === "opening")
        ? "pointer"
        : "default";

  return (
    <div className="canvas">
      <div
        ref={wrap}
        className="canvas__surface"
        role="application"
        aria-roledescription="map"
        aria-label={`Map of ${levelShort(levelId)}, ${levelName}, ${rooms.length} rooms. Tab cycles rooms once one is selected; R references it in chat.`}
        tabIndex={0}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          setHover(null, null);
        }}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <div ref={shadow} className="canvas__plate" aria-hidden="true" />
        <canvas ref={canvas} className="canvas__el" aria-hidden="true" />
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      {anchor && (selArea || selFeature) && !readOnly && (
        <div className="selbar" role="toolbar" aria-label="Selection" style={{ left: barLeft, top: barTop }}>
          <span className="selbar__t">
            {selArea ? (
              <>
                {selArea.key !== undefined && <span className="badge badge--solid">{selArea.key}</span>}
                {selArea.name ?? "Unnamed area"}
              </>
            ) : (
              <>
                {selFeature?.label ?? selFeature?.type.replace(/_/g, " ")}
                {inArea?.key !== undefined && <span className="muted"> · in {inArea.key}</span>}
              </>
            )}
          </span>
          <button
            className="btn btn--sm"
            onClick={() => {
              if (level) referenceSelection(level, sel);
            }}
          >
            <Icon name="at" size="sm" />
            Reference in chat <span className="kbd">R</span>
          </button>
          {selArea && (
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                editRoom(selArea.id);
              }}
            >
              <Icon name="edit" size="sm" />
              Edit notes
            </button>
          )}
          <button
            className="iconbtn iconbtn--sm"
            aria-label="Clear selection (Esc)"
            title="Clear selection (Esc)"
            onClick={() => {
              select(emptySel());
            }}
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      )}
      <div className="compass" aria-hidden="true">
        <Icon name="up" size="sm" />N
      </div>
      {coords !== null && <div className="coords">{coords}</div>}
      {hover?.kind === "area" &&
        !sel.areaIds.includes(hover.id) &&
        (() => {
          const a = level?.areas.find((x) => x.id === hover.id);
          if (!a || a.key === undefined) return null;
          return (
            <div className="maptip" role="tooltip">
              <span className="badge">{a.key}</span> {a.name} · {ftSize(a.bbox.w, a.bbox.h)}
            </div>
          );
        })()}
    </div>
  );
});
