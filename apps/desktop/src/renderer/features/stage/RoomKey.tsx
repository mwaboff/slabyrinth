/** Room key (UX §6.8): filterable list of the level's rooms; the selected room expands with read-aloud, GM notes, encounter, exits; text edits create versions. Legend footer (§6.3). */
import { useEffect, useMemo, useRef, useState } from "react";
import { GAME_SYSTEM_LABEL, GAME_SYSTEM_NAMED, isRoomArea, type GameSystemId } from "@slabyrinth/core";
import type { Area, DisplayList, MapPlan, ResolvedLevel, ResolvedLink } from "@slabyrinth/core";
import { Icon } from "../../ui/Icon";
import { emptySel, useMap } from "../../stores/map";
import { useProject } from "../../stores/project";
import { useChat } from "../../stores/chat";
import { ftSize } from "../../lib/format";
import { editRoomText, copyRoomKey } from "../../app/actions";
import { roomExits } from "../../map/exits";
import { drawSwatch, legendFor, mapThemeFor } from "../../map/render";
import { useAppliedTheme } from "../../app/theme";
import { RoomRef, withRefs } from "../chat/RichText";

/** The system named after "Encounter": core's label, none for a system whose name is the GM's own. */
const systemLabel = (id: GameSystemId): string | undefined =>
  GAME_SYSTEM_NAMED[id] ? GAME_SYSTEM_LABEL[id] : undefined;

export interface RoomEditFields {
  name: string;
  readAloud: string;
  notes: string;
  encounter: string;
}

/** Only changed fields; "" clears an optional field (null), names are never cleared. */
export function changedFields(
  area: Pick<Area, "name" | "readAloud" | "notes" | "encounter">,
  f: RoomEditFields,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const norm = (v: string | undefined): string => v ?? "";
  if (f.name.trim() !== norm(area.name) && f.name.trim() !== "") out["name"] = f.name.trim();
  for (const k of ["readAloud", "notes", "encounter"] as const) {
    const v = f[k].trim();
    if (v !== norm(area[k])) out[k] = v === "" ? null : v;
  }
  return out;
}

