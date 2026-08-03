/**
 * Decodes a parsed Stellar transaction into an accurate, human-readable
 * summary. This is what a signer reviews before signing, so it must be
 * complete: every operation is described with its amounts, assets, and
 * destinations, not a generic "some operations" label.
 */
import type {
  Asset,
  LiquidityPoolAsset,
  LiquidityPoolId,
  OperationRecord,
  Transaction,
} from '@stellar/stellar-sdk';

export interface OperationSummary {
  type: string;
  description: string;
  details: Record<string, string | number | boolean | null>;
}

export interface TransactionSummary {
  source: string;
  fee: string;
  sequence: string;
  memo: { type: string; value: string } | null;
  timeBounds: { minTime: string; maxTime: string } | null;
  operations: OperationSummary[];
  signaturesAttachedToEnvelope: number;
}

function assetLabel(asset: Asset | LiquidityPoolAsset | LiquidityPoolId | undefined): string {
  if (!asset) return 'unknown asset';
  if ('getLiquidityPoolParameters' in asset) {
    const params = asset.getLiquidityPoolParameters();
    return `liquidity pool (${assetLabel(params.assetA)} / ${assetLabel(params.assetB)}, fee ${params.fee})`;
  }
  if ('getLiquidityPoolId' in asset) {
    return `liquidity pool ${asset.getLiquidityPoolId()}`;
  }
  return asset.isNative() ? 'XLM' : `${asset.code}:${asset.issuer}`;
}

interface ParsedSigner {
  ed25519PublicKey?: string;
  sha256Hash?: string | Buffer;
  preAuthTx?: string | Buffer;
  ed25519SignedPayload?: string;
  weight?: number | string;
}

function hashLabel(value: string | Buffer): string {
  const hex = typeof value === 'string' ? value : value.toString('hex');
  return `${hex.slice(0, 16)}…`;
}

function signerKeyLabel(signer: ParsedSigner): string {
  if (signer.ed25519PublicKey) return signer.ed25519PublicKey;
  if (signer.sha256Hash) return `sha256:${hashLabel(signer.sha256Hash)}`;
  if (signer.preAuthTx) return `preAuthTx:${hashLabel(signer.preAuthTx)}`;
  if (signer.ed25519SignedPayload) return `signedPayload:${signer.ed25519SignedPayload}`;
  return 'unknown signer';
}

function dataValueLabel(value: Buffer | null | undefined): string {
  if (value === undefined) return '<unset>';
  if (value === null || value.length === 0) return '<empty>';
  const text = value.toString('utf8');
  // Show printable text, otherwise hex.
  if (/^[\x20-\x7e]*$/.test(text)) return `"${text}"`;
  return `0x${value.toString('hex')}`;
}

