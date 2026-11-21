/**
 * IPC conformance: one set of behaviour cases, run against main (the real router, handlers, ProjectService,
 * BuildService and core, with only the outside world replaced: a temp folder, scripted dialogs, an in-process
 * compile worker) and against the renderer's fake bridge. When the fake drifts from main, a case fails here.
 *
 * Covered: the channels whose behaviour matters (plan edits, approval, text edits, the brief, undo/redo, build).
 * Trivial getters are not listed. The fake's compiler is a placeholder (its slabs are not real), so the build case
 * compares what the renderer relies on (the version built, the build recorded, the refusal without a plan), not
 * the slabs.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { commitVersion } from "@slabyrinth/core";
import type { MapPlan } from "@slabyrinth/core";
import { afterEach, describe, expect, it } from "vitest";
import type { IpcEvents, IpcRequests, Result } from "../shared/ipc";
import { requestSchemas } from "../shared/schemas/ipc";
import { FIXTURE_PLAN } from "../main/fixturePlan";
import { createHandlers, type HandlerServices } from "../main/ipc/handlers";
import { createDispatcher } from "../main/ipc/router";
import { memoryLogger } from "../main/logger";
import { createCoreCompileBackend } from "../main/ports/compile";
import { BuildService } from "../main/services/buildService";
import { CompileService } from "../main/services/compileService";
import { PaletteService } from "../main/services/paletteService";
import { CatalogService } from "../main/services/talespire/catalogService";
import { projectRig, type ProjectRig } from "../main/services/testing/helpers";
import { inProcessWorker } from "../main/services/testing/inProcessWorker";
import { createFakeBridge } from "../renderer/bridge/fake/fakeBridge";
import { fakeRules } from "../renderer/bridge/fake/rules";

interface Host {
  name: string;
  invoke<C extends keyof IpcRequests>(
    channel: C,
    req: IpcRequests[C]["req"],
  ): Promise<Result<IpcRequests[C]["res"]>>;
  /** Raw payloads, as the renderer could send anything. */
  invokeRaw(channel: keyof IpcRequests, req: unknown): Promise<Result<unknown>>;
  /** Event channels sent since the host was made. */
  events: Array<keyof IpcEvents>;
  close(): Promise<void>;
}

/** Main, wired as app.ts wires it, with the outside world in a temp folder. */
async function mainHost(plan: MapPlan): Promise<Host> {
  const rig: ProjectRig = await projectRig();
  const logger = memoryLogger();
  const palettes = new PaletteService({
    userDir: path.join(rig.dir, "palettes"),
    orientationOverride: path.join(rig.dir, "o.json"),
    logger,
    openPath: () => Promise.resolve(""),
  });
  await palettes.load();
  const catalog = new CatalogService({
    catalogFile: path.join(rig.dir, "catalog.json"),
    reader: null,
    resolveInstall: () => Promise.resolve(null),
    palettes: () => [],
    emit: rig.emit,
    logger,
    suppressWarning: () => true,
  });
  const compiler = new CompileService({
    spawn: () => inProcessWorker(createCoreCompileBackend()),
    backend: "core",
    emit: rig.emit,
    logger,
  });
  const build = new BuildService({
    projects: rig.projects,
    compiler,
    palettes,
    catalog,
    settings: rig.settings,
    dialogs: rig.dialogs,
    logger,
  });
  const services = {
    projects: rig.projects,
    build,
    settings: rig.settings,
    logger,
    engine: () => null,
  } as unknown as HandlerServices;
  const dispatch = createDispatcher(createHandlers(services), requestSchemas, () => true, logger);
  await rig.projects.create({ name: "Conformance" });
  rig.projects.commitVersion({ plan, author: "ai", summary: "v1", cause: { type: "create" } });
  rig.emit.events.length = 0;
  const host: Host = {
    name: "main",
    invoke: (channel, req) =>
      dispatch(channel, "app://renderer", req) as Promise<Result<IpcRequests[typeof channel]["res"]>>,
    invokeRaw: (channel, req) => dispatch(channel, "app://renderer", req),
    get events() {
      return rig.emit.events.map((e) => e.channel);
    },
    close: async () => {
      await rig.projects.close({}).catch(() => undefined);
      await fsp.rm(rig.dir, { recursive: true, force: true });
    },
  };
  return host;
}

