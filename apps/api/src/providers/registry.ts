import type { ProviderAdapter } from './types.js';

class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  register(adapter: ProviderAdapter) { this.adapters.set(adapter.provider, adapter); }
  get(provider: string) { return this.adapters.get(provider); }
}

export const providers = new ProviderRegistry();
