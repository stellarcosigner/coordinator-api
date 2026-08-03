/**
 * Transaction envelope parsing and hashing. The service only ever works with
 * the exact envelope stored at creation time; every signature is verified
 * against its signature-base hash.
 */
import { FeeBumpTransaction, Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import type { NetworkName } from './types.js';

export const NETWORK_PASSPHRASES: Record<NetworkName, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

export function networkPassphrase(network: NetworkName): string {
  return NETWORK_PASSPHRASES[network];
}

export class InvalidTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionError';
  }
}

/**
 * Parses a transaction envelope XDR string. Throws InvalidTransactionError for
 * malformed XDR or unsupported envelope types (fee-bumps are rejected: the
 * fee-bump sponsor introduces an extra signature requirement this coordinator
 * does not model).
 */
export function parseTransaction(xdr: string, network: NetworkName): Transaction {
  let transaction: Transaction | FeeBumpTransaction;
  try {
    transaction = TransactionBuilder.fromXDR(xdr, networkPassphrase(network));
  } catch {
    throw new InvalidTransactionError('transactionXdr is not a valid Stellar transaction envelope');
  }
  if (transaction instanceof FeeBumpTransaction) {
    throw new InvalidTransactionError('fee-bump transactions are not supported');
  }
  return transaction;
}

/** The signature-base hash that detached signatures are verified against. */
export function transactionHash(xdr: string, network: NetworkName): Buffer {
  return parseTransaction(xdr, network).hash();
}
