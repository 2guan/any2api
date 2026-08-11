import type { ProviderAdapter, ProviderEvent, ProviderRequest } from './types.js';
import type { Account } from '../accounts.js';

export class UnconfiguredBrowserAdapter implements ProviderAdapter {
  constructor(readonly provider: string) {}
  async *discoverModels(_account: Account) { return; }
  async *streamTurn(_request: ProviderRequest, _account: Account): AsyncIterable<ProviderEvent> {
    throw new Error(`${this.provider} browser adapter has not been configured yet`);
  }
  async testConnection(_account: Account) { return { ok: false, detail: `${this.provider} browser adapter has not been configured yet` }; }
}
