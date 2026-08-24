import { db } from '../db.js';
import { providers } from '../providers/registry.js';
import type { Account } from '../accounts.js';

let refreshTimer: NodeJS.Timeout | null = null;
let isRunning = false;

export async function runTokenRefreshCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const activeAccounts = db.prepare(
      "SELECT id, provider, name, status, priority, created_at, updated_at FROM provider_accounts WHERE status = 'active'"
    ).all() as Account[];

    for (const account of activeAccounts) {
      try {
        const adapter = providers.get(account.provider);
        if (adapter && typeof adapter.refreshCredentials === 'function') {
          await adapter.refreshCredentials(account);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Suppress expected warnings (e.g. when only short-lived token without refresh_token is configured)
        if (process.env.DEBUG || process.env.LOG_LEVEL === 'debug') {
          console.debug(`[TokenRefresher] Notice on ${account.provider} (${account.name}): ${msg}`);
        }
      }
    }
  } catch (err) {
    console.error('[TokenRefresher] Unexpected error during token refresh cycle:', err);
  } finally {
    isRunning = false;
  }
}

export function startTokenRefresher(intervalMs = 5 * 60 * 1000): void {
  if (refreshTimer) return;
  // Initial run after short warmup delay (5 seconds)
  setTimeout(() => {
    runTokenRefreshCycle().catch(() => {});
  }, 5000);

  // Periodic interval (default 5 minutes)
  refreshTimer = setInterval(() => {
    runTokenRefreshCycle().catch(() => {});
  }, intervalMs);

  console.info(`[TokenRefresher] Background token refresher started (interval: ${Math.round(intervalMs / 1000)}s)`);
}

export function stopTokenRefresher(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    console.info('[TokenRefresher] Background token refresher stopped');
  }
}
