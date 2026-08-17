import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { principal } from '../auth.js';
import { execute } from '../gateway.js';

const PPT_PROMPT = `我需要你根据用户的需求，来制作一个可以编辑的PPT，你可以使用Agent来做...`;
const PSD_PROMPT = `帮我生成这个图像，把这张海报分成若干图像...`;

type TaskItem = { id: string; type: 'ppt' | 'psd'; prompt: string; status: string; resultUrl?: string; createdAt: number };
const tasks = new Map<string, TaskItem>();

export async function registerEditableFilesRoutes(app: FastifyInstance) {
  app.post('/v1/ppt/generations', async (request) => {
    const actor = principal(request);
    if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    const body = z.object({ prompt: z.string().min(1), model: z.string().default('gpt-4o') }).parse(request.body);

    const taskId = `task_ppt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task: TaskItem = { id: taskId, type: 'ppt', prompt: body.prompt, status: 'processing', createdAt: Date.now() };
    tasks.set(taskId, task);

    // Asynchronously execute agent prompt in gateway
    const messages = [{ role: 'user', content: `${PPT_PROMPT}\n\n用户需求: ${body.prompt}` }];
    (async () => {
      let content = '';
      try {
        for await (const res of execute({ model: body.model, messages, stream: false }, { kind: 'api' })) {
          if (res.item.type === 'message.delta') content += res.item.text;
        }
        task.status = 'completed';
        task.resultUrl = content;
      } catch (err) {
        task.status = 'failed';
      }
    })();

    return { task_id: taskId, status: 'processing', message: 'PPT可编辑文件生成任务已建立' };
  });

  app.post('/v1/psd/generations', async (request) => {
    const actor = principal(request);
    if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    const body = z.object({ prompt: z.string().min(1), model: z.string().default('gpt-4o') }).parse(request.body);

    const taskId = `task_psd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task: TaskItem = { id: taskId, type: 'psd', prompt: body.prompt, status: 'processing', createdAt: Date.now() };
    tasks.set(taskId, task);

    const messages = [{ role: 'user', content: `${PSD_PROMPT}\n\n用户需求: ${body.prompt}` }];
    (async () => {
      let content = '';
      try {
        for await (const res of execute({ model: body.model, messages, stream: false }, { kind: 'api' })) {
          if (res.item.type === 'message.delta') content += res.item.text;
        }
        task.status = 'completed';
        task.resultUrl = content;
      } catch {
        task.status = 'failed';
      }
    })();

    return { task_id: taskId, status: 'processing', message: 'PSD可编辑文件生成任务已建立' };
  });

  app.get('/v1/editable-file-tasks', async (request) => {
    const actor = principal(request);
    if (!actor) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
    return Array.from(tasks.values());
  });
}
