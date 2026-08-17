import { db, id } from './db.js';

export type ModelCapabilities = {
  input: Array<'text' | 'image'>;
  output: Array<'text' | 'image' | 'video'>;
  streaming: boolean;
  reasoningSummary?: boolean;
  webSearch?: boolean;
  imageGeneration?: boolean;
};

type WebDefault = { provider: string; upstreamId: string; publicModel: string; capabilities: ModelCapabilities };

// Official web products change their picker independently of their APIs. These are
// conservative, editable startup defaults—not a promise that every account can use
// every entry. Browser discovery updates the same rows after an authorized login.
export const webDefaults: readonly WebDefault[] = [
  { provider: 'chatgpt', upstreamId: 'gpt-5.6', publicModel: 'gpt-5.6', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'chatgpt', upstreamId: 'gpt-5.6-thinking', publicModel: 'gpt-5.6-thinking', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'chatgpt', upstreamId: 'auto', publicModel: 'auto', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, webSearch: true } },
  { provider: 'chatgpt', upstreamId: 'gpt-image-2', publicModel: 'gpt-image-2', capabilities: { input: ['text'], output: ['image'], streaming: false, imageGeneration: true } },

  // Kimi
  { provider: 'kimi', upstreamId: 'k1.5-thinking', publicModel: 'kimi-k1.5-thinking', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'kimi', upstreamId: 'K3', publicModel: 'kimi-k3', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'kimi', upstreamId: 'K2.6', publicModel: 'kimi-k2.6', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'kimi', upstreamId: 'k2', publicModel: 'kimi-k2', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'kimi', upstreamId: 'K3 Swarm', publicModel: 'kimi-k3-swarm', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },

  // DeepSeek
  { provider: 'deepseek', upstreamId: 'deepseek-v3', publicModel: 'deepseek-v3', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'deepseek', upstreamId: 'deepseek-chat', publicModel: 'deepseek-chat', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'deepseek', upstreamId: 'deepseek-r1', publicModel: 'deepseek-r1', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'deepseek', upstreamId: 'deepseek-reasoner', publicModel: 'deepseek-reasoner', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'deepseek', upstreamId: 'deepseek-v4-flash', publicModel: 'deepseek-v4-flash', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'deepseek', upstreamId: 'deepseek-v4-pro', publicModel: 'deepseek-v4-pro', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },

  // GLM / 智谱
  { provider: 'glm', upstreamId: 'GLM-4-Flash', publicModel: 'glm-4-flash', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'glm', upstreamId: 'GLM-4-Plus', publicModel: 'glm-4-plus', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'glm', upstreamId: 'GLM-4', publicModel: 'glm-4', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'glm', upstreamId: 'GLM-5.2', publicModel: 'glm-5.2', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'glm', upstreamId: 'GLM-5V-Turbo', publicModel: 'glm-5v-turbo', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true } },
  { provider: 'glm', upstreamId: 'GLM-Image', publicModel: 'glm-image', capabilities: { input: ['text'], output: ['image'], streaming: false, imageGeneration: true } },
  { provider: 'glm', upstreamId: 'CogVideoX-3', publicModel: 'cogvideox-3', capabilities: { input: ['text', 'image'], output: ['video'], streaming: false } },

  // Qwen / 通义千问
  { provider: 'qwen', upstreamId: 'qwen3.8-max', publicModel: 'qwen3.8-max', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'qwen', upstreamId: 'qwen-max', publicModel: 'qwen-max', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'qwen', upstreamId: 'qwen-plus', publicModel: 'qwen-plus', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'qwen', upstreamId: 'qwen-turbo', publicModel: 'qwen-turbo', capabilities: { input: ['text'], output: ['text'], streaming: true } },
  { provider: 'qwen', upstreamId: 'Qwen3-Max', publicModel: 'qwen3-max', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true, webSearch: true } },
  { provider: 'qwen', upstreamId: 'Qwen-Flash', publicModel: 'qwen-flash', capabilities: { input: ['text'], output: ['text'], streaming: true } },
  { provider: 'qwen', upstreamId: 'Qwen3-Coder-Plus', publicModel: 'qwen3-coder-plus', capabilities: { input: ['text'], output: ['text'], streaming: true, reasoningSummary: true } },
  { provider: 'qwen', upstreamId: 'Qwen3-VL-Plus', publicModel: 'qwen3-vl-plus', capabilities: { input: ['text', 'image'], output: ['text'], streaming: true, reasoningSummary: true } },
  { provider: 'qwen', upstreamId: 'Qwen-Image', publicModel: 'qwen-image', capabilities: { input: ['text'], output: ['image'], streaming: false, imageGeneration: true } },
  { provider: 'qwen', upstreamId: 'Wan2.6-T2I', publicModel: 'wan2.6-t2i', capabilities: { input: ['text'], output: ['image'], streaming: false, imageGeneration: true } },

  // Jimeng / 即梦
  { provider: 'jimeng', upstreamId: '文生图 3.1', publicModel: 'jimeng-3.1', capabilities: { input: ['text'], output: ['image'], streaming: false, imageGeneration: true } },
  { provider: 'jimeng', upstreamId: '文生图 3.0', publicModel: 'jimeng-3.0', capabilities: { input: ['text'], output: ['image'], streaming: false, imageGeneration: true } },
  { provider: 'jimeng', upstreamId: '图片 5.0 Pro', publicModel: 'jimeng-image-5.0-pro', capabilities: { input: ['text', 'image'], output: ['image'], streaming: false, imageGeneration: true } },
  { provider: 'jimeng', upstreamId: '图片 5.0 Lite', publicModel: 'jimeng-image-5.0-lite', capabilities: { input: ['text', 'image'], output: ['image'], streaming: false, imageGeneration: true } },
  { provider: 'jimeng', upstreamId: 'Seedance 2.0', publicModel: 'jimeng-seedance-2.0', capabilities: { input: ['text', 'image'], output: ['video'], streaming: false } },
  { provider: 'jimeng', upstreamId: 'Seedance 2.0 Fast', publicModel: 'jimeng-seedance-2.0-fast', capabilities: { input: ['text', 'image'], output: ['video'], streaming: false } }
];

