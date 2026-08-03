import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { retrySubmittableRequests } from '../src/submit.js';
import { parseTransaction } from '../src/transaction.js';
import type { Logger } from '../src/types.js';
import { buildPaymentTransaction, makeSigners, signTransaction, type SignerFixture } from './fixtures.js';
import { getJson, postJson, setupTestContext, teardownSharedDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});
afterAll(async () => {
  await teardownSharedDatabase();
});

const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function setupWithRequest(
  weights: number[],
  threshold: number,
): Promise<{ requestId: string; source: string; signers: SignerFixture[]; tx: ReturnType<typeof buildPaymentTransaction> }> {
  ctx = await setupTestContext();
  const source = makeSigners(1)[0]!;
  const signers = makeSigners(weights.length);
  ctx.accountGateway.setAccount(source.publicKey, {
    signers: weights.map((weight, index) => ({ key: signers[index]!.publicKey, weight })),
    threshold,
  });
  const tx = buildPaymentTransaction(source.publicKey, signers[0]!.publicKey);
  const created = await postJson(ctx.app, '/requests', {
    sourceAccount: source.publicKey,
    transactionXdr: tx.toXDR(),
    network: 'testnet',
  });
  return { requestId: (created.body as { id: string }).id, source: source.publicKey, signers, tx };
}

async function sign(requestId: string, signer: SignerFixture, tx: ReturnType<typeof buildPaymentTransaction>): Promise<number> {
  const response = await postJson(ctx.app, `/requests/${requestId}/sign`, {
    signerPublicKey: signer.publicKey,
    signature: signTransaction(tx, signer.keypair),
  });
  return response.status;
}

/** Asserts the submitted envelope carries exactly `signers` valid signatures over the tx hash. */
function expectValidSubmissionEnvelope(xdr: string, signers: SignerFixture[]): void {
  const transaction = parseTransaction(xdr, 'testnet');
  const hash = transaction.hash();
  expect(transaction.signatures).toHaveLength(signers.length);
  for (const decorated of transaction.signatures) {
    const signature = decorated.signature();
    const verified = signers.some((signer) => signer.keypair.verify(hash, signature));
    expect(verified, 'each attached signature must verify under one of the recorded signer keys').toBe(true);
  }
}

describe('threshold-met auto-submission', () => {
  it('submits once the second of two signers signs (2-of-2)', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1, 1], 2);

    const firstStatus = await sign(requestId, signers[0]!, tx);
    expect(firstStatus).toBe(200);
    expect(ctx.submissionGateway.submissions).toHaveLength(0);

    const secondStatus = await sign(requestId, signers[1]!, tx);
    expect(secondStatus).toBe(200);
    expect(ctx.submissionGateway.submissions).toHaveLength(1);

    const fetched = await getJson(ctx.app, `/requests/${requestId}`);
    expect(fetched.body.status).toBe('submitted');
    expectValidSubmissionEnvelope(ctx.submissionGateway.submissions[0]!.xdr, [signers[0]!, signers[1]!]);
  });

  it('submits immediately when a single signer meets the threshold', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1], 1);
    const status = await sign(requestId, signers[0]!, tx);
    expect(status).toBe(200);
    expect(ctx.submissionGateway.submissions).toHaveLength(1);
  });

  it('weighs signatures against the account’s CURRENT live state, not the state at creation', async () => {
    const { requestId, source, signers, tx } = await setupWithRequest([1, 1], 2);

    await sign(requestId, signers[0]!, tx);
    expect(ctx.submissionGateway.submissions).toHaveLength(0);

    // The account changed on-chain: signer 0 removed, signer 1's weight is now 2.
    ctx.accountGateway.setAccount(source, {
      signers: [{ key: signers[1]!.publicKey, weight: 2 }],
      threshold: 2,
    });

    const status = await sign(requestId, signers[1]!, tx);
    expect(status).toBe(200);
    expect(ctx.submissionGateway.submissions).toHaveLength(1);
    expectValidSubmissionEnvelope(ctx.submissionGateway.submissions[0]!.xdr, [signers[0]!, signers[1]!]);
  });

  it('reverts to pending when submission fails, then the background job retries successfully', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1, 1], 2);

    await sign(requestId, signers[0]!, tx);
    ctx.submissionGateway.failWith(new Error('horizon is down'));

    const secondStatus = await sign(requestId, signers[1]!, tx);
    expect(secondStatus).toBe(200);
    // Submission was attempted but failed → reverted to pending.
    expect(ctx.submissionGateway.submissions).toHaveLength(1);
    const afterFailure = await getJson(ctx.app, `/requests/${requestId}`);
    expect(afterFailure.body.status).toBe('pending');
    const row = await ctx.store.getRequest(requestId);
    expect(row!.submitAttempts).toBe(1);

    const submitted = await retrySubmittableRequests(
      {
        config: ctx.config,
        store: ctx.store,
        accountGateway: ctx.accountGateway,
        submissionGateway: ctx.submissionGateway,
      },
      noopLogger,
    );
    expect(submitted).toBe(1);
    expect(ctx.submissionGateway.submissions).toHaveLength(2);
    expectValidSubmissionEnvelope(ctx.submissionGateway.submissions[1]!.xdr, [signers[0]!, signers[1]!]);

    const afterRetry = await getJson(ctx.app, `/requests/${requestId}`);
    expect(afterRetry.body.status).toBe('submitted');
  });

  it('never retries a request whose signatures do not meet the threshold', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1, 1], 2);
    await sign(requestId, signers[0]!, tx);

    const submitted = await retrySubmittableRequests(
      {
        config: ctx.config,
        store: ctx.store,
        accountGateway: ctx.accountGateway,
        submissionGateway: ctx.submissionGateway,
      },
      noopLogger,
    );
    expect(submitted).toBe(0);
    expect(ctx.submissionGateway.submissions).toHaveLength(0);
  });
});
