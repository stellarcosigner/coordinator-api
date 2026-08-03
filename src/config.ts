/**
 * Environment-driven configuration. Every value has a documented default;
 * see .env.example for the full list.
 */

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  testnetHorizonUrl: string;
  mainnetHorizonUrl: string;
  /** Default time-to-live for a pending request when the client does not specify one (seconds). Default: 7 days. */
  defaultTtlSeconds: number;
  /** Upper bound on client-supplied TTL (seconds). Default: 30 days. */
  maxTtlSeconds: number;
  /** How often the background job runs (ms). Default: 15 minutes. */
  expireJobIntervalMs: number;
  /** How long an expired request row is retained before hard deletion (seconds). Default: 30 days. */
  expiredRetentionSeconds: number;
  /** Max network submission attempts per request before giving up. Default: 5. */
  maxSubmitAttempts: number;
  /** Allowed CORS origins (empty = CORS disabled). */
  corsOrigin: string[];
}

const DEFAULTS = {
  host: '0.0.0.0',
  port: 3000,
  logLevel: 'info',
  databaseUrl: 'postgres://coordinator:coordinator@localhost:5432/coordinator',
  testnetHorizonUrl: 'https://horizon-testnet.stellar.org',
  mainnetHorizonUrl: 'https://horizon.stellar.org',
  defaultTtlSeconds: 7 * 24 * 60 * 60,
  maxTtlSeconds: 30 * 24 * 60 * 60,
  expireJobIntervalMs: 15 * 60 * 1000,
  expiredRetentionSeconds: 30 * 24 * 60 * 60,
  maxSubmitAttempts: 5,
};

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const corsOrigin = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    host: env.HOST ?? DEFAULTS.host,
    port: parsePositiveInt(env.PORT, DEFAULTS.port, 'PORT'),
    logLevel: env.LOG_LEVEL ?? DEFAULTS.logLevel,
    databaseUrl: env.DATABASE_URL ?? DEFAULTS.databaseUrl,
    testnetHorizonUrl: env.TESTNET_HORIZON_URL ?? DEFAULTS.testnetHorizonUrl,
    mainnetHorizonUrl: env.MAINNET_HORIZON_URL ?? DEFAULTS.mainnetHorizonUrl,
    defaultTtlSeconds: parsePositiveInt(env.DEFAULT_TTL_SECONDS, DEFAULTS.defaultTtlSeconds, 'DEFAULT_TTL_SECONDS'),
    maxTtlSeconds: parsePositiveInt(env.MAX_TTL_SECONDS, DEFAULTS.maxTtlSeconds, 'MAX_TTL_SECONDS'),
    expireJobIntervalMs: parsePositiveInt(env.EXPIRE_JOB_INTERVAL_MS, DEFAULTS.expireJobIntervalMs, 'EXPIRE_JOB_INTERVAL_MS'),
    expiredRetentionSeconds: parsePositiveInt(
      env.EXPIRED_RETENTION_SECONDS,
      DEFAULTS.expiredRetentionSeconds,
      'EXPIRED_RETENTION_SECONDS',
    ),
    maxSubmitAttempts: parsePositiveInt(env.MAX_SUBMIT_ATTEMPTS, DEFAULTS.maxSubmitAttempts, 'MAX_SUBMIT_ATTEMPTS'),
    corsOrigin,
  };
}
