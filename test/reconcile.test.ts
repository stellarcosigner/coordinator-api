/**
 * Covers reconciliation of 'submitted' requests left without a submission_hash
 * — the row shape a process crash between network submission and recording
 * success can leave behind (see src/reconcile.ts for why).
 *
 * There is no code path in this service that itself produces that row shape
 * (submission failures always revert to 'pending' — see submit.test.ts), so
 * these tests construct the ambiguous state directly via the same store API
 * the real claim path uses (store.tryClaimSubmission), which sets
 * status='submitted' without ever touching submission_hash. This is the
 * logical equivalent of the crash window, not a claim that an actual
 * process-kill was exercised.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/app.js';
import { retrySubmittableRequests } from '../src/submit.js';
import { reconcileSubmittedRequests } from '../src/reconcile.js';
import type { Logger } from '../src/types.js';
import { buildPaymentTransaction, makeSigners } from './fixtures.js';
import { postJson, setupTestContext, teardownSharedDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});
afterAll(async () => {
  await teardownSharedDatabase();
});

const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function depsOf(context: TestContext): AppDeps {
  return {
    config: context.config,
    store: context.store,
    accountGateway: context.accountGateway,
    submissionGateway: context.submissionGateway,
    transactionLookupGateway: context.transactionLookupGateway,
  };
}

/** Creates a pending request, then claims it straight to 'submitted' without ever
 *  recording a submission_hash — the exact ambiguous row shape reconciliation exists for. */
async function createAmbiguousSubmittedRequest(context: TestContext): Promise<{ id: string; txHash: string }> {
  const source = makeSigners(1)[0]!;
  context.accountGateway.setAccount(source.publicKey, { signers: [{ key: source.publicKey, weight: 1 }], threshold: 1 });
  const tx = buildPaymentTransaction(source.publicKey, source.publicKey);
  const created = await postJson(context.app, '/requests', {
    sourceAccount: source.publicKey,
    transactionXdr: tx.toXDR(),
    network: 'testnet',
  });
  const id = (created.body as { id: string }).id;

  const claimed = await context.store.tryClaimSubmission(id);
  expect(claimed).toBe(true);

  const row = await context.store.getRequest(id);
  expect(row!.status).toBe('submitted');
  expect(row!.submissionHash).toBeNull();
  return { id, txHash: row!.txHash };
}

