import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  buildMixedOperationsTransaction,
  buildPaymentTransaction,
  buildSetOptionsTransaction,
  makeSigners,
} from './fixtures.js';
import { getJson, postJson, setupTestContext, teardownSharedDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.cleanup();
});
afterAll(async () => {
  await teardownSharedDatabase();
});

interface CreateResponse {
  id?: string;
  error?: string;
}

async function createRequest(overrides?: Record<string, unknown>): Promise<{ status: number; body: CreateResponse }> {
  return postJson(ctx.app, '/requests', {
    sourceAccount: ctxSource,
    transactionXdr: ctxTx.toXDR(),
    network: 'testnet',
    ...overrides,
  }) as unknown as Promise<{ status: number; body: CreateResponse }>;
}

let ctxSource: string;
let ctxTx: ReturnType<typeof buildPaymentTransaction>;
let ctxSignerKeys: string[];

async function setup(weights: number[], threshold: number): Promise<void> {
  ctx = await setupTestContext();
  const source = makeSigners(1);
  ctxSource = source[0]!.publicKey;
  const signers = makeSigners(weights.length);
  ctxSignerKeys = signers.map((signer) => signer.publicKey);
  ctx.accountGateway.setAccount(ctxSource, {
    signers: weights.map((weight, index) => ({ key: ctxSignerKeys[index]!, weight })),
    threshold,
  });
  ctxTx = buildPaymentTransaction(ctxSource, signers[0]!.publicKey);
}

describe('POST /requests — creation validation', () => {
  it('creates a request and returns only the unguessable id', async () => {
    await setup([1, 1], 2);
    const { status, body } = await createRequest();
    expect(status).toBe(201);
    expect(Object.keys(body)).toEqual(['id']);
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects an implausible sourceAccount', async () => {
    await setup([1], 1);
    const { status } = await createRequest({ sourceAccount: 'not-a-stellar-address' });
    expect(status).toBe(400);
  });

  it('rejects an unsupported network', async () => {
    await setup([1], 1);
    const { status } = await createRequest({ network: 'futurist' });
    expect(status).toBe(400);
  });

  it('rejects malformed transaction XDR', async () => {
    await setup([1], 1);
    const { status } = await createRequest({ transactionXdr: 'definitely-not-xdr' });
    expect(status).toBe(400);
  });

  it('rejects a transaction whose source differs from sourceAccount', async () => {
    await setup([1], 1);
    const otherAccount = makeSigners(1)[0]!.publicKey;
    const foreignTx = buildPaymentTransaction(otherAccount, ctxSignerKeys[0]!);
    const { status } = await createRequest({ transactionXdr: foreignTx.toXDR() });
    expect(status).toBe(400);
  });

  it('rejects a source account that does not exist on the network', async () => {
    ctx = await setupTestContext();
    ctxSource = makeSigners(1)[0]!.publicKey;
    ctxTx = buildPaymentTransaction(ctxSource, makeSigners(1)[0]!.publicKey);
    // No account state registered in the fake gateway → NotFoundError.
    const { status } = await createRequest();
    expect(status).toBe(400);
  });

  it('returns 502 when the network is unreachable', async () => {
    await setup([1], 1);
    ctx.accountGateway.failWith(new Error('horizon unreachable'));
    const { status } = await createRequest();
    expect(status).toBe(502);
  });

  it('rejects a ttlSeconds above the configured maximum', async () => {
    await setup([1], 1);
    const max = ctx.config.maxTtlSeconds;
    const { status } = await createRequest({ ttlSeconds: max + 1 });
    expect(status).toBe(400);
  });

  it('rejects a ttlSeconds below the schema minimum', async () => {
    await setup([1], 1);
    const { status } = await createRequest({ ttlSeconds: 10 });
    expect(status).toBe(400);
  });

  it('honors a custom ttlSeconds for the expiry time', async () => {
    await setup([1], 1);
    const before = Date.now();
    const { status, body } = await createRequest({ ttlSeconds: 3600 });
    expect(status).toBe(201);
    const row = await ctx.store.getRequest(body.id!);
    const expiresAt = Date.parse(row!.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 2000);
    expect(expiresAt).toBeLessThanOrEqual(before + 3600 * 1000 + 2000);
  });

  it('applies the default TTL (7 days) when none is given', async () => {
    await setup([1], 1);
    const { body } = await createRequest();
    const row = await ctx.store.getRequest(body.id!);
    const expiresAt = Date.parse(row!.expiresAt);
    expect(expiresAt - Date.parse(row!.createdAt)).toBeGreaterThanOrEqual(7 * 24 * 3600 * 1000 - 2000);
  });

  it('stores an empty signature set and records the tx hash', async () => {
    await setup([1], 1);
    const { body } = await createRequest();
    const row = await ctx.store.getRequest(body.id!);
    expect(row!.status).toBe('pending');
    expect(row!.txHash).toHaveLength(64);
    const signatures = await ctx.store.getRequestSignatures(body.id!);
    expect(signatures).toEqual([]);
  });
});

