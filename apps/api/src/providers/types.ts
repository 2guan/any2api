import type { Account } from '../accounts.js';
import type { ModelCapabilities } from '../catalog.js';

export type ProviderEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'reasoning.summary.delta'; text: string }
  | { type: 'search.citation'; title: string; url: string }
  | { type: 'image.created'; url: string }
  | { type: 'completed'; usage?: { inputTokens?: number; outputTokens?: number } };

export type ProviderRequest = { model: string; messages: Array<{ role: string; content: unknown }>; stream: boolean; reasoning?: { effort?: string }; webSearch?: boolean };

export interface ProviderAdapter {
  readonly provider: string;
  discoverModels(account: Account): AsyncIterable<{ upstreamId: string; capabilities: ModelCapabilities }>;
  streamTurn(request: ProviderRequest, account: Account): AsyncIterable<ProviderEvent>;
  testConnection(account: Account): Promise<{ ok: boolean; detail: string }>;
  refreshCredentials?(account: Account): Promise<void>;
}
