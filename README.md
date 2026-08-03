# Stellar Multisig Coordinator API

A self-hosted backend for coordinating **Stellar multisig transactions**.

Stellar supports multisig natively at the protocol level — an account can require
signatures from multiple weighted keys, above a threshold, before a transaction
is valid. What's missing is *coordination*: getting a transaction built by one
person in front of the other required signers, tracking who has signed, and
submitting automatically once the threshold is met.

This service does exactly that, and nothing more:

- Stores a pending transaction under an unguessable, cryptographically random ID.
- Tracks signatures added by signers using their **own wallets**.
- Submits to the network **once the account's real on-chain threshold is met**.

It does **not** hold private keys, does **not** sign on anyone's behalf, and has
**no** endpoint that lists pending requests.

---

## Non-negotiable security and privacy properties

1. **Pending transactions are never publicly listable.** There is no "browse all
   pending requests" endpoint, ever. A pending transaction is only accessible
   via its exact, unguessable ID (32 hex chars / 128 bits of CSPRNG entropy, see
   [`src/id.ts`](src/id.ts)).
2. **IDs are never sequential or predictable** — never derived from the account
   address, a timestamp, or anything else guessable.
3. **No private key ever touches this service.** Every signature is produced
   client-side by a signer's own wallet. This API only ever receives a detached
   signature to attach to a stored transaction.
4. **Signer lists and thresholds are resolved LIVE from the network on every
   request** ([`src/verify.ts`](src/verify.ts), via
   [`HorizonAccountGateway`](src/horizon.ts)) — never from client input, never
   from a stale cache. A client claiming "I am a signer" is rejected unless the
   network agrees *right now*.
5. **Signatures are additive-only.** A signer may sign once; an existing
   signature can never be overwritten (enforced by a database primary key).

See [SECURITY.md](SECURITY.md) for the full threat model.

## What this service does NOT do

- ❌ List pending requests, even for admin/debug purposes. (Operations
  visibility is provided by structured logs, not a queryable API.)
- ❌ Store or transmit a private key at any point.
- ❌ Trust a client-supplied signer list, threshold, or account state.
- ❌ Use a sequential or predictable ID scheme — even in development.

## Tech stack

- **Node.js 22 LTS**, **TypeScript** (strict, no `any`)
- **Fastify** (with built-in JSON Schema validation and structured `pino` logging)
- **Postgres** for storage
- **@stellar/stellar-sdk** for XDR parsing, signature verification, and reading
  account state / submitting via Horizon

## Repo layout

```
src/
  index.ts       API server entry point (starts HTTP + background jobs)
  app.ts         Fastify app factory (migrations at boot, route registration)
  routes.ts      HTTP route registration + JSON Schema validation
  create.ts      POST /requests
  fetch.ts       GET /requests/:id  (with decoded transaction summary)
  sign.ts        POST /requests/:id/sign
  verify.ts      live signer list/threshold resolution + signature verification
  submit.ts      submission envelope assembly + background submission retry
  expire.ts      background expiry maintenance
  store.ts       Postgres pool, migrations, and queries
  id.ts          unguessable ID generation
  summary.ts     human-readable transaction decoding
  transaction.ts envelope parsing / hashing helpers
  horizon.ts     Horizon adapters (account state, submission)
  config.ts      environment configuration
  background.ts  background job scheduler
migrations/      SQL migrations (applied at boot, tracked in schema_migrations)
test/            integration tests against a real Postgres + fake network gateways
```

## API

All endpoints return JSON. Errors are `{ "error": "<message>" }` with an
appropriate HTTP status.

### `POST /requests`

Creates a pending multisig coordination request.

```jsonc
// Request body
{
  "sourceAccount": "G...",            // required, valid Stellar public key
  "transactionXdr": "AAAAAgAAAA...",  // required, transaction envelope XDR
  "network": "testnet",               // required, "testnet" | "mainnet"
  "ttlSeconds": 604800                // optional, default 7 days, max 30 days
}
```

Validation performed (in order):

1. `sourceAccount` is a plausible Stellar public key (`G...`).
2. The XDR parses as a valid Stellar transaction envelope (fee-bumps rejected).
3. The transaction's own source matches `sourceAccount`.
4. The account **exists** on the network and its real signer list/threshold is
   resolved live. Nothing about the account's multisig setup is accepted from
   the body.
5. `ttlSeconds`, if given, is within `[60, MAX_TTL_SECONDS]`.

```jsonc
// 201 Created
{ "id": "0f8e..." }   // 32 hex chars, 128 bits of entropy — the ONLY response
```

The frontend constructs the shareable URL (`https://your-frontend/requests/<id>`)
itself.

### `GET /requests/:id`

Returns everything a signer needs to review before signing:

```jsonc
{
  "id": "0f8e...",
  "sourceAccount": "G...",
  "network": "testnet",
  "status": "pending",            // "pending" | "submitted" | "expired"
  "createdAt": "2026-08-03T...Z",
  "expiresAt": "2026-08-10T...Z",
  "submittedAt": null,
  "summary": {                    // fully decoded — never "some operations"
    "source": "G...",
    "fee": "100",
    "sequence": "1234567891",
    "memo": { "type": "text", "value": "payroll" },
    "timeBounds": null,
    "operations": [
      { "type": "payment", "description": "Pay 10.0000000 XLM to G...", "details": { "destination": "G...", "amount": "10.0000000", "asset": "XLM" } }
      // every operation type is described with its amounts, assets, destinations
    ],
    "signaturesAttachedToEnvelope": 0
  },
  "signatureState": {             // resolved LIVE from the network at read time
    "threshold": 2,
    "signedWeight": 1,
    "thresholdMet": false,
    "signers": [
      { "key": "G...", "weight": 1, "signed": true,  "signedAt": "2026-08-03T...Z" },
      { "key": "G...", "weight": 1, "signed": false, "signedAt": null }
    ]
  }
}
```

