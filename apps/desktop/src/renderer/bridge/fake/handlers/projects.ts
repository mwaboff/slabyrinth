/** The fake main's project channels: new, open, rename, copy, trash, close, list (with thumbnails), UI state. */
import { newUntitledProject, type FakeProject } from "../fixtures";
import type { FakeState, HandlerGroup } from "../state";
import { fail } from "../state";
import { thumbnail } from "../thumbs";

type ProjectChannels =
  | "project:new"
  | "project:open"
  | "project:saveCopyAs"
  | "project:rename"
  | "project:duplicate"
  | "project:trash"
  | "project:revealInFolder"
  | "project:close"
  | "project:snapshot"
  | "project:list"
  | "project:setUiState"
  | "project:importPlan"
  | "project:exportPlan";

export function projectHandlers(s: FakeState): HandlerGroup<ProjectChannels> {
  const byPath = (path: string | undefined): FakeProject | undefined =>
    [...s.projects.values()].find((x) => x.path === path);
  return {
    "project:new": ({ name }) => {
      s.untitled++;
      const p = newUntitledProject(
        `untitled-${Date.now().toString(36)}`,
        name ?? (s.untitled > 1 ? `Untitled map ${s.untitled}` : "Untitled map"),
      );
      p.conversation.selection = { ...s.settings.defaultSelection };
      s.projects.set(p.id, p);
      s.openId = p.id;
      s.touch(p);
      return s.snapshot(p);
    },
    "project:open": ({ path }) => {
      const p = byPath(path);
      if (!p) {
        if (path === undefined) return null; // dialog cancelled
        return fail("not_found", "That file isn't a Slabyrinth project.");
      }
      s.openId = p.id;
      return s.snapshot(p);
    },
    "project:saveCopyAs": () => ({ path: `${s.open().path.replace(/\.slabyrinth$/, "")} (copy).slabyrinth` }),
    "project:rename": ({ name }) => {
      const p = s.open();
      const oldPath = p.path;
      p.name = name;
      p.path = p.path.replace(/[^\\]+\.slabyrinth$/, `${name}.slabyrinth`);
      s.recent = s.recent.map((x) => (x === oldPath ? p.path : x));
      s.emit("project:changed", { dirty: false, filePath: p.path, name });
    },
    "project:duplicate": ({ path }) => {
      const src = byPath(path);
      if (!src) return fail("not_found", "Project not found.");
      const copy: FakeProject = structuredClone(src);
      copy.id = `${src.id}-copy-${Date.now().toString(36)}`;
      copy.name = `${src.name} (copy)`;
      copy.path = src.path.replace(/\.slabyrinth$/, " (copy).slabyrinth");
      s.projects.set(copy.id, copy);
      s.touch(copy);
      return { path: copy.path };
    },
    "project:trash": ({ path }) => {
      const p = byPath(path);
      if (p) s.projects.delete(p.id);
      s.recent = s.recent.filter((x) => x !== path);
    },
    "project:revealInFolder": () => undefined,
    "project:close": () => {
      s.openId = null;
      return { closed: true };
    },
    "project:snapshot": () => s.snapshot(s.open()),
    "project:list": async () => {
      const rows = [...s.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return Promise.all(
        rows.map(async (p) => {
          const e = s.listEntry(p);
          const plan = s.planAt(p, p.history.head);
          const png = plan ? await thumbnail(plan, `${p.id}@${p.history.head}`) : undefined;
          return png !== undefined ? { ...e, thumbnailPng: png } : e;
        }),
      );
    },
    "project:setUiState": ({ ui, pasteGuide, pngExport }) => {
      const p = s.open();
      const cur = s.uiState.get(p.id) ?? { ui: { tab: "map" }, pasteGuide: null, pngExport: null };
      if (pngExport !== undefined) cur.pngExport = structuredClone(pngExport);
      if (ui !== undefined) cur.ui = { ...cur.ui, ...ui };
      if (pasteGuide !== undefined) cur.pasteGuide = pasteGuide;
      s.uiState.set(p.id, cur);
    },
    "project:importPlan": () => null,
    "project:exportPlan": () => ({ path: `${s.open().path.replace(/\.slabyrinth$/, "")}.plan.json` }),
  };
}
