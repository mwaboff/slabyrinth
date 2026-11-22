import { createConversationEngine } from "./agent";
import type { EngineFactory } from "./ports/engine";

/**
 * Which ConversationEngine the app runs (architecture §3.2, §8.2). There is one engine; only its provider changes.
 *
 *  - "real" (default, every build): the engine with the provider registry it builds itself — the
 *    AnthropicProvider, keyed from the SecretStore through EngineHost.getApiKey.
 *  - "scripted": the same engine with a scripted, network-free ChatProvider registered in place of
 *    Anthropic (SLABYRINTH_E2E_PROVIDER_SCRIPT=<steps.json>), honoured only in test runs (safe mode) of
 *    TEST BUILDS: the provider code exists only where __SLABYRINTH_TEST_BUILD__ is true (out-test/,
 *    Vitest); production bundles drop it at build time.
 */
export type EngineKind = "real" | "scripted";

export interface EngineSelectionInput {
  isDev: boolean;
  /** Smoke and e2e runs. */
  safeMode: boolean;
  env: Record<string, string | undefined>;
}

export interface EngineSelection {
  kind: EngineKind;
  factory: EngineFactory;
}

/** Whether this bundle contains the scripted e2e provider (build-time constant). */
export const HAS_SCRIPTED_PROVIDER: boolean = __SLABYRINTH_TEST_BUILD__;

export function engineKindFor(
  input: EngineSelectionInput,
  testBuild: boolean = HAS_SCRIPTED_PROVIDER,
): EngineKind {
  if (testBuild && input.safeMode && (input.env["SLABYRINTH_E2E_PROVIDER_SCRIPT"] ?? "") !== "")
    return "scripted";
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
  return { kind: "real", factory: createConversationEngine };
}
