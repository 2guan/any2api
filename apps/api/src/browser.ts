import { chromium, type Browser, type BrowserContext } from 'playwright';

export type BrowserCookie = { name: string; value: string; url?: string; domain?: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' };

class BrowserSupervisor {
  private browser: Browser | null = null;
  private contexts = new Map<string, { context: BrowserContext; active: number; idleTimer?: NodeJS.Timeout }>();

  async contextFor(accountId: string) {
    let slot = this.contexts.get(accountId);
    if (!slot) {
      if (!this.browser?.isConnected()) this.browser = await chromium.launch({ headless: true });
      slot = { context: await this.browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' }), active: 0 };
      this.contexts.set(accountId, slot);
    }
    slot.active++;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    return slot.context;
  }

  async prepare(accountId: string, cookies: BrowserCookie[] = [], storedValues: Record<string, string> = {}) {
    const context = await this.contextFor(accountId);
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
        void current.context.close();
      }
    }, 10 * 60_000);
  }

  async close() { await this.browser?.close(); this.contexts.clear(); }
}

export const browserSupervisor = new BrowserSupervisor();
