import { chromium, type Browser, type BrowserContext } from 'playwright';

export type BrowserCookie = { name: string; value: string; url?: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' };

class BrowserSupervisor {
  private browser: Browser | null = null;
  private contexts = new Map<string, { context: BrowserContext; active: number; idleTimer?: NodeJS.Timeout }>();

  async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
      const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || undefined;
      this.browser = await chromium.launch({
        headless: true,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
        ],
        ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
      });
    }
    return this.browser;
  }

  async contextFor(accountId: string) {
    let slot = this.contexts.get(accountId);
    if (!slot) {
      const browser = await this.getBrowser();
      slot = { context: await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' }), active: 0 };
      this.contexts.set(accountId, slot);
    }
    slot.active++;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    return slot.context;
  }

  async prepare(accountId: string, cookies: BrowserCookie[] = [], storedValues: Record<string, string> = {}) {
    const context = await this.contextFor(accountId);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
      (window as unknown as { chrome?: unknown }).chrome = { runtime: {} };
    });
    if (cookies.length) await context.addCookies(cookies);
    if (Object.keys(storedValues).length) await context.addInitScript((entries) => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, storedValues);
    return context;
  }

  release(accountId: string) {
    const slot = this.contexts.get(accountId);
    if (!slot) return;
    slot.active = Math.max(0, slot.active - 1);
    if (slot.active) return;
    slot.idleTimer = setTimeout(() => {
      const current = this.contexts.get(accountId);
      if (current?.active === 0) {
        this.contexts.delete(accountId);
        void current.context.close().catch(() => {});
      }
    }, 10 * 60_000);
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.contexts.clear();
  }
}

export const browserSupervisor = new BrowserSupervisor();
