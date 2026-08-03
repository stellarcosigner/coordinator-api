# Contributing

Thanks for helping with the Stellar Multisig Coordinator API.

## Getting started

```bash
npm install
docker compose up -d postgres
npm run dev
```

Run the checks before pushing:

```bash
npm run typecheck
npm run lint
npm test
```

## Git workflow — non-negotiable

- **Never `git add .`.** Stage specific files only (`git add src/foo.ts`).
- **One commit per logical unit**, with a **Conventional Commits** message:
  `feat(scope): ...`, `fix(scope): ...`, `test: ...`, `chore(scope): ...`,
  `docs: ...`, `refactor(scope): ...`.
- **Push immediately after every commit** to `origin/main`.
- If a commit contains unrelated changes, split it.

## Coding standards

- **TypeScript strict, no `any`** (`no-explicit-any` is a lint error).
- Every route validates its input (JSON Schema + explicit checks) **before**
  touching the database or the network.
- **Never log secrets.** Structured logging everywhere (`req.log` / `app.log`,
  pino); log request IDs and outcomes, never keys, signatures, or tokens.
- Never trust client-supplied signer state — always resolve signer lists and
  thresholds live from the network (`src/verify.ts`).
- New endpoints that list pending requests will not be merged, even for
  admin/debug purposes.
- Tests must not hit the real network: inject `FakeAccountGateway` /
  `FakeSubmissionGateway` (see `test/helpers.ts`).

## Adding or changing behavior

1. Find the smallest surface that changes — the module map in the README is
   the best starting point.
2. Add/adjust tests in `test/` first where practical (they run in CI against a
   real Postgres).
3. Run `npm run typecheck && npm run lint && npm test`.
4. Commit (specific files) and push.

## Reviewing

- Verify the security invariants still hold (see SECURITY.md): no listing
  endpoint, no predictable IDs, no client-trusted signer state, additive-only
  signatures, live network resolution.
- Verify every DB query is parameterized.
