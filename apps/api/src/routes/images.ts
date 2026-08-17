import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { principal } from '../auth.js';
import { execute } from '../gateway.js';

const imageGenSchema = z.object({
  model: z.string().default('jimeng-3.1'),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(10).default(1),
  size: z.string().default('1024x1024'),
  response_format: z.enum(['url', 'b64_json']).default('url'),
});

export async function registerImageRoutes(app: FastifyInstance) {
  app.post('/v1/images/generations', async (request, reply) => {
    const actor = principal(request);
    if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    const input = imageGenSchema.parse(request.body);

    const imageUrls: string[] = [];
    const messages = [{ role: 'user', content: input.prompt }];

    for await (const result of execute({ model: input.model, messages, stream: false }, { kind: 'api', apiKeyId: actor.type === 'api_key' ? actor.id : undefined })) {
      if (result.item.type === 'image.created') {
        imageUrls.push(result.item.url);
      }
    }

    if (imageUrls.length === 0) {
      throw Object.assign(new Error('Image generation failed or returned no valid images from upstream'), { statusCode: 502 });
    }

    const data = imageUrls.map((url) => {
      if (input.response_format === 'b64_json' && url.startsWith('data:image/')) {
        const b64 = url.split(',')[1] ?? '';
        return { b64_json: b64 };
      }
      return { url };
    });

    return {
      created: Math.floor(Date.now() / 1000),
      data
    };
  });

  app.post('/v1/images/edits', async (request, reply) => {
    const actor = principal(request);
    if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    const input = imageGenSchema.extend({ image: z.string().optional() }).parse(request.body);

    const imageUrls: string[] = [];
    const promptWithImg = input.image ? `[Init Image: ${input.image}]\n${input.prompt}` : input.prompt;
    const messages = [{ role: 'user', content: promptWithImg }];

    for await (const result of execute({ model: input.model, messages, stream: false }, { kind: 'api', apiKeyId: actor.type === 'api_key' ? actor.id : undefined })) {
      if (result.item.type === 'image.created') {
        imageUrls.push(result.item.url);
      }
    }

    const data = imageUrls.map((url) => ({ url }));
    return {
      created: Math.floor(Date.now() / 1000),
      data
    };
  });
}