export function visibleModels() {
  return db.prepare(`SELECT r.public_model AS id, m.provider, m.capabilities_json
    FROM routes r JOIN models m ON m.id = r.model_id
    WHERE r.enabled = 1 AND m.enabled = 1 AND EXISTS (
      SELECT 1 FROM provider_accounts a WHERE a.provider = m.provider AND a.status = 'ready'
    ) ORDER BY r.public_model`).all() as Array<{ id: string; provider: string; capabilities_json: string }>;
}

export function modelList() {
  return {
    object: 'list',
    data: visibleModels().map((model) => {
      let capabilities: ModelCapabilities = { input: ['text'], output: ['text'], streaming: true };
      try { capabilities = JSON.parse(model.capabilities_json); } catch {}
      const isImage = Boolean(capabilities.imageGeneration || capabilities.output?.includes('image'));
      const isVideo = Boolean(capabilities.output?.includes('video'));
      const type = isVideo ? 'video' : isImage ? 'image' : 'chat';
      return {
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: model.provider || 'any2api',
        type,
        capabilities,
        permission: [{
          id: `modelperm-${model.id}`,
          object: 'model_permission',
          created: 0,
          allow_create_engine: false,
          allow_sampling: true,
          allow_logprobs: true,
          allow_search_indices: false,
          allow_view: true,
          allow_fine_tuning: false,
          organization: '*',
          group: null,
          is_blocking: false
        }]
      };
    })
  };
}

export function catalog() {
  return (db.prepare(`SELECT r.public_model AS id, r.enabled AS route_enabled, r.priority, m.provider, m.upstream_id, m.enabled AS model_enabled, m.capabilities_json
    FROM routes r JOIN models m ON m.id = r.model_id ORDER BY r.enabled DESC, r.priority DESC, r.public_model ASC`).all() as Array<{ id: string; route_enabled: number; priority: number; provider: string; upstream_id: string; model_enabled: number; capabilities_json: string }>)
    .map((model) => ({ ...model, capabilities: JSON.parse(model.capabilities_json) }));
}

export function seedWebDefaults() {
  const insertModel = db.prepare(`INSERT INTO models (id, provider, upstream_id, capabilities_json, discovered_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, upstream_id) DO UPDATE SET capabilities_json = excluded.capabilities_json`);
  const insertRoute = db.prepare(`INSERT OR IGNORE INTO routes (id, public_model, model_id, priority, created_at) VALUES (?, ?, ?, 20, ?)`);
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const model of webDefaults) {
      const modelId = `${model.provider}:${model.upstreamId}`;
      insertModel.run(modelId, model.provider, model.upstreamId, JSON.stringify(model.capabilities), now);
      insertRoute.run(id('rte'), model.publicModel, modelId, now);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function upsertDiscoveredModel(provider: string, upstreamId: string, capabilities: ModelCapabilities, publicModel = upstreamId) {
  const modelId = `${provider}:${upstreamId}`;
  const now = Date.now();
  db.prepare(`INSERT INTO models (id, provider, upstream_id, capabilities_json, discovered_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, upstream_id) DO UPDATE SET capabilities_json = excluded.capabilities_json, discovered_at = excluded.discovered_at`)
    .run(modelId, provider, upstreamId, JSON.stringify(capabilities), now);
  db.prepare(`INSERT INTO routes (id, public_model, model_id, priority, created_at) VALUES (?, ?, ?, 20, ?)
    ON CONFLICT(public_model) DO UPDATE SET model_id = excluded.model_id`).run(id('rte'), publicModel, modelId, now);
}