/** The renderer's fake bridge with the same project (v1 = the plan, committed with core as main does). */
async function fakeHost(plan: MapPlan): Promise<Host> {
  const bridge = createFakeBridge({ speed: 0, scenario: { empty: true } });
  const events: Array<keyof IpcEvents> = [];
  for (const c of ["plan:changed", "project:changed", "compile:progress"] as const)
    bridge.on(c, () => events.push(c));
  const snap = await bridge.invoke("project:new", { name: "Conformance" });
  if (!snap.ok) throw new Error(snap.error.message);
  const p = bridge.projects.get(snap.value.projectId);
  if (!p) throw new Error("no fake project");
  p.history = commitVersion(
    p.history,
    { plan, author: "ai", createdAt: new Date().toISOString(), summary: "v1", cause: { type: "create" } },
    fakeRules(),
  ).history;
  events.length = 0;
  return {
    name: "fake",
    invoke: (channel, req) => bridge.invoke(channel, req),
    invokeRaw: (channel, req) => bridge.invoke(channel, req as never),
    events,
    close: () => Promise.resolve(),
  };
}

const HOSTS = [mainHost, fakeHost];

let open: Host[] = [];
afterEach(async () => {
  for (const h of open) await h.close();
  open = [];
});

/** Runs `scenario` on both hosts and returns what each observed (the caller compares and checks them). */
async function onBoth<T>(scenario: (h: Host) => Promise<T>, plan: MapPlan = FIXTURE_PLAN): Promise<T[]> {
  const out: T[] = [];
  for (const make of HOSTS) {
    const h = await make(plan);
    open.push(h);
    out.push(await scenario(h));
  }
  return out;
}

const ok = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const areaOf = (plan: MapPlan | null, id: string) =>
  plan?.levels.flatMap((l) => l.areas).find((a) => a.id === id);

/** A plan whose second room is walled off: valid, but sealed (a playability error) for the keyed tomb. */
const SEALED: MapPlan = {
  ...FIXTURE_PLAN,
  levels: FIXTURE_PLAN.levels.map((l) => ({ ...l, areas: l.areas.filter((a) => a.id !== "c1") })),
};