**`404` is returned both for IDs that never existed and for expired requests** —
the two are indistinguishable by design (no information leakage).

### `POST /requests/:id/sign`

Records one signer's detached signature.

```jsonc
// Request body
{
  "signerPublicKey": "G...",   // required
  "signature": "base64...="    // required, base64-encoded 64-byte ed25519 signature
}
```

Checks, in order:

1. `404` if the request doesn't exist or has expired (uniform).
2. `409` if this signer already signed (**never overwrites**) or the request is
   already submitted.
3. The signature must verify **cryptographically** against the stored
   transaction's signature-base hash and this exact key (`400` otherwise).
4. The signer must appear in the account's **current live signer list** with
   weight > 0 (`403` otherwise).
5. If the total recorded weight now meets the account's live threshold, the
   request is claimed and submitted to the network immediately.

```jsonc
// 200 OK — updated status
{ "status": "submitted" }   // or "pending"
```

#### Producing the detached signature (Freighter / wallet integration)

The signature is the base64-encoded 64-byte ed25519 signature over the
transaction's *signature-base hash* (`SHA-256` of the transaction without its
signature list). With Freighter this is one extra client-side step:

1. Ask Freighter to sign the transaction: `signTransaction(transactionXdr, { networkPassphrase })`
   → returns a signed envelope.
2. Parse the returned envelope with `@stellar/stellar-sdk`
   (`TransactionBuilder.fromXDR`), take `transaction.hash()` and
   `transaction.signatures` — the newest signature is the detached signature.
3. POST `{ signerPublicKey, signature }`.

Any wallet that exposes raw signing over the transaction hash can post directly.

### `GET /health`

Checks the database connection. `{ "status": "ok" }`.

## Request lifecycle

| Stage | When | Notes |
| --- | --- | --- |
| `pending` | Created; awaiting signatures | Default TTL **7 days** (`DEFAULT_TTL_SECONDS`), max 30 days |
| `submitted` | Threshold met, envelope submitted | Never expires |
| `expired` | TTL passed while still pending | Soft-expired, retained **30 days** (`EXPIRED_RETENTION_SECONDS`), then hard-deleted; API returns the same 404 as "never existed" |

- The background job runs every **15 minutes** (`EXPIRE_JOB_INTERVAL_MS`),
  marks expired requests, hard-deletes expired rows past the retention window,
  and **retries network submission** for pending requests whose signatures meet
  the threshold (up to `MAX_SUBMIT_ATTEMPTS`, default 5). This recovers from
  transient Horizon failures.
- Threshold used is the account's **medium threshold** — the default for
  Stellar operations. (Operations that explicitly set a higher threshold are
  not auto-detected in v1.)
- **Sequence numbers:** the transaction is submitted with the sequence number it
  was built with. If the account has moved on-chain since then, submission
  fails with `tx_bad_seq` (logged; the request reverts to `pending` and retries
  are bounded). Rebuilding the transaction with a fresh sequence is the fix —
  a known limitation of coordination services.

## Configuration

All configuration is environment-driven; see [`.env.example`](.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | HTTP bind |
| `DATABASE_URL` | `postgres://coordinator:coordinator@localhost:5432/coordinator` | Postgres |
| `TESTNET_HORIZON_URL` | `https://horizon-testnet.stellar.org` | testnet Horizon |
| `MAINNET_HORIZON_URL` | `https://horizon.stellar.org` | mainnet Horizon |
| `DEFAULT_TTL_SECONDS` | `604800` (7 days) | default request TTL |
| `MAX_TTL_SECONDS` | `2592000` (30 days) | client TTL cap |
| `EXPIRE_JOB_INTERVAL_MS` | `900000` (15 min) | background job interval |
| `EXPIRED_RETENTION_SECONDS` | `2592000` (30 days) | retention before hard delete |
| `MAX_SUBMIT_ATTEMPTS` | `5` | submission retry cap |
| `CORS_ORIGIN` | *(empty = off)* | comma-separated origins for browser frontends |
| `LOG_LEVEL` | `info` | pino log level |

## Running locally

```bash
npm install
docker compose up -d postgres          # Postgres 16 on :5432
npm run dev                            # tsx watch, http://localhost:3000
```

Migrations run automatically at boot (idempotent, tracked in
`schema_migrations`). A manual runner is available: `npm run db:migrate`.

## Testing

Tests run against a real Postgres with the Stellar network simulated by fake
gateways (no network access needed). Start Postgres, then:

```bash
docker run -d --name coordinator-test-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
  -p 5433:5432 postgres:16-alpine

npm test          # vitest (typecheck + lint are also run in CI)
npm run typecheck
npm run lint
```

Each test file gets an isolated throwaway database. In CI the Postgres service
container is configured automatically (`.github/workflows/ci.yml`).

## License

UNLICENSED — internal/self-hosted. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).
