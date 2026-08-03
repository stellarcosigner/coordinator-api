/**
 * Submission machinery.
 *
 * The final envelope submitted to the network is assembled by this service from
 * the base envelope stored at creation time plus every signature recorded via
 * POST /requests/:id/sign. Signatures are sorted by signer key so the assembled
 * envelope is deterministic. The service never holds a private key: it only
 * attaches signatures it was handed.
 */
import { Keypair, xdr } from '@stellar/stellar-sdk';
import type { AppDeps } from './app.js';
import type { PendingRequestRow } from './store.js';
import { parseTransaction } from './transaction.js';
import type { Logger, NetworkName, StoredSignature } from './types.js';
import { currentWeightSum, resolveAccountState } from './verify.js';

export function assembleSignedEnvelope(
  baseXdr: string,
  network: NetworkName,
  signatures: readonly StoredSignature[],
): string {
  const transaction = parseTransaction(baseXdr, network);
  const sorted = [...signatures].sort((a, b) => a.signerPublicKey.localeCompare(b.signerPublicKey));
  for (const stored of sorted) {
    const keypair = Keypair.fromPublicKey(stored.signerPublicKey);
    transaction.signatures.push(
      new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature: Buffer.from(stored.signature, 'base64'),
      }),
    );
  }
  return transaction.toXDR();
}

export interface SubmissionAttemptResult {
  hash: string;
}

/** Assembles the fully-signed envelope and submits it to the network. */
export async function submitSignedRequest(
  deps: AppDeps,
  row: PendingRequestRow,
  signatures: readonly StoredSignature[],
): Promise<SubmissionAttemptResult> {
  const envelope = assembleSignedEnvelope(row.transactionXdr, row.network, signatures);
  return deps.submissionGateway.submitTransaction(envelope, row.network);
}

/**
 * Background retry: for pending requests whose recorded signatures meet the
 * account's CURRENT live threshold, claim submission and submit. Used when a
 * first submission attempt fails (e.g. Horizon was briefly unreachable). Each
 * attempt is bounded by maxSubmitAttempts; failures revert the request to
 * pending and are never silently dropped.
 */
export async function retrySubmittableRequests(deps: AppDeps, log: Logger): Promise<number> {
  const requests = await deps.store.getPendingRequestsForRetry(new Date(), deps.config.maxSubmitAttempts);
  let submittedCount = 0;

  for (const row of requests) {
    let accountState;
    try {
      accountState = await resolveAccountState(deps.accountGateway, row.sourceAccount, row.network);
    } catch (error) {
      log.error({ err: error, id: row.id }, 'retry: failed to fetch live account state');
      continue;
    }

    const signatures = await deps.store.getRequestSignatures(row.id);
    const signedKeys = signatures.map((signature) => signature.signerPublicKey);
    if (currentWeightSum(accountState, signedKeys) < accountState.threshold) {
      continue;
    }

    // Claim atomically; another process may have just submitted it.
    if (!(await deps.store.tryClaimSubmission(row.id))) continue;

    try {
      const result = await submitSignedRequest(deps, row, signatures);
      submittedCount += 1;
      log.info({ id: row.id, hash: result.hash }, 'retry: request submitted to the network');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.store.recordSubmitFailure(row.id, message, row.submitAttempts + 1);
      log.error({ err: error, id: row.id }, 'retry: network submission failed');
    }
  }

  return submittedCount;
}
