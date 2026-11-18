/**
 * ProviderRegistry (contract): the engine finds providers here and knows nothing else about them.
 * v1 registers only "anthropic"; an LM Studio provider would be registered the same way (see README.md).
 */
import { createAnthropicProvider, type AnthropicProviderOptions } from "./anthropic";
import type { ChatProvider, ProviderId, ProviderRegistry } from "./types";

export class DefaultProviderRegistry implements ProviderRegistry {
  private readonly providers = new Map<ProviderId, ChatProvider>();

  constructor(providers: readonly ChatProvider[] = []) {
    for (const p of providers) this.register(p);
  }

  register(provider: ChatProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): ChatProvider | undefined {
    return this.providers.get(id);
  }

  list(): ChatProvider[] {
    return [...this.providers.values()];
  }
}

export function createDefaultRegistry(anthropic: AnthropicProviderOptions = {}): DefaultProviderRegistry {
  return new DefaultProviderRegistry([createAnthropicProvider(anthropic)]);
}
