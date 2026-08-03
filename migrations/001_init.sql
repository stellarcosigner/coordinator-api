-- Pending multisig coordination requests. Each row is only ever reachable via
-- its cryptographically random `id`; there is deliberately no listing API.
CREATE TABLE IF NOT EXISTS pending_requests (
  id                 TEXT PRIMARY KEY,      -- 32 lowercase hex chars (128 bits entropy), see src/id.ts
  source_account     TEXT NOT NULL,         -- G... address that must sign the transaction
  network            TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  transaction_xdr    TEXT NOT NULL,         -- base transaction envelope as submitted by the creator
  tx_hash            TEXT NOT NULL,         -- hex of the signature-base hash, used to verify signatures
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'submitted', 'expired')),
  submit_attempts    INTEGER NOT NULL DEFAULT 0,
  last_submit_error  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  submitted_at       TIMESTAMPTZ,
  CONSTRAINT expires_after_created CHECK (expires_at > created_at)
);

-- Signatures added by signers, one row per signer. Additive-only: the primary
-- key is the source of the "no overwriting another signer's signature" rule.
CREATE TABLE IF NOT EXISTS signatures (
  request_id         TEXT NOT NULL REFERENCES pending_requests (id) ON DELETE CASCADE,
  signer_public_key  TEXT NOT NULL,
  signature          TEXT NOT NULL,         -- base64-encoded 64-byte ed25519 signature
  weight             INTEGER NOT NULL,      -- signer weight as recorded from the live network state at sign time
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, signer_public_key)
);

-- For the background expiry job.
CREATE INDEX IF NOT EXISTS idx_pending_requests_status_expiry
  ON pending_requests (status, expires_at);
