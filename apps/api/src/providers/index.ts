import { providers } from './registry.js';
import { KimiAdapter } from './kimi.js';
import { BrowserChatAdapter } from './browser-chat.js';

providers.register(new KimiAdapter());
providers.register(new BrowserChatAdapter('chatgpt', { url: 'https://chatgpt.com/', input: 'textarea, [contenteditable="true"]', answer: '[data-message-author-role="assistant"]', cookieDomain: '.chatgpt.com', cookieKey: 'session_cookie' }));
providers.register(new BrowserChatAdapter('deepseek', { url: 'https://chat.deepseek.com/', input: 'textarea, [contenteditable="true"]', answer: '.ds-markdown, [class*="markdown"]', cookieDomain: '.deepseek.com', tokenStorage: ['userToken', 'user_session'] }));
providers.register(new BrowserChatAdapter('glm', { url: 'https://www.chatglm.cn/', input: 'textarea, [contenteditable="true"]', answer: '[class*="markdown"], [class*="message"]', cookieDomain: '.chatglm.cn', tokenStorage: ['chatglm_token', 'token', 'access_token'] }));
providers.register(new BrowserChatAdapter('qwen', { url: 'https://chat.qwen.ai/', input: 'textarea, [contenteditable="true"]', answer: '[class*="markdown"], [class*="message"]', cookieDomain: '.qwen.ai', cookieKey: 'cookie' }));
providers.register(new BrowserChatAdapter('jimeng', { url: 'https://jimeng.jianying.com/ai-tool/generate/?type=image', input: 'textarea, [contenteditable="true"]', answer: 'img[src]', submit: 'button[class*="submit-button"]:not([disabled])', imageOutput: true, cookieDomain: '.jianying.com', cookieKey: 'cookie' }));
