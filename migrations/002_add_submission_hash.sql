-- The actual on-chain transaction hash returned by Horizon on successful
-- submission. This is distinct from pending_requests.tx_hash, which is the
-- signature-base hash of the UNSIGNED envelope (computed at creation time,
-- used to verify signatures) and is never the submitted transaction's hash.
-- NULL until a submission actually succeeds.
ALTER TABLE pending_requests ADD COLUMN IF NOT EXISTS submission_hash TEXT;
