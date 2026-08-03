/**
 * Test harness.
 *
 * Each test FILE (one vitest worker) shares a single throwaway Postgres
 * database; tables are truncated between tests. Test files get unique database
 * names so parallel workers never clash. The Stellar network is simulated with
 * fake gateways: the account gateway decides who is a signer, and the
 * submission gateway records what would have been submitted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NotFoundError } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, Store } from '../src/store.js';
import type { AccountGateway, AccountState, NetworkName, SubmissionGateway, SubmissionResult } from '../src/types.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

export class FakeAccountGateway implements AccountGateway {
  private readonly accounts = new Map<string, AccountState>();
  private failure: Error | null = null;
  readonly fetchCalls: Array<{ sourceAccount: string; network: NetworkName }> = [];

  setAccount(sourceAccount: string, state: AccountState): void {
    this.accounts.set(sourceAccount, state);
  }

  /** Simulates the account being merged away / deleted on-chain. */
  removeAccount(sourceAccount: string): void {
    this.accounts.delete(sourceAccount);
  }

  failWith(error: Error): void {
    this.failure = error;
  }

  async fetchAccountState(sourceAccount: string, network: NetworkName): Promise<AccountState> {
    this.fetchCalls.push({ sourceAccount, network });
    if (this.failure) throw this.failure;
    const state = this.accounts.get(sourceAccount);
    if (!state) throw new NotFoundError(`account ${sourceAccount} not found on the test network`, { status: 404 });
    return state;
  }
}

export class FakeSubmissionGateway implements SubmissionGateway {
  readonly submissions: Array<{ xdr: string; network: NetworkName }> = [];
  private failure: Error | null = null;

  failWith(error: Error): void {
    this.failure = error;
  }

  async submitTransaction(signedEnvelopeXdr: string, network: NetworkName): Promise<SubmissionResult> {
    this.submissions.push({ xdr: signedEnvelopeXdr, network });
    if (this.failure) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    return { hash: createHash('sha256').update(signedEnvelopeXdr).digest('hex') };
  }
}

export interface TestContext {
  app: FastifyInstance;
  store: Store;
  config: Config;
  databaseUrl: string;
  accountGateway: FakeAccountGateway;
  submissionGateway: FakeSubmissionGateway;
  cleanup: () => Promise<void>;
}

/** One database per test file (per worker process), truncated between tests. */
let sharedDb: { name: string; url: string } | null = null;

async function getSharedDatabase(): Promise<{ name: string; url: string }> {
  if (sharedDb) return sharedDb;
  const name = `coordinator_test_${randomBytes(6).toString('hex')}`;
  const adminPool = new Pool({ connectionString: ADMIN_URL });
  await adminPool.query(`CREATE DATABASE "${name}"`);
  await adminPool.end();
  sharedDb = { name, url: `postgres://postgres:postgres@localhost:5433/${name}` };
  return sharedDb;
}

export async function teardownSharedDatabase(): Promise<void> {
  if (!sharedDb) return;
  const pool = new Pool({ connectionString: ADMIN_URL });
  await pool.query(`DROP DATABASE IF EXISTS "${sharedDb.name}"`);
  await pool.end();
  sharedDb = null;
}

export async function setupTestContext(overrides?: Partial<Config>): Promise<TestContext> {
  const db = await getSharedDatabase();
  const store = new Store(createPool(db.url));
  const config: Config = {
    ...loadConfig({ ...process.env, DATABASE_URL: db.url, LOG_LEVEL: 'silent' }),
    ...overrides,
  };

  const accountGateway = new FakeAccountGateway();
  const submissionGateway = new FakeSubmissionGateway();
  const app = await buildApp({ config, store, accountGateway, submissionGateway });

  // Fresh state for this test.
  const pool = new Pool({ connectionString: db.url });
  await pool.query('TRUNCATE pending_requests, signatures RESTART IDENTITY CASCADE');
  await pool.end();

  const cleanup = async (): Promise<void> => {
    await app.close();
    await store.close();
  };

  return { app, store, config, databaseUrl: db.url, accountGateway, submissionGateway, cleanup };
}

export async function postJson(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url,
    payload: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

export async function getJson(
  app: FastifyInstance,
  url: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}
