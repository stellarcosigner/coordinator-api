import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runExpiryMaintenance } from '../src/expire.js';
import type { Logger } from '../src/types.js';
import { buildPaymentTransaction, makeSigners, signTransaction } from './fixtures.js';
import { getJson, postJson, setupTestContext, teardownSharedDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});
afterAll(async () => {
  await teardownSharedDatabase();
});

const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Sets up a single-signer account and creates a pending request; returns {id, signer, tx, source}. */
async function setupWithPendingRequest(ttlSeconds = 60): Promise<{
  id: string;
  source: string;
  signer: ReturnType<typeof makeSigners>[number];
  tx: ReturnType<typeof buildPaymentTransaction>;
}> {
  ctx = await setupTestContext();
  const source = makeSigners(1)[0]!;
  const signer = makeSigners(1)[0]!;
  ctx.accountGateway.setAccount(source.publicKey, { signers: [{ key: signer.publicKey, weight: 1 }], threshold: 1 });
  const tx = buildPaymentTransaction(source.publicKey, signer.publicKey);
  const created = await postJson(ctx.app, '/requests', {
    sourceAccount: source.publicKey,
    transactionXdr: tx.toXDR(),
    network: 'testnet',
    ttlSeconds,
  });
  return { id: (created.body as { id: string }).id, source: source.publicKey, signer, tx };
}

describe('expiry behavior', () => {
  it('soft-expires pending requests past their TTL; GET and sign return a uniform 404', async () => {
    const { id, signer, tx } = await setupWithPendingRequest();

    const expired = await ctx.store.markExpired(new Date(Date.now() + 3600 * 1000));
    expect(expired).toBe(1);

    const fetched = await getJson(ctx.app, `/requests/${id}`);
    expect(fetched.status).toBe(404);

    const signed = await postJson(ctx.app, `/requests/${id}/sign`, {
      signerPublicKey: signer.publicKey,
      signature: signTransaction(tx, signer.keypair),
    });
    expect(signed.status).toBe(404);

    // The row still exists (soft-deleted only).
    expect(await ctx.store.getRequest(id)).not.toBeNull();
  });

  it('never expires submitted requests', async () => {
    const { id, signer, tx } = await setupWithPendingRequest();
    await postJson(ctx.app, `/requests/${id}/sign`, {
      signerPublicKey: signer.publicKey,
      signature: signTransaction(tx, signer.keypair),
    });

    const expired = await ctx.store.markExpired(new Date(Date.now() + 3600 * 1000));
    expect(expired).toBe(0);

    const fetched = await getJson(ctx.app, `/requests/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe('submitted');
  });

  it('retains expired rows until the retention window, then hard-deletes them', async () => {
    const { id } = await setupWithPendingRequest();
    await ctx.store.markExpired(new Date(Date.now() + 3600 * 1000));
    expect(await ctx.store.getRequest(id)).not.toBeNull();

    const deleted = await ctx.store.deleteExpiredBefore(new Date(Date.now() + 2 * 3600 * 1000));
    expect(deleted).toBe(1);
    expect(await ctx.store.getRequest(id)).toBeNull();

    // Same uniform 404 after hard deletion.
    const fetched = await getJson(ctx.app, `/requests/${id}`);
    expect(fetched.status).toBe(404);
  });

  it('does not hard-delete rows that are still within their retention window', async () => {
    const { id } = await setupWithPendingRequest();
    const deleted = await ctx.store.deleteExpiredBefore(new Date(Date.now() + 3600 * 1000));
    expect(deleted).toBe(0);
    expect(await ctx.store.getRequest(id)).not.toBeNull();
  });

  it('the background maintenance pass soft-expires and hard-deletes per retention', async () => {
    const { id } = await setupWithPendingRequest();
    ctx.config.expiredRetentionSeconds = 1;

    // Nothing expired yet: the request's TTL is 60s in the future.
    const early = await runExpiryMaintenance(
      { config: ctx.config, store: ctx.store, accountGateway: ctx.accountGateway, submissionGateway: ctx.submissionGateway },
      noopLogger,
    );
    expect(early.expired).toBe(0);
    expect(early.deleted).toBe(0);

    // Backdate the request so it is both expired and past its retention window.
    const pool = new Pool({ connectionString: ctx.databaseUrl });
    await pool.query(
      `UPDATE pending_requests
       SET expires_at = now() - interval '1 hour', created_at = now() - interval '2 hours'
       WHERE id = $1`,
      [id],
    );
    await pool.end();

    const result = await runExpiryMaintenance(
      { config: ctx.config, store: ctx.store, accountGateway: ctx.accountGateway, submissionGateway: ctx.submissionGateway },
      noopLogger,
    );
    expect(result.expired).toBe(1);
    expect(result.deleted).toBe(1);
    expect(await ctx.store.getRequest(id)).toBeNull();
  });
});
