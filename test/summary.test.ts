/**
 * Decoder-case regression tests, driven by test/fixtures/decoder-cases.json.
 *
 * That file is shared byte-for-byte with the sibling coordinator-web repo's
 * test/fixtures/decoder-cases.json. Running the same human-readable cases and
 * expected exact sentences through each repo's own decoder does NOT prove the
 * two decoders produce identical output to each other in this test run — this
 * suite never touches coordinator-web's code. What it proves is narrower but
 * still useful: the same input parameters and the same expected exact
 * description continue to hold in THIS repo's decoder. If someone changes
 * src/summary.ts in a way that changes one of these sentences, this suite
 * fails here; if the same drift happens only in the other repo, only that
 * repo's copy of this suite will fail. Catching cross-repo drift still
 * requires both suites to be kept green independently.
 *
 * These are additive to the existing decoder coverage in create.test.ts,
 * which exercises the decoder through the full HTTP request/response cycle.
 * This suite exercises describeTransaction/describeOperation directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Account, Asset, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { describeTransaction } from '../src/summary.js';

interface AssetParam {
  code: string;
  issuer: string;
}

type OperationParams = Record<string, unknown>;

interface DecoderCase {
  name: string;
  why: string;
  operation: { type: string; params: OperationParams };
  expectDescription: string;
}

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/decoder-cases.json', import.meta.url));
const cases: DecoderCase[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

const PLACEHOLDER_PATTERN = /\{[A-Z_]+\}/g;

/** Every {TOKEN} appearing anywhere in a case gets one fresh, real keypair. */
function resolvePlaceholders(caseData: DecoderCase): Map<string, string> {
  const tokens = new Set(JSON.stringify(caseData).match(PLACEHOLDER_PATTERN) ?? []);
  const resolved = new Map<string, string>();
  for (const token of tokens) {
    resolved.set(token, Keypair.random().publicKey());
  }
  return resolved;
}

function resolveString(value: string, tokens: Map<string, string>): string {
  if (tokens.has(value)) return tokens.get(value)!;
  return value.replace(PLACEHOLDER_PATTERN, (token) => tokens.get(token) ?? token);
}

function resolveAsset(value: unknown, tokens: Map<string, string>): Asset {
  if (value === 'native') return Asset.native();
  const { code, issuer } = value as AssetParam;
  return new Asset(code, resolveString(issuer, tokens));
}

/**
 * Explicit, per-type builder — deliberately not a generic deserializer, so
 * each case's SDK call is plainly visible and each new operation type this
 * repo wants to cover requires one new, readable branch here.
 */
function buildOperation(operation: DecoderCase['operation'], tokens: Map<string, string>) {
  const p = operation.params;
  switch (operation.type) {
    case 'payment':
      return Operation.payment({
        destination: resolveString(p.destination as string, tokens),
        asset: resolveAsset(p.asset, tokens),
        amount: p.amount as string,
      });
    case 'createAccount':
      return Operation.createAccount({
        destination: resolveString(p.destination as string, tokens),
        startingBalance: p.startingBalance as string,
      });
    case 'manageData':
      return Operation.manageData({
        name: p.name as string,
        value: Buffer.from(p.value as string, 'utf8'),
      });
    case 'setOptions': {
      const signer = p.signer as { publicKey: string; weight: number } | undefined;
      const options: Parameters<typeof Operation.setOptions>[0] = {};
      if (signer) {
        options.signer = { ed25519PublicKey: resolveString(signer.publicKey, tokens), weight: signer.weight };
      }
      if (p.medThreshold !== undefined) options.medThreshold = p.medThreshold as number;
      if (p.masterWeight !== undefined) options.masterWeight = p.masterWeight as number;
      return Operation.setOptions(options);
    }
    case 'changeTrust':
      return Operation.changeTrust({
        asset: resolveAsset(p.asset, tokens),
        limit: p.limit as string,
      });
    case 'allowTrust':
      return Operation.allowTrust({
        trustor: resolveString(p.trustor as string, tokens),
        assetCode: p.assetCode as string,
        authorize: p.authorize as boolean,
      });
    case 'accountMerge':
      return Operation.accountMerge({
        destination: resolveString(p.destination as string, tokens),
      });
    case 'pathPaymentStrictSend':
      return Operation.pathPaymentStrictSend({
        destination: resolveString(p.destination as string, tokens),
        sendAsset: resolveAsset(p.sendAsset, tokens),
        sendAmount: p.sendAmount as string,
        destAsset: resolveAsset(p.destAsset, tokens),
        destMin: p.destMin as string,
      });
    case 'bumpSequence':
      return Operation.bumpSequence({ bumpTo: p.bumpTo as string });
    case 'manageSellOffer':
      return Operation.manageSellOffer({
        selling: resolveAsset(p.selling, tokens),
        buying: resolveAsset(p.buying, tokens),
        amount: p.amount as string,
        price: p.price as string,
      });
    case 'invokeHostFunction':
      // Only the createStellarAssetContract shape is covered — it is the
      // simplest real invokeHostFunction operation to build without raw XDR.
      return Operation.createStellarAssetContract({
        asset: resolveAsset(p.asset, tokens),
      });
    default:
      throw new Error(`decoder-cases.json: no test builder for operation type "${operation.type}"`);
  }
}

function buildTransactionForCase(caseData: DecoderCase): { transaction: Transaction; tokens: Map<string, string> } {
  const tokens = resolvePlaceholders(caseData);
  const source = new Account(Keypair.random().publicKey(), '1234567890');
  const transaction = new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(buildOperation(caseData.operation, tokens))
    .setTimeout(300)
    .build();
  return { transaction, tokens };
}

describe('decoder cases (shared fixtures)', () => {
  for (const caseData of cases) {
    it(`${caseData.name}: ${caseData.why}`, () => {
      const { transaction, tokens } = buildTransactionForCase(caseData);
      const summary = describeTransaction(transaction);

      expect(summary.operations).toHaveLength(1);
      const operation = summary.operations[0]!;
      expect(operation.type).toBe(caseData.operation.type);
      expect(operation.description).toBe(resolveString(caseData.expectDescription, tokens));
    });
  }
});