describe('reconciliation of ambiguous submitted requests', () => {
  it('selects an ambiguous submitted row and confirms it on positive network confirmation', async () => {
    ctx = await setupTestContext();
    const { id, txHash } = await createAmbiguousSubmittedRequest(ctx);
    ctx.transactionLookupGateway.confirm(txHash, true);

    const result = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);

    expect(result.scanned).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(ctx.transactionLookupGateway.lookups).toEqual([{ hash: txHash, network: 'testnet' }]);

    const row = await ctx.store.getRequest(id);
    expect(row!.status).toBe('submitted');
    expect(row!.submissionHash).toBe(txHash);
  });

  it('does not repeatedly reconcile a row once confirmed', async () => {
    ctx = await setupTestContext();
    const { id, txHash } = await createAmbiguousSubmittedRequest(ctx);
    ctx.transactionLookupGateway.confirm(txHash, true);

    const first = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(first.confirmed).toBe(1);

    ctx.transactionLookupGateway.lookups.length = 0;
    const second = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(second.scanned).toBe(0);
    expect(second.confirmed).toBe(0);
    expect(ctx.transactionLookupGateway.lookups).toHaveLength(0);

    const row = await ctx.store.getRequest(id);
    expect(row!.submissionHash).toBe(txHash);
  });

  it('leaves the row unchanged on a temporary network/Horizon failure', async () => {
    ctx = await setupTestContext();
    await createAmbiguousSubmittedRequest(ctx);
    ctx.transactionLookupGateway.failWith(new Error('horizon is unreachable'));

    const result = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(result.confirmed).toBe(0);

    const [row] = await ctx.store.getSubmittedRequestsMissingSubmissionHash(10);
    expect(row).toBeDefined();
    expect(row!.status).toBe('submitted');
    expect(row!.submissionHash).toBeNull();
  });

  it('does not confirm from an uncertain lookup: not-found', async () => {
    ctx = await setupTestContext();
    const { id } = await createAmbiguousSubmittedRequest(ctx);
    // No confirm()/notFound() call: the fake defaults to "not found" for any unset hash.

    const result = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(result.confirmed).toBe(0);

    const row = await ctx.store.getRequest(id);
    expect(row!.status).toBe('submitted');
    expect(row!.submissionHash).toBeNull();
  });

  it('does not confirm from a found-but-unsuccessful transaction', async () => {
    ctx = await setupTestContext();
    const { id, txHash } = await createAmbiguousSubmittedRequest(ctx);
    ctx.transactionLookupGateway.confirm(txHash, false);

    const result = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(result.confirmed).toBe(0);

    const row = await ctx.store.getRequest(id);
    expect(row!.status).toBe('submitted');
    expect(row!.submissionHash).toBeNull();
  });

  it('does not interfere with normal pending retry behavior', async () => {
    ctx = await setupTestContext();
    // One ambiguous submitted row (reconciliation's target)...
    const { id: submittedId, txHash } = await createAmbiguousSubmittedRequest(ctx);
    ctx.transactionLookupGateway.confirm(txHash, true);

    // ...and one ordinary pending, unsigned row (retry's target — threshold not yet met).
    const source = makeSigners(1)[0]!;
    ctx.accountGateway.setAccount(source.publicKey, { signers: [{ key: source.publicKey, weight: 1 }], threshold: 1 });
    const tx = buildPaymentTransaction(source.publicKey, source.publicKey);
    const created = await postJson(ctx.app, '/requests', {
      sourceAccount: source.publicKey,
      transactionXdr: tx.toXDR(),
      network: 'testnet',
    });
    const pendingId = (created.body as { id: string }).id;

    const reconciled = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(reconciled.confirmed).toBe(1);
    // The pending row was never touched by reconciliation.
    expect(ctx.submissionGateway.submissions).toHaveLength(0);
    const stillPending = await ctx.store.getRequest(pendingId);
    expect(stillPending!.status).toBe('pending');

    const submittedCount = await retrySubmittableRequests(depsOf(ctx), noopLogger);
    expect(submittedCount).toBe(0); // no signatures recorded, threshold not met — retry correctly skips it

    const untouchedSubmittedRow = await ctx.store.getRequest(submittedId);
    expect(untouchedSubmittedRow!.submissionHash).toBe(txHash);
  });

  it('bounds reconciliation to the configured batch size', async () => {
    ctx = await setupTestContext({ reconciliationBatchSize: 2 });
    const hashes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { txHash } = await createAmbiguousSubmittedRequest(ctx);
      hashes.push(txHash);
    }
    for (const hash of hashes) ctx.transactionLookupGateway.confirm(hash, true);

    const result = await reconcileSubmittedRequests(depsOf(ctx), noopLogger);
    expect(result.scanned).toBe(2);
    expect(result.confirmed).toBe(2);
  });

  it('cannot corrupt state under concurrent reconciliation attempts', async () => {
    ctx = await setupTestContext();
    const { id, txHash } = await createAmbiguousSubmittedRequest(ctx);

    const [first, second] = await Promise.all([
      ctx.store.recordReconciledSubmissionHash(id, txHash),
      ctx.store.recordReconciledSubmissionHash(id, txHash),
    ]);
    // Exactly one of the two concurrent writers applies the update.
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const row = await ctx.store.getRequest(id);
    expect(row!.submissionHash).toBe(txHash);

    // A write attempted after the row is already reconciled is also a no-op.
    const third = await ctx.store.recordReconciledSubmissionHash(id, txHash);
    expect(third).toBe(false);
  });
});
