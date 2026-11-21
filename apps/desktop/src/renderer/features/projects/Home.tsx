/** Home (UX §8.9): greeting, Continue card, recent maps grid with search/sort and per-card menu; empty state. */
import { useEffect, useMemo, useRef, useState } from "react";
import "./home.css";
import "../chat/chat.css";
import { Icon, Mark } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { useApp } from "../../stores/app";
import { switchProject, useProject, type ProjectListEntry } from "../../stores/project";
import { newProject, openProject, run } from "../../app/actions";
import { call, errorMessage } from "../../bridge/client";
import { greeting, plural, relativeTime } from "../../lib/format";
import { STARTERS } from "../chat/starters";

/** Reloads the map list after a change; a failure is shown, not lost. */
const reloadList = (): Promise<void> =>
  useProject
    .getState()
    .loadList()
    .catch((e: unknown) => {
      useApp
        .getState()
        .toast({ lead: "Couldn't refresh the map list.", body: errorMessage(e), tone: "error" });
    });

function phaseChip(p: ProjectListEntry) {
  const label =
    p.phase === "brief"
      ? "Brief · no plan yet"
      : p.phase === "plan"
        ? "Plan · not approved"
        : "Approved · built";
  return <span className={`phase phase--${p.phase}`}>{label}</span>;
}

function Thumb({ p, big }: { p: ProjectListEntry; big?: boolean }) {
  if (p.thumbnailPng !== undefined)
    return (
      <img
        className={big === true ? "cont__thumb" : "pcard__thumb"}
        src={`data:image/png;base64,${p.thumbnailPng}`}
        alt=""
      />
    );
  return (
    <div className={`${big === true ? "cont__thumb" : "pcard__thumb"} thumb--empty`} aria-hidden="true">
      <Mark size={big === true ? 40 : 28} />
    </div>
  );
}

