/**
 * Reconciliation for 'submitted' requests stuck without a submission_hash.
 *
 * Root cause: a request is marked 'submitted' before the network call is made
 * (see store.tryClaimSubmission / recordSignatureAndMaybeClaim), and
 * submission_hash is written only after Horizon confirms success (see
 * submit.submitSignedRequest). If the process dies in between — after the
 * network genuinely accepted the transaction but before that success was
 * recorded — the row is left ambiguous forever: it is 'submitted', so the
 * normal pending-retry path (submit.retrySubmittableRequests) never selects
 * it, and nothing else ever revisits it.
 *
 * tx_hash is a safe, deterministic lookup key here: it is the hash of the
 * unsigned transaction body (see transaction.transactionHash), which Stellar
 * computes independent of which signatures get attached, and row.transactionXdr
 * is never mutated between creation and submission (only detached signatures
 * are appended — see submit.assembleSignedEnvelope). So the hash computed at
 * creation time is exactly the hash the network will report for this exact
 * submission. It is used only to ask the network "have you seen this?" — the
 * answer that gets persisted always comes from the network's own response,
 * never from local computation, matching the existing submission_hash
 * invariant (see submit.submitSignedRequest's doc comment).
 */
import type { AppDeps } from './app.js';
import type { Logger } from './types.js';

export interface ReconciliationResult {
  /** Rows examined this pass (bounded by config.reconciliationBatchSize). */
  scanned: number;
  /** Rows for which a submission_hash was newly persisted this pass. */
  confirmed: number;
}

export async function reconcileSubmittedRequests(deps: AppDeps, log: Logger): Promise<ReconciliationResult> {
  const rows = await deps.store.getSubmittedRequestsMissingSubmissionHash(deps.config.reconciliationBatchSize);
  let confirmed = 0;

  for (const row of rows) {
    let result;
    try {
      result = await deps.transactionLookupGateway.findTransactionByHash(row.txHash, row.network);
    } catch (error) {
      // Temporary unknown: network/Horizon failure. Leave the row unchanged
      // for a later pass; never guess at an outcome from a failed lookup.
      log.warn({ err: error, id: row.id }, 'reconciliation: temporary lookup failure, will retry later');
      continue;
    }

    if (!result) {
      // Horizon reports the hash does not exist. This alone does not prove the
      // transaction was never submitted — ledger propagation/indexing can lag
      // behind a genuinely accepted submission — so this is left unchanged too.
      log.info({ id: row.id }, 'reconciliation: transaction not yet found on the network');
      continue;
    }

    if (!result.successful) {
      // Definitive network evidence, but of a failed application rather than a
      // missing hash. submission_hash has always meant "the network confirmed
      // this succeeded" (see store.recordSubmissionSuccess); persisting a
      // failed hash there would misrepresent it. There is no existing status
      // for "submitted but failed on-chain", and inventing one is out of scope
      // here, so this is surfaced for operator review and left unchanged.
      log.warn({ id: row.id, hash: result.hash }, 'reconciliation: transaction found but did not succeed on-chain; needs manual review');
      continue;
    }

    // Positive confirmation. The guarded UPDATE (status='submitted' AND
    // submission_hash IS NULL) makes this safe against a concurrent
    // reconciliation pass — for this row or another instance — racing here:
    // only the first writer's update applies, every later one is a no-op.
    const applied = await deps.store.recordReconciledSubmissionHash(row.id, result.hash);
    if (applied) {
      confirmed += 1;
      log.info({ id: row.id, hash: result.hash }, 'reconciliation: submission confirmed and submission_hash persisted');
    }
  }

  if (rows.length > 0) {
    log.info({ scanned: rows.length, confirmed }, 'reconciliation pass complete');
  }
  return { scanned: rows.length, confirmed };
}
