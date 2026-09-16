/**
 * Shared types for the Stellar multisig coordinator.
 */

export type NetworkName = 'testnet' | 'mainnet';

export type RequestStatus = 'pending' | 'submitted' | 'expired';

export interface AccountSigner {
  key: string;
  weight: number;
}

/**
 * The real signer list and threshold of an account, as read from the network.
 * Never derived from client input.
 */
export interface AccountState {
  signers: AccountSigner[];
  /**
   * The account's medium threshold. Stellar transactions execute operations at
   * the medium threshold by default, so this is the threshold a transaction's
   * signatures must meet.
   */
  threshold: number;
}

export interface AccountGateway {
  fetchAccountState(sourceAccount: string, network: NetworkName): Promise<AccountState>;
}

export interface SubmissionResult {
  hash: string;
}

export interface SubmissionGateway {
  submitTransaction(signedEnvelopeXdr: string, network: NetworkName): Promise<SubmissionResult>;
}

/** A transaction record the network has authoritatively confirmed by hash. */
export interface TransactionLookupResult {
  /** The hash as reported by the network for the found record (not derived locally). */
  hash: string;
  /** Whether the transaction was applied successfully, per the network's own record. */
  successful: boolean;
}

export interface TransactionLookupGateway {
  /**
   * Looks up a transaction by its hash. Resolves to the record when the network
   * has it, resolves to null when the network reports the hash does not exist
   * (which may just mean propagation/indexing delay — callers must not treat
   * this as proof the transaction was never submitted), and throws for any
   * other network/transport failure.
   */
  findTransactionByHash(hash: string, network: NetworkName): Promise<TransactionLookupResult | null>;
}

export interface StoredSignature {
  signerPublicKey: string;
  /** base64-encoded 64-byte ed25519 signature over the transaction's signature-base hash */
  signature: string;
  /** the signer's weight as recorded from the live network state at signing time */
  weight: number;
  createdAt: string;
}

/** Minimal structured-logger surface used by background jobs. Fastify's logger satisfies it. */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
