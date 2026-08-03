/**
 * Background expiry maintenance.
 *
 * Requests past their TTL are SOFT-expired (status 'expired') — never hard
 * deleted immediately — so the record exists for a retention window before the
 * row is removed (config.expiredRetentionSeconds, default 30 days). Note that
 * the API already treats expired requests identically to never-existing ones
 * (404), so the retention window is for record-keeping/audit, not public
 * visibility. 'submitted' requests never expire.
 */
import type { AppDeps } from './app.js';
import type { Logger } from './types.js';

export interface ExpiryMaintenanceResult {
  expired: number;
  deleted: number;
}

export async function runExpiryMaintenance(deps: AppDeps, log: Logger): Promise<ExpiryMaintenanceResult> {
  const expired = await deps.store.markExpired(new Date());
  const cutoff = new Date(Date.now() - deps.config.expiredRetentionSeconds * 1000);
  const deleted = await deps.store.deleteExpiredBefore(cutoff);

  if (expired > 0 || deleted > 0) {
    log.info({ expired, deleted }, 'expiry maintenance: soft-expired and hard-deleted rows');
  }
  return { expired, deleted };
}