function describeOperation(op: OperationRecord): OperationSummary {
  const details: Record<string, string | number | boolean | null> = {};
  if (op.source) details.source = op.source;

  switch (op.type) {
    case 'payment':
      details.destination = op.destination;
      details.amount = op.amount;
      details.asset = assetLabel(op.asset);
      return {
        type: op.type,
        description: `Pay ${op.amount} ${assetLabel(op.asset)} to ${op.destination}`,
        details,
      };
    case 'createAccount':
      details.destination = op.destination;
      details.startingBalance = op.startingBalance;
      return {
        type: op.type,
        description: `Create account ${op.destination} with starting balance ${op.startingBalance} XLM`,
        details,
      };
    case 'pathPaymentStrictReceive':
      details.destination = op.destination;
      details.sendAsset = assetLabel(op.sendAsset);
      details.sendMax = op.sendMax;
      details.destAsset = assetLabel(op.destAsset);
      details.destAmount = op.destAmount;
      return {
        type: op.type,
        description: `Send at most ${op.sendMax} ${assetLabel(op.sendAsset)} to ${op.destination} delivering exactly ${op.destAmount} ${assetLabel(op.destAsset)}`,
        details,
      };
    case 'pathPaymentStrictSend':
      details.destination = op.destination;
      details.sendAsset = assetLabel(op.sendAsset);
      details.sendAmount = op.sendAmount;
      details.destAsset = assetLabel(op.destAsset);
      details.destMin = op.destMin;
      return {
        type: op.type,
        description: `Send exactly ${op.sendAmount} ${assetLabel(op.sendAsset)} to ${op.destination} delivering at least ${op.destMin} ${assetLabel(op.destAsset)}`,
        details,
      };
    case 'manageBuyOffer':
      details.selling = assetLabel(op.selling);
      details.buying = assetLabel(op.buying);
      details.buyAmount = op.buyAmount;
      details.price = op.price;
      details.offerId = op.offerId;
      return {
        type: op.type,
        description: `Place buy offer: buy ${op.buyAmount} ${assetLabel(op.buying)} for ${assetLabel(op.selling)} at price ${op.price} (offer ${op.offerId})`,
        details,
      };
    case 'manageSellOffer':
      details.selling = assetLabel(op.selling);
      details.buying = assetLabel(op.buying);
      details.amount = op.amount;
      details.price = op.price;
      details.offerId = op.offerId;
      return {
        type: op.type,
        description: `Place sell offer: sell ${op.amount} ${assetLabel(op.selling)} for ${assetLabel(op.buying)} at price ${op.price} (offer ${op.offerId})`,
        details,
      };
    case 'createPassiveSellOffer':
      details.selling = assetLabel(op.selling);
      details.buying = assetLabel(op.buying);
      details.amount = op.amount;
      details.price = op.price;
      return {
        type: op.type,
        description: `Create passive sell offer: sell ${op.amount} ${assetLabel(op.selling)} for ${assetLabel(op.buying)} at price ${op.price}`,
        details,
      };
    case 'setOptions':
      return describeSetOptions(op, details);
    case 'changeTrust':
      details.asset = assetLabel(op.line);
      details.limit = op.limit;
      return {
        type: op.type,
        description: `Set trustline for ${assetLabel(op.line)} with limit ${op.limit}`,
        details,
      };
    case 'allowTrust':
      details.trustor = op.trustor;
      details.assetCode = op.assetCode;
      details.authorize = op.authorize ?? null;
      return {
        type: op.type,
        description: `Set trust authorization for ${op.assetCode} held by ${op.trustor} (authorize=${op.authorize ?? 0})`,
        details,
      };
    case 'accountMerge':
      details.destination = op.destination;
      return {
        type: op.type,
        description: `Merge this account into ${op.destination}`,
        details,
      };
    case 'manageData':
      details.name = op.name;
      details.value = dataValueLabel(op.value);
      return {
        type: op.type,
        description: `Set data entry ${op.name} = ${dataValueLabel(op.value)}`,
        details,
      };
    case 'bumpSequence':
      details.bumpTo = op.bumpTo;
      return {
        type: op.type,
        description: `Bump sequence number to ${op.bumpTo}`,
        details,
      };
    case 'createClaimableBalance':
      details.asset = assetLabel(op.asset);
      details.amount = op.amount;
      details.claimants = op.claimants.length;
      return {
        type: op.type,
        description: `Create claimable balance of ${op.amount} ${assetLabel(op.asset)} with ${op.claimants.length} claimant(s)`,
        details,
      };
    case 'claimClaimableBalance':
      details.balanceId = op.balanceId;
      return {
        type: op.type,
        description: `Claim claimable balance ${op.balanceId}`,
        details,
      };
    case 'beginSponsoringFutureReserves':
      details.sponsoredId = op.sponsoredId;
      return {
        type: op.type,
        description: `Begin sponsoring future reserves for ${op.sponsoredId}`,
        details,
      };
    case 'endSponsoringFutureReserves':
      return { type: op.type, description: 'End sponsoring future reserves', details };
    case 'revokeAccountSponsorship':
      details.account = op.account;
      return {
        type: op.type,
        description: `Revoke account sponsorship of ${op.account}`,
        details,
      };
    case 'revokeTrustlineSponsorship':
      details.account = op.account;
      details.asset = assetLabel(op.asset);
      return {
        type: op.type,
        description: `Revoke sponsorship of trustline ${assetLabel(op.asset)} on ${op.account}`,
        details,
      };
    case 'revokeOfferSponsorship':
      details.seller = op.seller;
      details.offerId = op.offerId;
      return {
        type: op.type,
        description: `Revoke sponsorship of offer ${op.offerId} (seller ${op.seller})`,
        details,
      };
    case 'revokeDataSponsorship':
      details.account = op.account;
      details.name = op.name;
      return {
        type: op.type,
        description: `Revoke sponsorship of data entry "${op.name}" on ${op.account}`,
        details,
      };
    case 'revokeClaimableBalanceSponsorship':
      details.balanceId = op.balanceId;
      return {
        type: op.type,
        description: `Revoke sponsorship of claimable balance ${op.balanceId}`,
        details,
      };
    case 'revokeLiquidityPoolSponsorship':
      details.liquidityPoolId = op.liquidityPoolId;
      return {
        type: op.type,
        description: `Revoke sponsorship of liquidity pool ${op.liquidityPoolId}`,
        details,
      };
    case 'revokeSignerSponsorship':
      details.account = op.account;
      return {
        type: op.type,
        description: `Revoke sponsorship of a signer on ${op.account}`,
        details,
      };
    case 'clawback':
      details.asset = assetLabel(op.asset);
      details.amount = op.amount;
      details.from = op.from;
      return {
        type: op.type,
        description: `Clawback ${op.amount} ${assetLabel(op.asset)} from ${op.from}`,
        details,
      };
    case 'clawbackClaimableBalance':
      details.balanceId = op.balanceId;
      return {
        type: op.type,
        description: `Clawback claimable balance ${op.balanceId}`,
        details,
      };
    case 'setTrustLineFlags':
      details.trustor = op.trustor;
      details.asset = assetLabel(op.asset);
      details.authorized = op.flags.authorized ?? null;
      details.authorizedToMaintainLiabilities = op.flags.authorizedToMaintainLiabilities ?? null;
      details.clawbackEnabled = op.flags.clawbackEnabled ?? null;
      return {
        type: op.type,
        description: `Set trustline flags on ${assetLabel(op.asset)} for ${op.trustor} (authorized=${op.flags.authorized ?? false}, clawback=${op.flags.clawbackEnabled ?? false})`,
        details,
      };
    case 'liquidityPoolDeposit':
      details.liquidityPoolId = op.liquidityPoolId;
      details.maxAmountA = op.maxAmountA;
      details.maxAmountB = op.maxAmountB;
      details.minPrice = op.minPrice;
      details.maxPrice = op.maxPrice;
      return {
        type: op.type,
        description: `Deposit into liquidity pool ${op.liquidityPoolId} (up to ${op.maxAmountA} / ${op.maxAmountB}, price ${op.minPrice}-${op.maxPrice})`,
        details,
      };
    case 'liquidityPoolWithdraw':
      details.liquidityPoolId = op.liquidityPoolId;
      details.amount = op.amount;
      details.minAmountA = op.minAmountA;
      details.minAmountB = op.minAmountB;
      return {
        type: op.type,
        description: `Withdraw ${op.amount} LP tokens from liquidity pool ${op.liquidityPoolId}`,
        details,
      };
    case 'invokeHostFunction':
      return {
        type: op.type,
        description: 'Invoke a Soroban smart contract function',
        details,
      };
    case 'extendFootprintTtl':
      details.extendTo = op.extendTo;
      return {
        type: op.type,
        description: `Extend contract footprint TTL to ${op.extendTo} ledgers`,
        details,
      };
    case 'restoreFootprint':
      return { type: op.type, description: 'Restore contract footprint', details };
    case 'inflation':
      return { type: op.type, description: 'Run inflation', details };
    default: {
      // Exhaustiveness guard: a new SDK operation type will fail to compile here.
      const exhaustiveCheck: never = op;
      void exhaustiveCheck;
      return { type: 'unknown', description: 'Unrecognized operation type', details };
    }
  }
}