export function RoomEditor({ area, onDone }: { area: Area; onDone: () => void }) {
  const [f, setF] = useState<RoomEditFields>({
    name: area.name ?? "",
    readAloud: area.readAloud ?? "",
    notes: area.notes ?? "",
    encounter: area.encounter ?? "",
  });
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const save = async (): Promise<void> => {
    const set = changedFields(area, f);
    if (Object.keys(set).length === 0) {
      onDone();
      return;
    }
    setSaving(true);
    const ok = await editRoomText(area.id, set);
    setSaving(false);
    if (ok) onDone();
  };
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
  };
  const field = (k: keyof RoomEditFields, label: string, rows: number) => (
    <label className="redit__f">
      <span className="eyebrow">{label}</span>
      <textarea
        className="textarea"
        rows={rows}
        value={f[k]}
        maxLength={k === "notes" ? 2000 : k === "readAloud" ? 1500 : 1000}
        onChange={(e) => {
          setF({ ...f, [k]: e.target.value });
        }}
      />
    </label>
  );
  return (
    <div className="redit" onKeyDown={onKey}>
      <label className="redit__f">
        <span className="eyebrow">Name</span>
        <input
          ref={first}
          className="input"
          value={f.name}
          maxLength={80}
          onChange={(e) => {
            setF({ ...f, name: e.target.value });
          }}
        />
      </label>
      {field("readAloud", "Read aloud", 3)}
      {field("notes", "GM notes", 5)}
      {field("encounter", "Encounter", 2)}
      <div className="redit__actions">
        <button className="btn btn--sm btn--primary" disabled={saving} onClick={() => void save()}>
          Save <span className="kbd">Ctrl Enter</span>
        </button>
        <button className="btn btn--sm btn--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Legend({ list }: { list: DisplayList }) {
  const open = useMap((s) => s.legendOpen);
  const setOpen = useMap((s) => s.setLegend);
  const appTheme = useAppliedTheme();
  const theme = useMemo(() => mapThemeFor(appTheme), [appTheme]);
  const entries = useMemo(() => legendFor(list).slice(0, 12), [list]);
  const refs = useRef<Array<HTMLCanvasElement | null>>([]);
  useEffect(() => {
    if (!open) return;
    entries.forEach((e, i) => {
      const c = refs.current[i];
      if (c) drawSwatch(c, e, theme);
    });
  }, [entries, theme, open]);
  return (
    <div className="legend">
      <div className="legend__h">
        <span className="eyebrow">Legend · this level</span>
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => void copyRoomKey()}
          title="Copy the room key as Markdown"
        >
          <Icon name="copy" size="sm" />
          Copy key
        </button>
        <button
          className="iconbtn iconbtn--xs"
          aria-label={open ? "Collapse legend (L)" : "Expand legend (L)"}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <Icon name={open ? "down" : "up"} size="sm" />
        </button>
      </div>
      {open && (
        <ul className="legend__grid">
          {entries.map((e, i) => (
            <li key={e.id}>
              <canvas
                ref={(el) => {
                  refs.current[i] = el;
                }}
                className="legend__sw"
                aria-hidden="true"
              />
              {e.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoomKey({
  level,
  links,
  list,
  plan,
  readOnly,
  short,
}: {
  level: ResolvedLevel;
  links: readonly ResolvedLink[];
  list: DisplayList;
  plan: MapPlan;
  readOnly: boolean;
  short: string;
}) {
  const sel = useMap((s) => s.sel);
  const select = useMap((s) => s.select);
  const filter = useMap((s) => s.keyFilter);
  const setFilter = useMap((s) => s.setKeyFilter);
  const editId = useMap((s) => s.editRoomId);
  const editRoom = useMap((s) => s.editRoom);
  const toggleKey = useMap((s) => s.toggleKey);
  const system = useProject((s) => s.snap?.brief.system?.value ?? null);
  const addRef = useChat((s) => s.addRef);
  const focusComposer = useChat((s) => s.focusComposer);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const planLevel = plan.levels.find((l) => l.id === level.id);
  const areas = (planLevel?.areas ?? [])
    .filter(isRoomArea)
    .sort((a, b) => (Number(a.key) || 0) - (Number(b.key) || 0) || (a.key ?? "").localeCompare(b.key ?? ""));
  const q = filter.trim().toLowerCase();
  const shown =
    q === ""
      ? areas
      : areas.filter((a) =>
          [a.name, a.notes, a.readAloud, a.encounter, a.key].some((t) => (t ?? "").toLowerCase().includes(q)),
        );

  useEffect(() => {
    const f = (): void => search.current?.focus();
    window.addEventListener("slab:find", f);
    return () => {
      window.removeEventListener("slab:find", f);
    };
  }, []);
  useEffect(() => {
    const id = sel.areaIds[0];
    if (id === undefined) return;
    listRef.current?.querySelector(`[data-room="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel.areaIds]);

  return (
    <aside className="key" aria-label="Room key">
      <div className="key__h">
        <h3>
          Room key<small>{`${short} · ${areas.length} rooms`}</small>
        </h3>
        <button
          className="iconbtn iconbtn--sm"
          aria-label="Collapse room key (Ctrl+])"
          title="Collapse room key (Ctrl+])"
          onClick={() => {
            toggleKey(false);
          }}
        >
          <Icon name="right" />
        </button>
      </div>
      <label className="search key__search">
        <Icon name="search" size="sm" />
        <input
          ref={search}
          className="search__input"
          placeholder="Filter rooms and notes"
          aria-label="Filter rooms and notes"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setFilter("");
          }}
        />
        <span className="kbd">Ctrl F</span>
      </label>
      <div ref={listRef} className="rooms" role="list">
        {shown.length === 0 && (
          <p className="rooms__empty">{q === "" ? "No rooms on this level." : "No rooms match."}</p>
        )}
        {shown.map((a) => {
          const ra = level.areas.find((x) => x.id === a.id);
          const on = sel.areaIds.includes(a.id);
          const size = ra ? ftSize(ra.bbox.w, ra.bbox.h) : "";
          const exits = on ? roomExits(level, links, a.id) : [];
          return (
            <div key={a.id} data-room={a.id} role="listitem" className={`room${on ? " room--on" : ""}`}>
              <button
                className="room__head"
                aria-expanded={on}
                onClick={() => {
                  select(on ? emptySel() : { ...emptySel(), areaIds: [a.id] });
                  if (!on) window.dispatchEvent(new CustomEvent("slab:reveal", { detail: a.id }));
                }}
                onDoubleClick={() => {
                  addRef({
                    type: "room",
                    id: a.id,
                    levelId: level.id,
                    label: a.name ?? `Room ${a.key ?? ""}`,
                    ...(a.key !== undefined ? { key: a.key } : {}),
                  });
                  focusComposer();
                }}
              >
                <span className={`badge room__badge${on ? " badge--solid" : ""}`}>{a.key}</span>
                <span className="room__rn">
                  <span className="room__name">{a.name ?? "Unnamed"}</span>
                  <span className="room__size">{size}</span>
                </span>
                {!on && (
                  <span className="room__prev">
                    {(a.notes ?? a.readAloud ?? "No notes yet.").split("\n")[0]}
                  </span>
                )}
              </button>
              {on && editId === a.id && !readOnly && (
                <RoomEditor
                  area={a}
                  onDone={() => {
                    editRoom(null);
                  }}
                />
              )}
              {on && editId !== a.id && (
                <div className="room__body">
                  {a.readAloud !== undefined && (
                    <div className="rsec">
                      <span className="eyebrow">Read aloud</span>
                      <p className="rsec__ra">{a.readAloud}</p>
                    </div>
                  )}
                  <div className="rsec">
                    <span className="eyebrow">GM notes</span>
                    <p>
                      {a.notes !== undefined ? (
                        withRefs(a.notes, `n${a.id}`)
                      ) : (
                        <span className="muted">No notes yet. Press E to write some.</span>
                      )}
                    </p>
                  </div>
                  {a.encounter !== undefined && (
                    <div className="rsec">
                      <span className="eyebrow">
                        Encounter
                        {system !== null && systemLabel(system) !== undefined
                          ? ` · ${systemLabel(system) ?? ""}`
                          : ""}
                      </span>
                      <p>{withRefs(a.encounter, `e${a.id}`)}</p>
                    </div>
                  )}
                  {exits.length > 0 && (
                    <div className="rsec">
                      <span className="eyebrow">Exits</span>
                      <p className="rsec__exits">
                        {exits.map((x, i) => (
                          <span key={i} className="exit">
                            {x.side} {x.kind} →{" "}
                            {x.toKey !== null ? (
                              <RoomRef k={x.toKey} />
                            ) : x.levelJump !== undefined ? (
                              <button
                                className="btn btn--link"
                                onClick={() => {
                                  if (x.levelJump !== undefined) useMap.getState().setLevel(x.levelJump);
                                }}
                              >
                                {plan.levels.find((l) => l.id === x.levelJump)?.name ?? x.levelJump}
                              </button>
                            ) : (
                              (x.toName ?? "corridor")
                            )}
                          </span>
                        ))}
                      </p>
                    </div>
                  )}
                  <div className="room__actions">
                    {!readOnly && (
                      <button
                        className="btn btn--sm"
                        onClick={() => {
                          editRoom(a.id);
                        }}
                      >
                        <Icon name="edit" size="sm" />
                        Edit
                      </button>
                    )}
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => {
                        addRef({
                          type: "room",
                          id: a.id,
                          levelId: level.id,
                          label: a.name ?? `Room ${a.key ?? ""}`,
                          ...(a.key !== undefined ? { key: a.key } : {}),
                        });
                        focusComposer();
                      }}
                    >
                      <Icon name="at" size="sm" />
                      Reference
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Legend list={list} />
    </aside>
  );
}
