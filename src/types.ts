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

export interface StoredSignature {
  signerPublicKey: string;
  /** base64-encoded 64-byte ed25519 signature over the transaction's signature-base hash */
  signature: string;
  /** the signer's weight as recorded from the live network state at signing time */
  weight: number;
  createdAt: string;
}
