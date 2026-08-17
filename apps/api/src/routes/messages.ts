import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { principal } from '../auth.js';
import { execute } from '../gateway.js';

const messagesSchema = z.object({
  model: z.string().default('gpt-4o'),
  messages: z.array(z.object({ role: z.string(), content: z.any() })).min(1),
  system: z.any().optional(),
  stream: z.boolean().default(false),
  max_tokens: z.number().optional(),
});

export async function registerMessagesRoutes(app: FastifyInstance) {
  app.post('/v1/messages', async (request, reply) => {
    const actor = principal(request);
    if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    const input = messagesSchema.parse(request.body);

    const openaiMessages: Array<{ role: string; content: unknown }> = [];
    if (input.system) {
      openaiMessages.push({ role: 'system', content: typeof input.system === 'string' ? input.system : JSON.stringify(input.system) });
    }
    for (const msg of input.messages) {
      openaiMessages.push({ role: msg.role || 'user', content: msg.content });
    }

    const gatewayReq = { model: input.model, messages: openaiMessages, stream: input.stream };
    const options = { kind: 'api' as const, apiKeyId: actor.type === 'api_key' ? actor.id : undefined };

    if (input.stream) {
      return streamAnthropic(gatewayReq, reply, options);
    }

    let textContent = '';
    const msgId = `msg_${Math.random().toString(36).substring(2, 11)}`;

    for await (const result of execute(gatewayReq, options)) {
      if (result.item.type === 'message.delta') textContent += result.item.text;
    }

    return {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: input.model,
      content: [{ type: 'text', text: textContent }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: textContent.length }
    };
  });
}

async function streamAnthropic(gatewayReq: { model: string; messages: Array<{ role: string; content: unknown }>; stream: boolean }, reply: FastifyReply, options: { kind: 'api'; apiKeyId?: string }) {
  const iterator = execute(gatewayReq, options);
  let firstResult: IteratorResult<{ requestId: string; item: any }> | null = null;
  try {
    firstResult = await iterator.next();
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 502;
    const message = error instanceof Error ? error.message : 'Gateway error';
    return reply.status(statusCode).send({
      type: 'error',
      error: {
        type: statusCode === 401 ? 'authentication_error' : statusCode === 404 ? 'invalid_request_error' : statusCode === 503 ? 'service_unavailable' : 'api_error',
        message
      }
    });
  }

  reply.hijack();
  const origin = (reply.request.headers.origin as string | undefined) || '*';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-session-id, x-admin-token, x-api-key, anthropic-version',
  });
  const msgId = `msg_${Math.random().toString(36).substring(2, 11)}`;

  try {
    reply.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: gatewayReq.model, stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`);
    reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);

    let current = firstResult;
    while (!current.done) {
      const result = current.value;
      if (result.item.type === 'message.delta') {
        reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.item.text } })}\n\n`);
      }
      current = await iterator.next();
    }

    reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } })}\n\n`);
    reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  } catch (error) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : 'Gateway error' } })}\n\n`);
  } finally {
    reply.raw.end();
  }
}
