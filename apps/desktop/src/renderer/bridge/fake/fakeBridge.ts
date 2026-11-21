/**
 * Fake `window.slabyrinth` for running the renderer in a plain browser and in tests.
 * Implements every request channel of shared/ipc.ts with in-memory state and the real core history
 * functions, and emits the same events main will. Never touches the real clipboard, TaleSpire or disk.
 *
 * Scenario flags (URL `?fake=a,b` or createFakeBridge({ scenario })):
 *   setup   → first run (Setup window)      nokey → no API key stored
 *   nots    → TaleSpire not found           empty → no projects yet
 *   win     → platform win32 (native window controls)
 *   update  → a newer release is available (header chip)
 *
 * The state is one FakeState per bridge (state.ts); the channels are answered by handler groups in handlers/, one
 * per area of main (app, projects, plan, chat, build, TaleSpire). The type of `handlers` below checks every
 * channel has exactly one answer.
 */
import type { IpcEvents, IpcRequests, Result, SlabyrinthApi } from "../../../shared/ipc";
import type { FakeProject } from "./fixtures";
import { appHandlers } from "./handlers/app";
import { buildHandlers } from "./handlers/build";
import { chatHandlers } from "./handlers/chat";
import { planHandlers } from "./handlers/plan";
import { projectHandlers } from "./handlers/projects";
import { taleSpireHandlers } from "./handlers/talespire";
import { FakeFailure, FakeState, type FakeOptions, type FakeScenario, type Handlers } from "./state";

export type { FakeOptions, FakeScenario } from "./state";

/** Every request waits this long (scaled by `speed`), like a round trip to main. */
const INVOKE_DELAY_MS = 30;
/** When main sends the no-install warning after start (the first catalog check). */
const STARTUP_WARNING_MS = 600;

export function parseScenario(search: string): FakeScenario {
  const p = new URLSearchParams(search).get("fake") ?? "";
  const flags = new Set(p.split(",").map((s) => s.trim()));
  return {
    setup: flags.has("setup"),
    nokey: flags.has("nokey") || flags.has("setup"),
    nots: flags.has("nots"),
    empty: flags.has("empty") || flags.has("setup"),
    win: flags.has("win"),
    update: flags.has("update"),
  };
}

export function createFakeBridge(opts: FakeOptions = {}): SlabyrinthApi & {
  emit: <C extends keyof IpcEvents>(c: C, p: IpcEvents[C]) => void;
  projects: Map<string, FakeProject>;
} {
  const s = new FakeState(opts);
  const handlers: Handlers = {
    ...appHandlers(s),
    ...projectHandlers(s),
    ...planHandlers(s),
    ...chatHandlers(s),
    ...buildHandlers(s),
    ...taleSpireHandlers(s),
  };
  // Startup warning, as main sends it after the first catalog check.
  if (s.scenario.nots === true) {
    setTimeout(() => {
      s.emit("catalog:warning", { kind: "no_install", message: "TaleSpire wasn't found." });
    }, STARTUP_WARNING_MS * s.speed);
  }
  return {
    async invoke<C extends keyof IpcRequests>(
      channel: C,
      req: IpcRequests[C]["req"],
    ): Promise<Result<IpcRequests[C]["res"]>> {
      await s.sleep(INVOKE_DELAY_MS);
      try {
        const h = handlers[channel] as (
          r: IpcRequests[C]["req"],
        ) => IpcRequests[C]["res"] | Promise<IpcRequests[C]["res"]>;
        const value = await h(req);
        return { ok: true, value };
      } catch (e) {
        if (e instanceof FakeFailure) return { ok: false, error: e.appError };
        return {
          ok: false,
          error: { code: "internal", message: e instanceof Error ? e.message : String(e) },
        };
      }
    },
    on<C extends keyof IpcEvents>(channel: C, listener: (payload: IpcEvents[C]) => void): () => void {
      let set = s.listeners.get(channel);
      if (!set) {
        set = new Set();
        s.listeners.set(channel, set);
      }
      const l = listener as (p: unknown) => void;
      set.add(l);
      return () => set.delete(l);
    },
    send(): void {
      // render:imageResult — nothing consumes it in the fake.
    },
    emit: s.emit,
    projects: s.projects,
  };
}
