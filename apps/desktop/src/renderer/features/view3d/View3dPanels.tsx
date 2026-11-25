/**
 * The 3D tab's pieces around the canvas: the colour key (which doubles as a filter by kind of piece), the clicked
 * piece's card, the first-use hint, the Controls card, the on-canvas move buttons and the cut height. Each reads the
 * tab's choices from the view3d store; none draws or owns the camera.
 */
import { useRef, type ReactNode, type RefObject } from "react";
import type { MapPlan } from "@slabyrinth/core";
import type { ColourClass } from "@slabyrinth/scene3d";
import { cellName } from "../../lib/format";
import { useApp } from "../../stores/app";
import { useChat, type ComposerRef } from "../../stores/chat";
import { useMap } from "../../stores/map";
import { levelShort } from "../../stores/project";
import { useView3d } from "../../stores/view3d";
import { useDismiss } from "../../ui/dismiss";
import { Icon, type IconName } from "../../ui/Icon";
import { showIssue } from "../stage/Issues";
import { HINT_MOVES, KEY_CONTROLS, MOUSE_CONTROLS, type ControlRow } from "./controls";
import { classColourCss, type PickInfo, type View3dApi } from "./engine/engine";
import type { SceneHeader } from "./sceneSource";

const css = (rgb: readonly number[]): string => `rgb(${rgb.join(", ")})`;

// ───────────── what a plan element is ─────────────

/** A plan element's name as the map and the room key show it, and the chat chip that points at it (when there is one). */
export function elementOf(plan: MapPlan, id: string): { label: string; ref: ComposerRef | null } | null {
  for (const l of plan.levels) {
    const a = l.areas.find((x) => x.id === id);
    if (a) {
      const label = a.name ?? (a.key !== undefined ? `Room ${a.key}` : "Unnamed area");
      return {
        label,
        ref: { type: "room", id, levelId: l.id, label, ...(a.key !== undefined ? { key: a.key } : {}) },
      };
    }
    const f = l.features.find((x) => x.id === id);
    if (f) {
      const label = f.label ?? f.type.replace(/_/g, " ");
      return { label, ref: { type: "feature", id, levelId: l.id, label } };
    }
    const o = l.openings.find((x) => x.id === id);
    if (o) {
      const label = o.label ?? o.kind.replace(/_/g, " ");
      return { label, ref: { type: "opening", id, levelId: l.id, label } };
    }
    const s = (l.structures ?? []).find((x) => x.id === id);
    if (s) {
      const what = s.kind === "enclosure" ? "Enclosure" : "Building";
      return { label: s.name ?? (s.key !== undefined ? `${what} ${s.key}` : what), ref: null };
    }
  }
  const k = plan.links.find((x) => x.id === id);
  if (k) {
    const label = k.label ?? k.kind.replace(/_/g, " ");
    return { label, ref: { type: "link", id, levelId: k.from.level, label } };
  }
  return null;
}

/** "square H12" in the level's own ruler letters, when the piece came from a plan cell on a known level. */
function squareOf(plan: MapPlan, p: PickInfo): string | null {
  const l = plan.levels.find((x) => x.id === p.levelId);
  if (!p.cell || !l) return null;
  return `square ${cellName(p.cell[0] - l.bounds.x, p.cell[1] - l.bounds.y)}`;
}

// ───────────── the clicked piece ─────────────

