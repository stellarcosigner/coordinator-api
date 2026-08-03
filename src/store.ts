/**
 * Postgres access layer: pool creation, migration runner, and every query the
 * service needs. All queries are parameterized; no SQL is ever built from
 * client input.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { NetworkName, RequestStatus, StoredSignature } from './types.js';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export interface PendingRequestRow {
  id: string;
  sourceAccount: string;
  network: NetworkName;
  transactionXdr: string;
  txHash: string;
  status: RequestStatus;
  submitAttempts: number;
  lastSubmitError: string | null;
  createdAt: string;
  expiresAt: string;
  submittedAt: string | null;
}

export interface CreateRequestInput {
  id: string;
  sourceAccount: string;
  network: NetworkName;
  transactionXdr: string;
  txHash: string;
  expiresAt: Date;
}

export interface RecordSignatureResult {
  status: RequestStatus;
  /** true when this signature pushed the request to threshold and claimed submission */
  claimed: boolean;
  signedWeight: number;
}

export class RequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`request not found: ${requestId}`);
    this.name = 'RequestNotFoundError';
  }
}

export class RequestExpiredError extends Error {
  constructor(requestId: string) {
    super(`request has expired: ${requestId}`);
    this.name = 'RequestExpiredError';
  }
}

export class RequestAlreadySubmittedError extends Error {
  constructor(requestId: string) {
    super(`request already submitted: ${requestId}`);
    this.name = 'RequestAlreadySubmittedError';
  }
}

export class DuplicateSignatureError extends Error {
  constructor(requestId: string, signerPublicKey: string) {
    super(`signer has already signed this request: ${signerPublicKey} (request ${requestId})`);
    this.name = 'DuplicateSignatureError';
  }
}

interface RequestRowShape {
  id: string;
  source_account: string;
  network: NetworkName;
  transaction_xdr: string;
  tx_hash: string;
  status: RequestStatus;
  submit_attempts: number;
  last_submit_error: string | null;
  created_at: Date;
  expires_at: Date;
  submitted_at: Date | null;
}

interface SignatureRowShape {
  request_id: string;
  signer_public_key: string;
  signature: string;
  weight: number;
  created_at: Date;
}

function mapRequest(row: RequestRowShape): PendingRequestRow {
  return {
    id: row.id,
    sourceAccount: row.source_account,
    network: row.network,
    transactionXdr: row.transaction_xdr,
    txHash: row.tx_hash,
    status: row.status,
    submitAttempts: row.submit_attempts,
    lastSubmitError: row.last_submit_error,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
  };
}

function mapSignature(row: SignatureRowShape): StoredSignature {
  return {
    signerPublicKey: row.signer_public_key,
    signature: row.signature,
    weight: row.weight,
    createdAt: row.created_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export class Store {
  constructor(private readonly pool: Pool) {}

  /** Applies pending SQL migrations in order, tracked in schema_migrations. Idempotent. */
  async migrate(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await this.pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if ((applied.rowCount ?? 0) > 0) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        // Idempotent even if two instances boot and apply the same migration concurrently.
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Connection may already be broken; original error matters more.
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async createRequest(input: CreateRequestInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_requests (id, source_account, network, transaction_xdr, tx_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.sourceAccount, input.network, input.transactionXdr, input.txHash, input.expiresAt],
    );
  }

  async getRequest(id: string): Promise<PendingRequestRow | null> {
    const result = await this.pool.query<RequestRowShape>('SELECT * FROM pending_requests WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? mapRequest(row) : null;
  }

  async getRequestSignatures(requestId: string): Promise<StoredSignature[]> {
    const result = await this.pool.query<SignatureRowShape>(
      'SELECT * FROM signatures WHERE request_id = $1 ORDER BY created_at, signer_public_key',
      [requestId],
    );
    return result.rows.map(mapSignature);
  }

  async requestHasSignature(requestId: string, signerPublicKey: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM signatures WHERE request_id = $1 AND signer_public_key = $2',
      [requestId, signerPublicKey],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Records a signature and, if the account's real threshold is now met, claims
   * the request for submission. All in one transaction so two signers hitting
   * the threshold simultaneously cannot both claim submission. Additive-only:
   * an existing signature row for the same signer yields DuplicateSignatureError.
   *
   * @param signerWeights current per-key weights from the live network state
   */
  async recordSignatureAndMaybeClaim(
    requestId: string,
    signature: Omit<StoredSignature, 'createdAt'>,
    threshold: number,
    signerWeights: ReadonlyMap<string, number>,
  ): Promise<RecordSignatureResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const reqResult = await client.query<RequestRowShape>(
        'SELECT * FROM pending_requests WHERE id = $1 FOR UPDATE',
        [requestId],
      );
      const req = reqResult.rows[0];
      if (!req) throw new RequestNotFoundError(requestId);
      if (req.status === 'expired') throw new RequestExpiredError(requestId);
      if (req.status === 'submitted') throw new RequestAlreadySubmittedError(requestId);

      try {
        await client.query(
          `INSERT INTO signatures (request_id, signer_public_key, signature, weight)
           VALUES ($1, $2, $3, $4)`,
          [requestId, signature.signerPublicKey, signature.signature, signature.weight],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateSignatureError(requestId, signature.signerPublicKey);
        }
        throw error;
      }

      const sigResult = await client.query<{ signer_public_key: string }>(
        'SELECT signer_public_key FROM signatures WHERE request_id = $1',
        [requestId],
      );
      const signedKeys = sigResult.rows.map((row) => row.signer_public_key);
      const signedWeight = signedKeys.reduce((sum, key) => sum + (signerWeights.get(key) ?? 0), 0);

      let status: RequestStatus = 'pending';
      let claimed = false;
      if (signedWeight >= threshold) {
        const update = await client.query(
          `UPDATE pending_requests SET status = 'submitted', submitted_at = now()
           WHERE id = $1 AND status = 'pending' RETURNING status`,
          [requestId],
        );
        if ((update.rowCount ?? 0) > 0) {
          status = 'submitted';
          claimed = true;
        }
      }

      await client.query('COMMIT');
      return { status, claimed, signedWeight };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failures
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Marks pending requests whose TTL has passed as expired. Soft-delete only. */
  async markExpired(now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE pending_requests SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  /** Hard-deletes expired rows whose retention window has passed. */
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM pending_requests WHERE status = 'expired' AND expires_at <= $1`,
      [cutoff],
    );
    return result.rowCount ?? 0;
  }

  /** Pending, not-yet-expired requests that may still be submitted (attempts left). */
  async getPendingRequestsForRetry(now: Date, maxSubmitAttempts: number): Promise<PendingRequestRow[]> {
    const result = await this.pool.query<RequestRowShape>(
      `SELECT * FROM pending_requests
       WHERE status = 'pending' AND expires_at > $1 AND submit_attempts < $2
       ORDER BY created_at`,
      [now, maxSubmitAttempts],
    );
    return result.rows.map(mapRequest);
  }

  /** Atomically claims a pending request for submission. Returns false if already claimed. */
  async tryClaimSubmission(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE pending_requests SET status = 'submitted', submitted_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING 1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordSubmitFailure(id: string, errorMessage: string, attempts: number): Promise<void> {
    await this.pool.query(
      `UPDATE pending_requests
       SET status = 'pending', submitted_at = NULL, submit_attempts = $2, last_submit_error = $3
       WHERE id = $1`,
      [id, attempts, errorMessage.slice(0, 2000)],
    );
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