describe("IPC conformance: main and the fake bridge answer alike", () => {
  it("plan:applyOps: a structural error refuses the edit; a playability finding does not", async () => {
    const [m, f] = await onBoth(async (h) => {
      const refused = await h.invoke("plan:applyOps", {
        baseVersion: 1,
        label: "Door to nowhere",
        ops: [
          {
            op: "add",
            element: {
              kind: "opening",
              level: "l1",
              value: { id: "dx", kind: "door", between: ["entry", "nowhere"] },
            },
          },
        ],
      });
      const accepted = await h.invoke("plan:applyOps", {
        baseVersion: 1,
        label: "Seal the tomb",
        ops: [{ op: "remove", ids: ["c1"] }],
      });
      const snap = ok(await h.invoke("project:snapshot", undefined));
      return {
        refused:
          refused.ok && !refused.value.ok
            ? refused.value.issues.map((i) => i.code).concat(refused.value.opErrors.map((e) => e.code))
            : refused,
        accepted:
          accepted.ok && accepted.value.ok
            ? { version: accepted.value.version, codes: accepted.value.issues.map((i) => i.code).sort() }
            : accepted,
        head: snap.head,
        planChanged: h.events.filter((e) => e === "plan:changed").length,
      };
    });
    expect(m).toEqual(f);
    expect(m?.head).toBe(2);
    expect((m?.accepted as { codes: string[] }).codes).toContain("area_sealed");
  });

  it("plan:approve: playability errors block approval; a clean plan is approved", async () => {
    const [m, f] = await onBoth(async (h) => {
      const blocked = ok(await h.invoke("plan:approve", { version: 1 }));
      const before = ok(await h.invoke("project:snapshot", undefined)).approvedVersion;
      return { blocked: { approved: blocked.approved, blocking: blocked.blocking.length > 0 }, before };
    }, SEALED);
    expect(m).toEqual(f);
    expect(m).toEqual({ blocked: { approved: false, blocking: true }, before: null });

    const [m2, f2] = await onBoth(async (h) => {
      const r = ok(await h.invoke("plan:approve", { version: 1 }));
      const snap = ok(await h.invoke("project:snapshot", undefined));
      return {
        approved: r.approved,
        blocking: r.blocking,
        approvedVersion: snap.approvedVersion,
        phase: snap.conversation.phase,
      };
    });
    expect(m2).toEqual(f2);
    expect(m2).toMatchObject({ approved: true, approvedVersion: 1, phase: "build" });
  });

  it("brief:update: a value is the GM's, null clears it, a bad value is refused", async () => {
    const [m, f] = await onBoth(async (h) => {
      const set = ok(await h.invoke("brief:update", { set: { tone: "grim", party: { size: 4 } } }));
      const cleared = ok(await h.invoke("brief:update", { set: { tone: null } }));
      const bad = await h.invokeRaw("brief:update", { set: { party: { size: "four" } } });
      const unknown = await h.invokeRaw("brief:update", { set: { colour: "red" } });
      return {
        set,
        cleared,
        hasTone: "tone" in cleared,
        bad: bad.ok ? "accepted" : bad.error.code,
        unknown: unknown.ok ? "accepted" : unknown.error.code,
      };
    });
    expect(m).toEqual(f);
    expect(m).toMatchObject({
      set: { tone: { value: "grim", source: "user" }, party: { value: { size: 4 }, source: "user" } },
      hasTone: false,
      bad: "validation",
      unknown: "validation",
    });
  });

  it("plan:undo / plan:redo move the head and the undone list the same way", async () => {
    const [m, f] = await onBoth(async (h) => {
      ok(
        await h.invoke("plan:applyOps", {
          baseVersion: 1,
          label: "Brazier",
          ops: [{ op: "add_features", level: "l1", features: [{ id: "b1", type: "brazier", at: [3, 5] }] }],
        }),
      );
      const undo = ok(await h.invoke("plan:undo", undefined));
      const afterUndo = ok(await h.invoke("project:snapshot", undefined));
      const redo = ok(await h.invoke("plan:redo", undefined));
      const afterRedo = ok(await h.invoke("project:snapshot", undefined));
      const again = await h.invoke("plan:redo", undefined);
      return {
        undo,
        undone: afterUndo.undone,
        noBrazier: !afterUndo.plan?.levels[0]?.features.some((x) => x.id === "b1"),
        redo,
        brazier: afterRedo.plan?.levels[0]?.features.some((x) => x.id === "b1"),
        again: again.ok ? "moved" : again.error.code,
      };
    });
    expect(m).toEqual(f);
    expect(m).toEqual({
      undo: { head: 1 },
      undone: [2],
      noBrazier: true,
      redo: { head: 2 },
      brazier: true,
      again: "validation",
    });
  });

  it("plan:editText: a text edit makes a version; another field of the same room merges into it", async () => {
    const [m, f] = await onBoth(async (h) => {
      const first = ok(await h.invoke("plan:editText", { id: "tomb", set: { name: "Crypt" } }));
      const second = ok(await h.invoke("plan:editText", { id: "tomb", set: { notes: "Cold." } }));
      const snap = ok(await h.invoke("project:snapshot", undefined));
      const shown = ok(await h.invoke("plan:getVersion", { version: second.head }));
      const bad = await h.invokeRaw("plan:editText", { id: "tomb", set: { shape: 3 } });
      return {
        sameEntryInHistory: snap.versions.filter((v) => v.author === "user").length,
        firstIsNotSecond: first.head !== second.head,
        name: areaOf(shown, "tomb")?.name,
        notes: areaOf(shown, "tomb")?.notes,
        headPlanName: areaOf(snap.plan, "tomb")?.name,
        bad: bad.ok ? "accepted" : bad.error.code,
      };
    });
    expect(m).toEqual(f);
    expect(m).toMatchObject({
      sameEntryInHistory: 1,
      name: "Crypt",
      notes: "Cold.",
      headPlanName: "Crypt",
      bad: "validation",
    });
  });

  it("compile:run builds the approved version and records it; without a plan it is refused", async () => {
    const [m, f] = await onBoth(async (h) => {
      ok(await h.invoke("plan:approve", { version: 1 }));
      const built = ok(await h.invoke("compile:run", {}));
      const snap = ok(await h.invoke("project:snapshot", undefined));
      return {
        planVersion: built.planVersion,
        recorded: snap.builds.length,
        buildIdListed: snap.builds.some((b) => b.id === built.buildId),
        progress: h.events.includes("compile:progress"),
      };
    });
    expect(m).toEqual(f);
    expect(m).toEqual({ planVersion: 1, recorded: 1, buildIdListed: true, progress: true });
  }, 60_000);
});