function CardMenu({ p, onRename }: { p: ProjectListEntry; onRename: () => void }) {
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
  const load = useProject((s) => s.loadList);
  const act = async (fn: () => Promise<unknown>, lead: string): Promise<void> => {
    setOpen(false);
    try {
      await fn();
      await load();
    } catch (e) {
      useApp.getState().toast({ lead, body: errorMessage(e), tone: "error" });
    }
  };
  return (
    <>
      <button
        ref={btn}
        className="iconbtn iconbtn--sm pcard__more"
        aria-label={`More actions for ${p.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menu} className="menu pcard__menu" role="menu">
          <button role="menuitem" className="menu__item" onClick={() => void openProject(p.path)}>
            Open
          </button>
          <button
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename <span className="menu__accel">F2</span>
          </button>
          <button
            role="menuitem"
            className="menu__item"
            onClick={() => void act(() => call("project:duplicate", { path: p.path }), "Couldn't duplicate.")}
          >
            Duplicate <span className="menu__accel">Ctrl+D</span>
          </button>
          <button
            role="menuitem"
            className="menu__item"
            onClick={() =>
              void act(() => call("project:revealInFolder", { path: p.path }), "Couldn't show the file.")
            }
          >
            Show in folder
          </button>
          <div className="menu__sep" />
          <button
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              confirmTrash(p);
            }}
          >
            Move to Recycle Bin <span className="menu__accel">Delete</span>
          </button>
        </div>
      )}
    </>
  );
}

function confirmTrash(p: ProjectListEntry): void {
  useApp.getState().askConfirm({
    title: `Move "${p.name}" to the Recycle Bin?`,
    body: "You can restore it from there.",
    confirm: "Move to Recycle Bin",
    danger: true,
    onConfirm: () => {
      void run("project:trash", { path: p.path }, "Couldn't move the map to the bin.", () => {
        void reloadList();
      });
    },
  });
}

function ProjectCard({ p }: { p: ProjectListEntry }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const doRename = async (): Promise<void> => {
    setRenaming(false);
    const clean = name.trim();
    if (clean === "" || clean === p.name) return;
    // Rename needs the project open (project:rename acts on the open project).
    try {
      await switchProject(async () => {
        await call("project:open", { path: p.path });
        await call("project:rename", { name: clean });
        await call("project:close", {});
      });
      await useProject.getState().loadList();
    } catch (e) {
      useApp.getState().toast({ lead: "Couldn't rename.", body: errorMessage(e), tone: "error" });
    }
  };
  return (
    <div
      className="pcard"
      tabIndex={0}
      role="group"
      aria-label={`${p.name}, ${p.phase}`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") void openProject(p.path);
        else if (e.key === "F2") setRenaming(true);
        else if (e.key === "Delete") confirmTrash(p);
        else if (e.key.toLowerCase() === "d" && e.ctrlKey) {
          e.preventDefault();
          void run("project:duplicate", { path: p.path }, "Couldn't duplicate the map.", () => {
            void reloadList();
          });
        }
      }}
    >
      <button
        className="pcard__open"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => void openProject(p.path)}
      >
        <Thumb p={p} />
      </button>
      <CardMenu
        p={p}
        onRename={() => {
          setRenaming(true);
        }}
      />
      <div className="pcard__body">
        {renaming ? (
          <input
            className="input"
            aria-label="Project name"
            autoFocus
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value);
            }}
            onBlur={() => void doRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doRename();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button className="pcard__name" onClick={() => void openProject(p.path)}>
            {p.name}
          </button>
        )}
        <div className="pcard__phase">{phaseChip(p)}</div>
        <div className="pcard__meta">
          <span>
            {p.levels > 0 ? `${plural(p.levels, "level")} · ${plural(p.rooms, "room")}` : "No plan yet"}
          </span>
          <span>{relativeTime(p.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  const list = useProject((s) => s.list);
  const loadList = useProject((s) => s.loadList);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"edited" | "name">("edited");
  const contBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (list === null) void loadList();
  }, [list, loadList]);
  const first = list?.[0] ?? null;
  useEffect(() => {
    contBtn.current?.focus();
  }, [first?.path]);
  const shown = useMemo(() => {
    const items = (list ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
    return sort === "name" ? [...items].sort((a, b) => a.name.localeCompare(b.name)) : items;
  }, [list, q, sort]);

  if (list !== null && list.length === 0) {
    return (
      <main className="home">
        <div className="home__in">
          <div className="home__top">
            <h1>
              No maps yet.
              <small>Pick a starting point, or describe your own map in the chat.</small>
            </h1>
            <button className="btn" onClick={() => void openProject()}>
              <Icon name="folder" />
              Open file…
            </button>
            <button className="btn btn--primary" onClick={() => void newProject()}>
              <Icon name="plus" />
              New map
            </button>
          </div>
          <div className="starters starters--big">
            {STARTERS.map((s) => (
              <button key={s.title} className="starter" onClick={() => void newProject(s.prompt)}>
                <b>{s.title}</b>
                {s.prompt}
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="home">
      <div className="home__in">
        <div className="home__top">
          <h1>
            {greeting()}
            <small>Pick up where you left off, or start a new map.</small>
          </h1>
          <button className="btn" onClick={() => void openProject()}>
            <Icon name="folder" />
            Open file…
          </button>
          <button className="btn btn--primary" onClick={() => void newProject()}>
            <Icon name="plus" />
            New map
          </button>
        </div>
        {first && (
          <section className="cont" aria-label="Continue">
            <Thumb p={first} big />
            <div className="cont__body">
              <span className="eyebrow">Continue</span>
              <h2>{first.name}</h2>
              <div className="cont__desc">
                {first.levels > 0
                  ? `${plural(first.levels, "level")} · ${plural(first.rooms, "room")} · `
                  : ""}
                edited {relativeTime(first.updatedAt)}
              </div>
              <div className="cont__phase">{phaseChip(first)}</div>
              <p className="cont__last">
                {first.phase === "brief"
                  ? "We were settling the brief. Next step: draw the first plan."
                  : first.phase === "plan"
                    ? "The plan is waiting for your review. Your unsent message is kept in the box."
                    : "Built and ready to paste. The paste checklist remembers where you got to."}
              </p>
              <button
                ref={contBtn}
                className="btn btn--primary btn--lg"
                onClick={() => void openProject(first.path)}
              >
                Continue <span className="kbd">Enter</span>
              </button>
            </div>
          </section>
        )}
        <div className="recent-h">
          <span className="eyebrow">Recent maps · {list?.length ?? 0}</span>
          <label className="search recent-h__search">
            <Icon name="search" size="sm" />
            <input
              className="search__input"
              placeholder="Search maps…"
              aria-label="Search maps"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
              }}
            />
          </label>
          <label className="recent-h__sort">
            <span className="sr-only">Sort</span>
            <select
              className="select"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value === "name" ? "name" : "edited");
              }}
            >
              <option value="edited">Last edited</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
        <div className="grid-cards">
          {shown.map((p) => (
            <ProjectCard key={p.path} p={p} />
          ))}
          <button className="pcard pcard--new" onClick={() => void newProject()}>
            <Icon name="plus" size="lg" />
            <span className="pcard--new__label">New map</span>
            <span className="muted">Ctrl+N</span>
          </button>
        </div>
      </div>
    </main>
  );
}
