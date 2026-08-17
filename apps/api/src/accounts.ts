import { db } from './db.js';

export type Account = { id: string; provider: string; name: string; priority: number; max_concurrency: number; active_leases: number; success_ewma: number; latency_ewma_ms: number | null; cooldown_until: number | null };

export function leaseAccount(provider: string): Account | null {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Reset expired leases & uncool expired accounts
    db.prepare(`UPDATE provider_accounts SET active_leases = 0, lease_until = NULL WHERE lease_until IS NOT NULL AND lease_until <= ?`).run(now);
    db.prepare(`UPDATE provider_accounts SET status = 'ready', cooldown_until = NULL WHERE provider = ? AND status = 'cooling' AND cooldown_until IS NOT NULL AND cooldown_until <= ?`).run(provider, now);

    const account = db.prepare(`SELECT * FROM provider_accounts
      WHERE provider = ? AND status = 'ready' AND (cooldown_until IS NULL OR cooldown_until <= ?)
      AND active_leases < max_concurrency ORDER BY priority DESC, success_ewma DESC, latency_ewma_ms ASC NULLS FIRST, last_used_at ASC NULLS FIRST LIMIT 1`).get(provider, now) as Account | undefined;
    if (!account) { db.exec('COMMIT'); return null; }
    db.prepare('UPDATE provider_accounts SET active_leases = active_leases + 1, lease_until = ?, last_used_at = ?, updated_at = ? WHERE id = ?')
      .run(now + 120_000, now, now, account.id);
    db.exec('COMMIT');
    return account;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function releaseAccount(accountId: string, ok: boolean, latencyMs?: number, statusCode?: number, cooldownMs = 300_000) {
  const account = db.prepare('SELECT success_ewma, latency_ewma_ms FROM provider_accounts WHERE id = ?').get(accountId) as { success_ewma: number; latency_ewma_ms: number | null } | undefined;
  if (!account) return;
  const now = Date.now();
  const newEwma = account.success_ewma * 0.8 + (ok ? 1 : 0) * 0.2;
  const newLatency = latencyMs === undefined ? account.latency_ewma_ms : (account.latency_ewma_ms ?? latencyMs) * 0.8 + latencyMs * 0.2;
  
  const isRateLimitedOrError = !ok && (statusCode === 429 || statusCode === 401 || statusCode === 503 || newEwma < 0.3);
  const cooldownUntil = isRateLimitedOrError ? now + cooldownMs : null;
  const newStatus = isRateLimitedOrError ? 'cooling' : 'ready';

  db.prepare(`UPDATE provider_accounts SET active_leases = MAX(0, active_leases - 1), lease_until = NULL,
    status = CASE WHEN status IN ('action_required', 'disabled') THEN status ELSE ? END,
    cooldown_until = ?, success_ewma = ?, latency_ewma_ms = ?, updated_at = ? WHERE id = ?`).run(
    newStatus,
    cooldownUntil,
    newEwma,
    newLatency,
    now, accountId
  );
}
