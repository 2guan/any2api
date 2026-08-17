import { providers } from './registry.js';
import { KimiAdapter } from './kimi.js';
import { ChatGPTAdapter } from './chatgpt.js';
import { DeepSeekAdapter } from './deepseek.js';
import { GLMAdapter } from './glm.js';
import { QwenAdapter } from './qwen.js';
import { JimengAdapter } from './jimeng.js';

providers.register(new KimiAdapter());
providers.register(new ChatGPTAdapter());
providers.register(new DeepSeekAdapter());
providers.register(new GLMAdapter());
providers.register(new QwenAdapter());
providers.register(new JimengAdapter());
