import { createConversationEngine } from "./agent";
import type { ApplyOps } from "@slabyrinth/core";
import { createFakeEngine } from "./engine/fakeEngine";
import type { EngineFactory } from "./ports/engine";

/**
 * Which ConversationEngine the app runs (architecture §3.2, §8.2).
 *
 *  - "real" (default, every build): WP4's engine with the provider registry it builds itself — the
 *    AnthropicProvider, keyed from the SecretStore through EngineHost.getApiKey.
 *  - "fake": the recorded-stream fake engine, ONLY with an explicit dev/test switch:
 *    SLABYRINTH_FAKE_ENGINE=1 in a dev or test (smoke/e2e) run, or the `fakeEngine` feature flag in a
 *    dev run. Packaged builds ignore the flag.
 *  - "scripted": the real engine with a scripted, network-free ChatProvider registered in place of
 *    Anthropic (SLABYRINTH_E2E_PROVIDER_SCRIPT=<steps.json>), honoured only in test runs (safe mode) of
 *    TEST BUILDS: the provider code exists only where __SLABYRINTH_TEST_BUILD__ is true (out-test/,
 *    Vitest); production bundles drop it at build time.
 */
export type EngineKind = "real" | "fake" | "scripted";

export interface EngineSelectionInput {
  isDev: boolean;
  /** Smoke and e2e runs. */
  safeMode: boolean;
  env: Record<string, string | undefined>;
  /** The `fakeEngine` feature flag from settings. */
  fakeEngineFlag: boolean;
  applyOps: ApplyOps | null;
}

export interface EngineSelection {
  kind: EngineKind;
  factory: EngineFactory;
}

/** Whether this bundle contains the scripted e2e provider (build-time constant). */
export const HAS_SCRIPTED_PROVIDER: boolean = __SLABYRINTH_TEST_BUILD__;

export function engineKindFor(
  input: Omit<EngineSelectionInput, "applyOps">,
  testBuild: boolean = HAS_SCRIPTED_PROVIDER,
): EngineKind {
  const testOrDev = input.isDev || input.safeMode;
  if (testBuild && input.safeMode && (input.env["SLABYRINTH_E2E_PROVIDER_SCRIPT"] ?? "") !== "")
    return "scripted";
  if (testOrDev && input.env["SLABYRINTH_FAKE_ENGINE"] === "1") return "fake";
  if (input.isDev && input.fakeEngineFlag) return "fake";
  return "real";
}

/**
 * The key the engine uses for a provider (architecture §6.5): the stored key always wins. ANTHROPIC_API_KEY from the
 * environment is a fallback only in development builds, and never in smoke/e2e runs (safe mode), so a packaged app
 * never picks up a key from its environment and a test can't spend money with a developer's key.
 */
export function resolveApiKey(
  stored: string | null,
  providerId: string,
  ctx: { isDev: boolean; safeMode: boolean; env: Record<string, string | undefined> },
): string | null {
  if (stored !== null) return stored;
  if (!ctx.isDev || ctx.safeMode || providerId !== "anthropic") return null;
  const fromEnv = ctx.env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  return fromEnv === "" ? null : fromEnv;
}

export async function selectEngine(input: EngineSelectionInput): Promise<EngineSelection> {
  const kind = engineKindFor(input);
  if (kind === "fake") {
    return {
      kind,
      factory: createFakeEngine({ speed: input.safeMode ? 0 : 1, applyOps: input.applyOps }),
    };
  }
  if (kind === "scripted" && __SLABYRINTH_TEST_BUILD__) {
    // Test-only code: the whole branch, and the chunk it imports, is removed from production bundles.
    const { createScriptedEngineFactory } = await import("./agent/testing/e2eProvider");
    return {
      kind,
      factory: await createScriptedEngineFactory(
        input.env["SLABYRINTH_E2E_PROVIDER_SCRIPT"] ?? "",
        input.env["SLABYRINTH_E2E_PROVIDER_LOG"],
      ),
    };
  }
  return { kind, factory: createConversationEngine };
}