describe('GET /requests/:id — decoded summary and signature state', () => {
  it('returns an accurate human-readable summary of the operations', async () => {
    ctx = await setupTestContext();
    const source = makeSigners(1)[0]!.publicKey;
    const [dest, newAccount] = makeSigners(2);
    ctx.accountGateway.setAccount(source, { signers: [], threshold: 1 });
    const tx = buildMixedOperationsTransaction(source, dest!.publicKey, newAccount!.publicKey, 'project', 'stellar');
    const created = await postJson(ctx.app, '/requests', {
      sourceAccount: source,
      transactionXdr: tx.toXDR(),
      network: 'testnet',
    });
    const { status, body } = await getJson(ctx.app, `/requests/${created.body.id}`);
    expect(status).toBe(200);

    const summary = body.summary as {
      source: string;
      fee: string;
      sequence: string;
      memo: { type: string; value: string };
      operations: Array<{ type: string; description: string }>;
    };
    expect(summary.source).toBe(source);
    expect(summary.sequence).toBe(tx.sequence);
    expect(summary.memo).toEqual({ type: 'text', value: 'coordinator fixture' });
    expect(summary.operations).toHaveLength(3);
    expect(summary.operations[0]!.type).toBe('payment');
    // The SDK normalizes parsed amounts to 7 decimals.
    expect(summary.operations[0]!.description).toContain(`XLM to ${dest!.publicKey}`);
    expect(summary.operations[0]!.description).toContain('Pay 10.');
    expect(summary.operations[1]!.type).toBe('createAccount');
    expect(summary.operations[1]!.description).toContain(`Create account ${newAccount!.publicKey}`);
    expect(summary.operations[2]!.type).toBe('manageData');
    expect(summary.operations[2]!.description).toContain('project');
  });

  it('describes multisig setOptions changes accurately', async () => {
    await setup([1], 1);
    const addedSigner = makeSigners(1)[0]!.publicKey;
    const tx = buildSetOptionsTransaction(ctxSource, addedSigner, 2);
    const created = await createRequest({ transactionXdr: tx.toXDR() });
    const { status, body } = await getJson(ctx.app, `/requests/${created.body.id}`);
    expect(status).toBe(200);
    const summary = body.summary as { operations: Array<{ type: string; description: string }> };
    expect(summary.operations[0]!.type).toBe('setOptions');
    expect(summary.operations[0]!.description).toContain(`signer ${addedSigner}`);
    expect(summary.operations[0]!.description).toContain('medium threshold 2');
  });

  it('reports which signers have signed and the live threshold', async () => {
    await setup([1, 1], 2);
    const { body } = await createRequest();
    const fetched = await getJson(ctx.app, `/requests/${body.id}`);
    const signatureState = fetched.body.signatureState as {
      threshold: number;
      signedWeight: number;
      thresholdMet: boolean;
      signers: Array<{ key: string; weight: number; signed: boolean }>;
    };
    expect(signatureState.threshold).toBe(2);
    expect(signatureState.signedWeight).toBe(0);
    expect(signatureState.thresholdMet).toBe(false);
    expect(signatureState.signers).toHaveLength(2);
    expect(signatureState.signers.every((signer) => signer.signed === false)).toBe(true);
  });

  it('returns a uniform 404 for an unknown id', async () => {
    await setup([1], 1);
    const unknown = 'f'.repeat(32);
    const first = await getJson(ctx.app, `/requests/${unknown}`);
    expect(first.status).toBe(404);
  });

  it('rejects malformed ids at the schema level', async () => {
    await setup([1], 1);
    const { status } = await getJson(ctx.app, '/requests/not-an-id');
    expect(status).toBe(400);
  });
});
