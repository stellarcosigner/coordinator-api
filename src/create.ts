/**
 * POST /requests — creates a new pending multisig coordination request.
 *
 * Security properties enforced here:
 * - The XDR must be a well-formed Stellar transaction envelope.
 * - sourceAccount must be a plausible Stellar public key and must match the
 *   transaction's own source.
 * - The account's signer list and threshold are resolved LIVE from the network.
 *   Nothing about the account's multisig setup is taken from the request body.
 * - The ID is cryptographically random and unguessable; the response returns
 *   only { id }.
 */
import { NotFoundError } from '@stellar/stellar-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from './app.js';
import { generateRequestId } from './id.js';
import { parseTransaction } from './transaction.js';
import type { NetworkName } from './types.js';
import { isPlausiblePublicKey, resolveAccountState } from './verify.js';

export interface CreateRequestBody {
  sourceAccount: string;
  transactionXdr: string;
  network: NetworkName;
  ttlSeconds?: number;
}

export async function handleCreate(
  request: FastifyRequest<{ Body: CreateRequestBody }>,
  reply: FastifyReply,
  deps: AppDeps,
): Promise<FastifyReply> {
  const { sourceAccount, transactionXdr, network, ttlSeconds } = request.body;

  if (!isPlausiblePublicKey(sourceAccount)) {
    return reply.code(400).send({ error: 'sourceAccount is not a valid Stellar public key' });
  }

  let transaction;
  try {
    transaction = parseTransaction(transactionXdr, network);
  } catch (error) {
    return reply
      .code(400)
      .send({ error: error instanceof Error ? error.message : 'transactionXdr is invalid' });
  }

  if (transaction.source !== sourceAccount) {
    return reply.code(400).send({ error: 'transactionXdr source does not match sourceAccount' });
  }

  const ttl = ttlSeconds ?? deps.config.defaultTtlSeconds;
  if (ttl > deps.config.maxTtlSeconds) {
    return reply.code(400).send({ error: `ttlSeconds exceeds the maximum of ${deps.config.maxTtlSeconds}` });
  }

  // Resolve the account's real signer list and threshold from the network. A
  // client cannot claim anything about the account's multisig setup.
  let accountState;
  try {
    accountState = await resolveAccountState(deps.accountGateway, sourceAccount, network);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return reply.code(400).send({ error: 'source account not found on the network' });
    }
    request.log.error({ err: error, sourceAccount, network }, 'failed to fetch account state from network');
    return reply.code(502).send({ error: 'unable to reach the Stellar network' });
  }

  const id = generateRequestId();
  await deps.store.createRequest({
    id,
    sourceAccount,
    network,
    transactionXdr,
    txHash: transaction.hash().toString('hex'),
    expiresAt: new Date(Date.now() + ttl * 1000),
  });

  request.log.info(
    { id, sourceAccount, network, threshold: accountState.threshold, signerCount: accountState.signers.length },
    'pending request created',
  );
  return reply.code(201).send({ id });
}
