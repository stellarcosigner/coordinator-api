/**
 * POST /requests/:id/sign — records one signer's detached signature.
 *
 * Body: { signerPublicKey, signature } where `signature` is the base64-encoded
 * 64-byte ed25519 signature the signer produced over the transaction's
 * signature-base hash (see README for how a Freighter-style wallet produces
 * this detached signature).
 *
 * Order of checks (all must pass before anything is recorded):
 * 1. 404 if the request does not exist or has expired.
 * 2. 409 if this signer has already signed (additive-only; never overwrite).
 * 3. The signature must be cryptographically valid for this exact transaction
 *    and this exact key.
 * 4. The signer must be in the account's CURRENT live signer list (fetched from
 *    the network, not cached from creation time and not trusted from the body).
 * 5. If the account's real threshold is now met, the request is claimed and
 *    submitted to the network immediately.
 */
import { NotFoundError } from '@stellar/stellar-sdk';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from './app.js';
import {
  DuplicateSignatureError,
  RequestAlreadySubmittedError,
  RequestExpiredError,
  RequestNotFoundError,
} from './store.js';
import { submitSignedRequest } from './submit.js';
import { parseTransaction } from './transaction.js';
import { isPlausiblePublicKey, isRegisteredSigner, resolveAccountState, signerWeight, verifyDetachedSignature } from './verify.js';

export interface SignParams {
  id: string;
}

export interface SignRequestBody {
  signerPublicKey: string;
  signature: string;
}

const ED25519_SIGNATURE_BYTE_LENGTH = 64;

export async function handleSign(
  request: FastifyRequest<{ Params: SignParams; Body: SignRequestBody }>,
  reply: FastifyReply,
  deps: AppDeps,
): Promise<FastifyReply> {
  const { id } = request.params;
  const { signerPublicKey, signature } = request.body;

  if (!isPlausiblePublicKey(signerPublicKey)) {
    return reply.code(400).send({ error: 'signerPublicKey is not a valid Stellar public key' });
  }

  const signatureBuffer = Buffer.from(signature, 'base64');
  if (signatureBuffer.length !== ED25519_SIGNATURE_BYTE_LENGTH) {
    return reply.code(400).send({ error: 'signature must be a base64-encoded 64-byte ed25519 signature' });
  }

  const row = await deps.store.getRequest(id);
  if (!row || row.status === 'expired') {
    // Uniform 404: never existed and expired look identical.
    return reply.code(404).send({ error: 'request not found' });
  }
  if (row.status === 'submitted') {
    return reply.code(409).send({ error: 'request already submitted' });
  }

  // Additive-only: a signer may sign once. The DB primary key re-checks this
  // under concurrency.
  if (await deps.store.requestHasSignature(id, signerPublicKey)) {
    return reply.code(409).send({ error: 'signer has already signed this request' });
  }

  // The signature must verify against the exact stored transaction.
  let transaction;
  try {
    transaction = parseTransaction(row.transactionXdr, row.network);
  } catch (error) {
    request.log.error({ err: error, id }, 'stored transaction XDR failed to parse');
    return reply.code(500).send({ error: 'stored request is corrupted' });
  }
  if (!verifyDetachedSignature(transaction.hash(), signerPublicKey, signatureBuffer)) {
    return reply.code(400).send({ error: 'signature does not verify for this transaction and key' });
  }

  // Live signer membership check — the network decides, not the client.
  let accountState;
  try {
    accountState = await resolveAccountState(deps.accountGateway, row.sourceAccount, row.network);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return reply.code(400).send({ error: 'source account not found on the network' });
    }
    request.log.error({ err: error, id, sourceAccount: row.sourceAccount }, 'failed to fetch live account state');
    return reply.code(502).send({ error: 'unable to reach the Stellar network' });
  }
  if (!isRegisteredSigner(accountState, signerPublicKey)) {
    return reply.code(403).send({ error: 'signerPublicKey is not a current signer of this account' });
  }

  const currentWeights = new Map(accountState.signers.map((signer) => [signer.key, signer.weight]));

  let result;
  try {
    result = await deps.store.recordSignatureAndMaybeClaim(
      id,
      {
        signerPublicKey,
        signature,
        weight: signerWeight(accountState, signerPublicKey),
      },
      accountState.threshold,
      currentWeights,
    );
  } catch (error) {
    if (error instanceof RequestNotFoundError || error instanceof RequestExpiredError) {
      return reply.code(404).send({ error: 'request not found' });
    }
    if (error instanceof RequestAlreadySubmittedError) {
      return reply.code(409).send({ error: 'request already submitted' });
    }
    if (error instanceof DuplicateSignatureError) {
      return reply.code(409).send({ error: 'signer has already signed this request' });
    }
    throw error;
  }

  if (result.claimed) {
    // Threshold met: assemble the fully-signed envelope from every recorded
    // signature and submit right away.
    const signatures = await deps.store.getRequestSignatures(id);
    try {
      const submission = await submitSignedRequest(deps, row, signatures);
      request.log.info({ id, hash: submission.hash }, 'request submitted to the network');
    } catch (error) {
      // Revert to pending so the background job can retry; signatures are kept.
      const message = error instanceof Error ? error.message : String(error);
      await deps.store.recordSubmitFailure(id, message, row.submitAttempts + 1);
      request.log.error({ err: error, id }, 'network submission failed; request reverted to pending');
      return reply.code(200).send({ status: 'pending' });
    }
  }

  return reply.code(200).send({ status: result.status });
}
