import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildPaymentTransaction, makeSigners, signTransaction } from './fixtures.js';
import { getJson, postJson, setupTestContext, teardownSharedDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});
afterAll(async () => {
  await teardownSharedDatabase();
});

interface Body {
  id?: string;
  status?: string;
  error?: string;
}

/**
 * Sets up an account with `weights`-weighted signers and creates a pending
 * request for a payment transaction from it.
 */
async function setupWithRequest(
  weights: number[],
  threshold: number,
  ttlSeconds?: number,
): Promise<{ requestId: string; signers: ReturnType<typeof makeSigners>; tx: ReturnType<typeof buildPaymentTransaction> }> {
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
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
  return { requestId: (created.body as { id: string }).id, signers, tx };
}

async function sign(requestId: string, signerPublicKey: string, signature: string): Promise<{ status: number; body: Body }> {
  const response = await postJson(ctx.app, `/requests/${requestId}/sign`, { signerPublicKey, signature });
  return response as unknown as { status: number; body: Body };
}

describe('POST /requests/:id/sign — validation', () => {
  it('accepts a valid signer signature', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1, 1], 2);
    const { status, body } = await sign(requestId, signers[0]!.publicKey, signTransaction(tx, signers[0]!.keypair));
    expect(status).toBe(200);
    expect(body.status).toBe('pending');

    const fetched = await getJson(ctx.app, `/requests/${requestId}`);
    const signatureState = fetched.body.signatureState as {
      signedWeight: number;
      signers: Array<{ key: string; signed: boolean; signedAt: string | null }>;
    };
    expect(signatureState.signedWeight).toBe(1);
    expect(signatureState.signers.find((signer) => signer.key === signers[0]!.publicKey)!.signed).toBe(true);
  });

  it('rejects a signer who is not on the account (network decides)', async () => {
    const { requestId, tx } = await setupWithRequest([1], 1);
    const outsider = makeSigners(1)[0]!;
    const { status, body } = await sign(requestId, outsider.publicKey, signTransaction(tx, outsider.keypair));
    expect(status).toBe(403);
    expect(body.error).toContain('not a current signer');
  });

  it('rejects a duplicate signature from the same signer (409, never overwrite)', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1, 1], 2);
    const signature = signTransaction(tx, signers[0]!.keypair);
    const first = await sign(requestId, signers[0]!.publicKey, signature);
    expect(first.status).toBe(200);
    const second = await sign(requestId, signers[0]!.publicKey, signature);
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('already signed');
  });

  it('rejects a signature that does not verify for the transaction', async () => {
    const { requestId } = await setupWithRequest([1], 1);
    const otherSigner = makeSigners(1)[0]!;
    // A cryptographically valid signature over a DIFFERENT transaction.
    const otherTx = buildPaymentTransaction(otherSigner.publicKey, otherSigner.publicKey);
    const signature = signTransaction(otherTx, otherSigner.keypair);
    const { status } = await sign(requestId, otherSigner.publicKey, signature);
    // Rejected at the cryptographic check (400), before any signer-membership check.
    expect(status).toBe(400);
  });

  it('rejects a signature from a signer key that does not match the signature', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1, 1], 2);
    const signature = signTransaction(tx, signers[0]!.keypair);
    // Claim to be signer #2 while submitting signer #1's signature.
    const { status } = await sign(requestId, signers[1]!.publicKey, signature);
    expect(status).toBe(400);
  });

  it('rejects a malformed signerPublicKey', async () => {
    const { requestId, tx } = await setupWithRequest([1], 1);
    const { status } = await sign(requestId, 'GARBAGE', signTransaction(tx, makeSigners(1)[0]!.keypair));
    expect(status).toBe(400);
  });

  it('rejects a signature that is not 64 bytes', async () => {
    const { requestId, signers } = await setupWithRequest([1], 1);
    const { status } = await sign(requestId, signers[0]!.publicKey, Buffer.alloc(32).toString('base64'));
    expect(status).toBe(400);
  });

  it('returns a uniform 404 for an unknown request id', async () => {
    await setupWithRequest([1], 1);
    const { status } = await sign('f'.repeat(32), makeSigners(1)[0]!.publicKey, Buffer.alloc(64).toString('base64'));
    expect(status).toBe(404);
  });

  it('returns a uniform 404 for an expired request', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1], 1, 60);
    // Force expiry with a maintenance run at a future instant.
    await ctx.store.markExpired(new Date(Date.now() + 3600 * 1000));
    const { status } = await sign(requestId, signers[0]!.publicKey, signTransaction(tx, signers[0]!.keypair));
    expect(status).toBe(404);
  });

  it('rejects signing after the request was already submitted', async () => {
    const { requestId, signers, tx } = await setupWithRequest([1], 1);
    const first = await sign(requestId, signers[0]!.publicKey, signTransaction(tx, signers[0]!.keypair));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('submitted');
    const second = await sign(requestId, signers[0]!.publicKey, signTransaction(tx, signers[0]!.keypair));
    expect(second.status).toBe(409);
  });
});