function describeSetOptions(
  op: Extract<OperationRecord, { type: 'setOptions' }>,
  details: Record<string, string | number | boolean | null>,
): OperationSummary {
  const parts: string[] = [];
  if (op.masterWeight !== undefined) {
    details.masterWeight = op.masterWeight;
    parts.push(`master key weight ${op.masterWeight}`);
  }
  if (op.lowThreshold !== undefined) {
    details.lowThreshold = op.lowThreshold;
    parts.push(`low threshold ${op.lowThreshold}`);
  }
  if (op.medThreshold !== undefined) {
    details.medThreshold = op.medThreshold;
    parts.push(`medium threshold ${op.medThreshold}`);
  }
  if (op.highThreshold !== undefined) {
    details.highThreshold = op.highThreshold;
    parts.push(`high threshold ${op.highThreshold}`);
  }
  if (op.inflationDest !== undefined) {
    details.inflationDest = op.inflationDest;
    parts.push(`inflation destination ${op.inflationDest}`);
  }
  if (op.homeDomain !== undefined) {
    details.homeDomain = op.homeDomain;
    parts.push(`home domain "${op.homeDomain}"`);
  }
  if (op.setFlags !== undefined) {
    details.setFlags = op.setFlags;
    parts.push(`set flags ${op.setFlags}`);
  }
  if (op.clearFlags !== undefined) {
    details.clearFlags = op.clearFlags;
    parts.push(`clear flags ${op.clearFlags}`);
  }
  if (op.signer !== undefined) {
    details.signerKey = signerKeyLabel(op.signer);
    details.signerWeight = op.signer.weight ?? 0;
    parts.push(`signer ${signerKeyLabel(op.signer)} (weight ${op.signer.weight ?? 0})`);
  }

  const description =
    parts.length > 0 ? `Set account options: ${parts.join('; ')}` : 'Set account options';
  return { type: op.type, description, details };
}

export function describeTransaction(transaction: Transaction): TransactionSummary {
  const memo = transaction.memo;
  const memoSummary =
    memo.type === 'none'
      ? null
      : { type: memo.type, value: describeMemoValue(memo.type, memo.value) };

  const timeBounds = transaction.timeBounds;

  return {
    source: transaction.source,
    fee: transaction.fee,
    sequence: transaction.sequence,
    memo: memoSummary,
    timeBounds: timeBounds
      ? { minTime: timeBounds.minTime, maxTime: timeBounds.maxTime }
      : null,
    operations: transaction.operations.map((op) => describeOperation(op)),
    signaturesAttachedToEnvelope: transaction.signatures.length,
  };
}

function describeMemoValue(type: string, value: string | Buffer | null | undefined): string {
  if (value === undefined || value === null) return '';
  if (type === 'text') return String(value);
  if (typeof value === 'string') return value;
  return `0x${value.toString('hex')}`;
}