/** A piece's catalog name as words: "cherryblossom_flowers_01" → "Cherryblossom flowers"; "Stone Wall" stays. */
export function pieceName(raw: string): string {
  if (!raw.includes("_")) return raw;
  const words = raw
    .replace(/_+/g, " ")
    .replace(/\s+\d+$/, "")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the clicked piece is (its kind, name, level, plan element, square), with Show on map and Mention in chat. */
export function Readout({
  plan,
  pick,
  allBoxes,
  onClear,
}: {
  plan: MapPlan;
  pick: PickInfo;
  /** Every piece is a box (no TaleSpire, 3D pieces off): then "shown as a box" says nothing new. */
  allBoxes: boolean;
  onClear: () => void;
}) {
  // the kind as the colour key names it (the swatch beside it is the same colour)
  const what = pick.classLabel;
  const name = pieceName(pick.name);
  const el = pick.elementId !== null ? elementOf(plan, pick.elementId) : null;
  const square = squareOf(plan, pick);
  const short = levelShort(plan, pick.levelId);
  const where = [`${short} ${pick.levelName}`, el?.label, square].filter(Boolean).join(" · ");
  const onMap = plan.levels.some((l) => l.id === pick.levelId);
  const mention = (): void => {
    const chat = useChat.getState();
    if (el?.ref) chat.addRef(el.ref);
    else {
      const text = `the ${what.toLowerCase()} at ${short}${square !== null ? ` ${square}` : ""}`;
      chat.setDraft(chat.draft.trim() === "" ? `${text}: ` : `${chat.draft.trimEnd()} ${text} `);
    }
    useApp.getState().toggleChat(true);
    chat.focusComposer();
  };
  return (
    <section className="v3sel" aria-label="Selected piece">
      <div className="v3sel__h">
        <i className="v3sw" aria-hidden="true" style={{ background: classColourCss(pick.colourClass) }} />
        <b>{what}</b>
        <button
          className="iconbtn iconbtn--xs v3sel__x"
          aria-label="Clear (Esc)"
          title="Clear (Esc)"
          onClick={onClear}
        >
          <Icon name="x" size="sm" />
        </button>
      </div>
      {name !== "" && name.toLowerCase() !== what.toLowerCase() && <p className="v3sel__name">{name}</p>}
      <p className="v3sel__where">{where}</p>
      {pick.stand === "box" && !allBoxes && (
        <p className="v3sel__note">Shown as a box of its real size until its 3D piece is read.</p>
      )}
      <div className="v3sel__actions">
        {onMap && (
          <button
            className="btn btn--sm"
            onClick={() => {
              showIssue(plan, {
                message: "",
                levelId: pick.levelId,
                ...(pick.elementId !== null ? { elementId: pick.elementId } : {}),
                ...(pick.cell ? { cell: pick.cell } : {}),
              });
            }}
          >
            Show on map
          </button>
        )}
        <button className="btn btn--sm" onClick={mention}>
          <Icon name="at" size="sm" />
          Mention in chat
        </button>
      </div>
    </section>
  );
}

// ───────────── colour key ─────────────

/**
 * The colour key: each kind of piece on this map with its colour, as a checkbox that shows or hides it. Roof drives
 * the same switch as the toolbar's Roofs button (roofs are a paste layer as well as a colour).
 */
export function ColourKey({
  header,
  seen,
  disabled,
}: {
  header: SceneHeader | null;
  /** Bit i: header class i is on this map. */
  seen: number;
  disabled: boolean;
}) {
  const hidden = useView3d((s) => s.hiddenClasses);
  const toggle = useView3d((s) => s.toggleClass);
  const showAll = useView3d((s) => s.showAllClasses);
  const roofsHidden = useView3d((s) => s.roofsHidden);
  const setRoofs = useView3d((s) => s.setRoofsHidden);
  const toggleKey = useMap((s) => s.toggleKey);
  const rows = (header?.classes ?? []).filter((_, i) => (seen >>> i) & 1);
  const anyHidden = roofsHidden || rows.some((c) => hidden.includes(c.id as ColourClass));
  return (
    <aside className="key v3key" aria-label="Colour key">
      <div className="key__h">
        <h3>Colour key</h3>
        <button
          className="iconbtn iconbtn--sm"
          aria-label="Collapse colour key (Ctrl+])"
          title="Collapse colour key (Ctrl+])"
          onClick={() => {
            toggleKey(false);
          }}
        >
          <Icon name="right" />
        </button>
      </div>
      <p className="v3key__lead">Untick a kind of piece to hide it.</p>
      {rows.length === 0 ? (
        <p className="v3key__lead muted">The kinds of piece appear here once the map is laid out.</p>
      ) : (
        <ul className="v3key__list">
          {rows.map((c) => {
            const roof = c.id === "roof";
            const on = roof ? !roofsHidden : !hidden.includes(c.id as ColourClass);
            return (
              <li key={c.id}>
                <label className={`v3key__item${on ? "" : " v3key__item--off"}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    disabled={disabled}
                    onChange={() => {
                      if (roof) setRoofs(on);
                      else toggle(c.id as ColourClass);
                    }}
                  />
                  <span className={`box${on ? " box--on" : ""}`} aria-hidden="true">
                    {on && <Icon name="check" />}
                  </span>
                  <i className="v3sw" style={{ background: css(c.rgb) }} aria-hidden="true" />
                  <span className="v3key__label">{c.label}</span>
                  {!on && <span className="v3key__state">hidden</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="v3key__foot">
        {anyHidden && (
          <button
            className="btn btn--sm"
            disabled={disabled}
            onClick={() => {
              showAll();
              setRoofs(false);
            }}
          >
            <Icon name="eye" size="sm" />
            Show every kind
          </button>
        )}
        {header && (
          <span className="muted">
            {header.counts.instances.toLocaleString()} piece{header.counts.instances === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </aside>
  );
}

// ───────────── first-use hint and the Controls card ─────────────

function ControlTable({ rows, caption }: { rows: readonly ControlRow[]; caption: string }) {
  return (
    <table className="v3keys">
      <caption className="eyebrow">{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.keys}>
            <th scope="row">
              <span className="kbd">{r.keys}</span>
            </th>
            <td>{r.does}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Once per session, over the canvas: what this is and how to move. "Got it" dismisses it until the app restarts. */
export function HintCard({ version, hasKey }: { version: number; hasKey: boolean }) {
  const dismiss = useView3d((s) => s.dismissHint);
  const setHelp = useView3d((s) => s.setHelpOpen);
  return (
    <section className="v3hint" aria-label="About the 3D view">
      <h3 className="v3hint__t">This is what TaleSpire will get</h3>
      <p>
        Every piece of v{version}, in plain colours by kind
        {hasKey ? " (the colour key on the right says which is which)" : ""}. To look inside, pick a level tab
        above or hide the roofs.
      </p>
      <ul className="v3hint__moves">
        {HINT_MOVES.map(([what, does]) => (
          <li key={what}>
            <b>{what}</b> {does}
          </li>
        ))}
      </ul>
      <div className="v3hint__actions">
        <button className="btn btn--sm" onClick={dismiss}>
          Got it
        </button>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            dismiss();
            setHelp(true);
          }}
        >
          Keyboard controls
        </button>
      </div>
    </section>
  );
}

/** The toolbar's "Controls" button and its card: every mouse move and key, from the one table. */
export function ControlsButton() {
  const open = useView3d((s) => s.helpOpen);
  const setOpen = useView3d((s) => s.setHelpOpen);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, card],
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
        aria-haspopup="dialog"
        aria-expanded={open}
        title="How to move in 3D"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="help" />
        Controls
      </button>
      {open && (
        <div ref={card} className="popover v3help" role="dialog" aria-label="3D controls">
          <ControlTable rows={MOUSE_CONTROLS} caption="Mouse" />
          <ControlTable rows={KEY_CONTROLS} caption="Keys (click the view first)" />
        </div>
      )}
    </span>
  );
}

// ───────────── on-canvas move buttons ─────────────

const TURN_DEG = 15;
const ZOOM_STEP = 1.25;

/** Zoom and turn without dragging or keys (trackpads, one-handed use). */
export function NavCluster({ api, disabled }: { api: RefObject<View3dApi | null>; disabled: boolean }) {
  const b = (label: string, icon: IconName, run: (a: View3dApi) => void): ReactNode => (
    <button
      className="iconbtn iconbtn--sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        if (api.current) run(api.current);
      }}
    >
      <Icon name={icon} />
    </button>
  );
  return (
    <div className="v3nav" role="group" aria-label="Move the view">
      {b("Zoom in (+)", "plus", (a) => {
        a.zoom(1 / ZOOM_STEP);
      })}
      {b("Zoom out (−)", "minus", (a) => {
        a.zoom(ZOOM_STEP);
      })}
      <span className="v3nav__sep" aria-hidden="true" />
      {b("Turn left (←)", "turnLeft", (a) => {
        a.orbit(-TURN_DEG, 0);
      })}
      {b("Turn right (→)", "turnRight", (a) => {
        a.orbit(TURN_DEG, 0);
      })}
    </div>
  );
}

// ───────────── cut height ─────────────

/**
 * "Cut height": hides what stands above a height on the level being looked at, to see into the lower storey of a
 * building. Offered only when that level is taller than a storey and its roof (6 tiles): a dungeon or a street of
 * one-storey cottages has nothing hiding a lower storey once the roofs are off.
 */
export function cutRange(
  header: SceneHeader | null,
  levelIndex: number | null,
): { floor: number; top: number } | null {
  if (!header || header.levels.length === 0) return null;
  const lv = header.levels[levelIndex ?? header.levels.length - 1];
  const b = lv?.bounds;
  if (!b) return null;
  const floor = Math.floor(b.min[1] * 2) / 2;
  const top = Math.ceil(b.max[1] * 2) / 2;
  return top - floor >= 6 ? { floor, top } : null;
}

export function CutHeight({ range, disabled }: { range: { floor: number; top: number }; disabled: boolean }) {
  const cut = useView3d((s) => s.cutHeight);
  const setCut = useView3d((s) => s.setCutHeight);
  const value = cut === null ? range.top : Math.min(range.top, Math.max(range.floor + 1, cut));
  const off = cut === null || value >= range.top;
  const words = off ? "Off" : `${String(Math.round((value - range.floor) * 5))} ft up`;
  return (
    <label className="v3cut" title="Hide what stands above a height, to see into the lower storeys">
      <span>Cut height</span>
      <input
        type="range"
        className="v3cut__range"
        min={range.floor + 1}
        max={range.top}
        step={0.5}
        value={value}
        disabled={disabled}
        aria-valuetext={off ? "Off" : words}
        onChange={(e) => {
          const v = Number(e.target.value);
          setCut(v >= range.top ? null : v);
        }}
      />
      <output className="v3cut__val">{words}</output>
    </label>
  );
}
