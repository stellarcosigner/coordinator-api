/**
 * GET /requests/:id — returns a single pending request by its exact ID.
 *
 * 404 is returned both for IDs that never existed and for expired requests, so
 * the two cases are indistinguishable and no information leaks. The response
 * includes a fully decoded summary of the transaction (what a signer reviews
 * before signing) and the account's CURRENT signer list/threshold, resolved
 * live from the network.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from './app.js';
import { parseTransaction } from './transaction.js';
import { currentWeightSum, resolveAccountState } from './verify.js';
import { describeTransaction } from './summary.js';

export interface FetchParams {
  id: string;
}

export async function handleFetch(
  request: FastifyRequest<{ Params: FetchParams }>,
  reply: FastifyReply,
  deps: AppDeps,
): Promise<FastifyReply> {
  const { id } = request.params;
  const row = await deps.store.getRequest(id);

  // Uniform 404: never existed and expired look identical.
  if (!row || row.status === 'expired') {
    return reply.code(404).send({ error: 'request not found' });
  }

  let transaction;
  try {
    transaction = parseTransaction(row.transactionXdr, row.network);
  } catch (error) {
    request.log.error({ err: error, id }, 'stored transaction XDR failed to parse');
    return reply.code(500).send({ error: 'stored request is corrupted' });
  }

  const signatures = await deps.store.getRequestSignatures(id);

  let accountState;
  try {
    accountState = await resolveAccountState(deps.accountGateway, row.sourceAccount, row.network);
  } catch (error) {
    request.log.error({ err: error, id, sourceAccount: row.sourceAccount }, 'failed to fetch live account state');
    return reply.code(502).send({ error: 'unable to reach the Stellar network' });
  }

  const signedAtByKey = new Map(signatures.map((signature) => [signature.signerPublicKey, signature.createdAt]));
  const signedKeys = signatures.map((signature) => signature.signerPublicKey);
  const signedWeight = currentWeightSum(accountState, signedKeys);

  return reply.code(200).send({
    id: row.id,
    sourceAccount: row.sourceAccount,
    network: row.network,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    submittedAt: row.submittedAt,
    summary: describeTransaction(transaction),
    signatureState: {
      threshold: accountState.threshold,
      signedWeight,
      thresholdMet: signedWeight >= accountState.threshold,
      signers: accountState.signers.map((signer) => ({
        key: signer.key,
        weight: signer.weight,
        signed: signedAtByKey.has(signer.key),
        signedAt: signedAtByKey.get(signer.key) ?? null,
      })),
    },
  });
}
