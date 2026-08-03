/**
 * Signature and signer verification.
 *
 * The security model requires that signer membership and thresholds are always
 * resolved LIVE from the network (see HorizonAccountGateway), never from client
 * input and never from a stale cache: an account's signer list can change at
 * any time, and a client claiming to be a signer must be rejected unless the
 * network agrees right now.
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { AccountGateway, AccountState, NetworkName } from './types.js';

/** True if `value` looks like a Stellar ed25519 public key (G...). */
export function isPlausiblePublicKey(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/** A key is a real signer only if it appears in the live signer list with weight > 0. */
export function isRegisteredSigner(state: AccountState, publicKey: string): boolean {
  return state.signers.some((signer) => signer.key === publicKey && signer.weight > 0);
}

/** The signer's CURRENT weight per the live network state; 0 if no longer a signer. */
export function signerWeight(state: AccountState, publicKey: string): number {
  return state.signers.find((signer) => signer.key === publicKey)?.weight ?? 0;
}

/** Total weight contributed by the given signed keys, using current live weights. */
export function currentWeightSum(state: AccountState, signedKeys: readonly string[]): number {
  return signedKeys.reduce((sum, key) => sum + signerWeight(state, key), 0);
}

/**
 * Verifies a detached ed25519 signature against the transaction's signature-base
 * hash and the given public key. Returns false on any failure; never throws.
 */
export function verifyDetachedSignature(transactionHash: Buffer, signerPublicKey: string, signature: Buffer): boolean {
  try {
    return Keypair.fromPublicKey(signerPublicKey).verify(transactionHash, signature);
  } catch {
    return false;
  }
}

/**
 * Resolves an account's real signer list and threshold live from the network.
 * Callers must pass an injectable gateway (tests substitute a fake).
 */
export async function resolveAccountState(
  accountGateway: AccountGateway,
  sourceAccount: string,
  network: NetworkName,
): Promise<AccountState> {
  return accountGateway.fetchAccountState(sourceAccount, network);
}
