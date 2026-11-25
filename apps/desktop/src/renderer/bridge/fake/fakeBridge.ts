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
 *   addon-notfound | addon-missing (default) | addon-installed | addon-outdated | addon-mismatch | addon-foreign
 *           → the TaleSpire add-on's install state;  addon-autofail → outdated, the automatic update failed
 *   helper-none (default) | helper-connected | helper-refused → the add-on's link;  wayland → a Wayland session
 *
 * The state is one FakeState per bridge (state.ts); the channels are answered by handler groups in handlers/, one
 * per area of main (app, projects, plan, chat, build, TaleSpire). The type of `handlers` below checks every
 * channel has exactly one answer.
 */
import type { z } from "zod";
import type { IpcEvents, IpcRequests, Result, SlabyrinthApi } from "../../../shared/ipc";
import { describeRequestError, requestSchemas } from "../../../shared/schemas/ipc";
import type { FakeProject } from "./fixtures";
import { addonHandlers } from "./handlers/addon";
import { appHandlers } from "./handlers/app";
import { buildHandlers } from "./handlers/build";
import { chatHandlers } from "./handlers/chat";
import { planHandlers } from "./handlers/plan";
import { projectHandlers } from "./handlers/projects";
import { taleSpireHandlers } from "./handlers/talespire";
import { view3dHandlers } from "./handlers/view3d";
import { FakeFailure, FakeState, type FakeOptions, type FakeScenario, type Handlers } from "./state";
import { setFakeSizeTier } from "./rules";

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
    ...addonScenario(flags),
  };
}

const ADDON_STATES = ["not_found", "missing", "installed", "outdated", "mismatch", "foreign"] as const;
const HELPER_STATES = ["none", "connected", "refused"] as const;

/** addon-<state>, addon-autofail, helper-<state>, wayland (see the comment at the top). */
function addonScenario(
  flags: Set<string>,
): Pick<FakeScenario, "addon" | "addonAutoFailed" | "helper" | "wayland"> {
  const out: Pick<FakeScenario, "addon" | "addonAutoFailed" | "helper" | "wayland"> = {};
  for (const a of ADDON_STATES) if (flags.has(`addon-${a.replace("_", "")}`)) out.addon = a;
  for (const h of HELPER_STATES) if (flags.has(`helper-${h}`)) out.helper = h;
  if (flags.has("addon-autofail")) {
    out.addon = "outdated";
    out.addonAutoFailed = true;
  }
  if (flags.has("wayland")) out.wayland = true;
  return out;
}

export function createFakeBridge(opts: FakeOptions = {}): SlabyrinthApi & {
  emit: <C extends keyof IpcEvents>(c: C, p: IpcEvents[C]) => void;
  projects: Map<string, FakeProject>;
} {
  const s = new FakeState(opts);
  setFakeSizeTier(() => s.settings.mapSize ?? "standard");
  const handlers: Handlers = {
    ...appHandlers(s),
    ...projectHandlers(s),
    ...planHandlers(s),
    ...chatHandlers(s),
    ...buildHandlers(s),
    ...taleSpireHandlers(s),
    ...addonHandlers(s),
    ...view3dHandlers(s),
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
      // main's request schemas: the fake refuses what main's router would refuse
      const parsed = (requestSchemas[channel] as z.ZodType).safeParse(req);
      if (!parsed.success)
        return { ok: false, error: { code: "validation", message: describeRequestError(parsed.error) } };
      try {
        const h = handlers[channel] as (
          r: IpcRequests[C]["req"],
        ) => IpcRequests[C]["res"] | Promise<IpcRequests[C]["res"]>;
        const value = await h(parsed.data ?? undefined);
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
