-- Supports the reconciliation background pass, which repeatedly selects a
-- bounded batch of 'submitted' rows still missing a submission_hash (see
-- src/reconcile.ts). Without this partial index, every pass would sequential
-- scan the full pending_requests table. Purely additive: no existing rows,
-- columns, or constraints are touched.
CREATE INDEX IF NOT EXISTS idx_pending_requests_reconciliation
  ON pending_requests (submitted_at)
  WHERE status = 'submitted' AND submission_hash IS NULL;
