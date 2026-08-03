# Security

## Reporting a vulnerability

Please report security issues privately to the maintainers — do **not** open a
public issue. Include a minimal reproduction (request/response bodies and
timestamps if applicable). We'll acknowledge within 5 business days and aim to
ship a fix promptly. If you believe the issue is critical and public disclosure
is warranted, please allow a 90-day coordinated-disclosure window.

## What this service is

A coordination layer for Stellar multisig. It stores a pending transaction,
tracks signatures produced by signers' own wallets, and submits the fully-signed
transaction once the account's real on-chain threshold is met. It does not hold,
store, or transmit private keys at any point.

## Threat model

The service is self-hosted, so the primary threats are:

- **An attacker who obtains a request ID** should learn nothing beyond that one
  request — and only while it is pending. IDs are 128-bit CSPRNG values
  (`src/id.ts`); they are never sequential, never derived from the account or a
  timestamp. A brute-force search over the ID space is infeasible.
- **A malicious client that claims to be a signer.** Signer membership and
  thresholds are resolved **live from the network on every call**
  (`src/verify.ts`, `HorizonAccountGateway`) and never accepted from client
  input. If the network says a key is not a signer (or has weight 0), the
  signature is rejected (`403`).
- **A client that submits a forged or tampered signature.** Every signature is
  verified cryptographically against the stored transaction's signature-base
  hash with the claimed public key before being recorded (`400` otherwise).
- **A signer trying to overwrite another signer's signature.** Signatures are
  additive-only; each request+signer pair is a database primary key, so a
  duplicate attempt is rejected (`409`) and no stored signature is ever
  mutated.
- **Enumeration / information leakage.** There is no listing endpoint of any
  kind. `GET /requests/:id` returns the same `404` for "never existed" and
  "expired", so expired IDs are indistinguishable from unused ones. Response
  bodies are minimal (`POST /requests` returns only `{ id }`).
- **A stale account snapshot.** The account's signer list can change on-chain;
  the service never caches it. Creation, reads, and signing all re-resolve
  from Horizon, so a removed signer's old signature stops counting toward the
  threshold (weights are recomputed from current state).
- **An untrusted operator reading the database.** No private keys or secrets
  are stored. The stored data is: the transaction envelope, its hash, the
  public keys and signatures of signers, and status metadata. Signatures are
  public by nature on Stellar.

## Security invariants (must never be regressed)

1. No endpoint ever lists or enumerates pending requests — not even for
   admin/debug. Operations visibility is via structured logs only.
2. IDs are cryptographically random (≥128 bits), never sequential or derived
   from predictable inputs.
3. No private key is ever accepted, stored, or transmitted.
4. Signer lists/thresholds always come from the live network, never from
   clients or caches.
5. Signature storage is strictly additive; duplicate signers are rejected.

## Operational notes

- **No secrets in logs.** Never log signatures, XDR bodies, or environment
  secrets. Log request IDs and structured outcomes only.
- **Database access:** use least-privilege credentials; the schema is plain
  Postgres DDL in `migrations/`.
- **Reverse proxy / TLS:** deploy behind TLS. CORS is off by default; if a
  browser frontend calls this API, restrict `CORS_ORIGIN` to your own domain(s).
- **Retention:** expired rows are soft-marked then hard-deleted after
  `EXPIRED_RETENTION_SECONDS` (default 30 days). The API never reveals whether
  a 404 was a never-existing or an expired request.
