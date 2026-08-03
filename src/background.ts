/**
 * Background job scheduler. Runs once at startup, then on a fixed interval
 * (config.expireJobIntervalMs, default 15 minutes). Responsibilities:
 *  - retry network submission for requests whose threshold is met (submit.ts)
 *  - mark expired requests and hard-delete old ones (expire.ts)
 */
import type { AppDeps } from './app.js';
import { retrySubmittableRequests } from './submit.js';
import { runExpiryMaintenance } from './expire.js';
import type { Logger } from './types.js';

export function startBackgroundJobs(deps: AppDeps, log: Logger): () => void {
  const run = async (): Promise<void> => {
    try {
      const { expired, deleted } = await runExpiryMaintenance(deps, log);
      const submitted = await retrySubmittableRequests(deps, log);
      log.info({ expired, deleted, submitted }, 'background job pass complete');
    } catch (error) {
      // A failing pass must never kill the interval.
      log.error({ err: error }, 'background job failed');
    }
  };

  void run();
  const timer = setInterval(() => void run(), deps.config.expireJobIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
