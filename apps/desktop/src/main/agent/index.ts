/**
 * WP4 desktop agent: ConversationEngine (provider-neutral turn loop), ProviderRegistry and AnthropicProvider.
 * The shell (WP5) picks up `createConversationEngine` at startup (main/ports/engine.ts).
 */
import type { EngineFactory } from "../ports/engine";
import { SlabyrinthConversationEngine } from "./engine";

export const createConversationEngine: EngineFactory = (host) => new SlabyrinthConversationEngine(host);

export {
  SlabyrinthConversationEngine,
  snapEffort,
  capEffort,
  lastMarkerEffort,
  type EngineOptions,
} from "./engine";
export * from "./cost";
export { DefaultProviderRegistry, createDefaultRegistry } from "./provider/registry";
export { ProviderFailure, providerError, errorInfo } from "./provider/errors";
