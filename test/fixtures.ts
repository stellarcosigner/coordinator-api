/**
 * Test fixtures: real Stellar transactions built with @stellar/stellar-sdk so
 * the XDR parsing, signature verification, and envelope assembly code paths are
 * exercised against genuine artifacts.
 */
import { Account, Asset, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';

export interface SignerFixture {
  keypair: Keypair;
  publicKey: string;
}

export function makeSigners(count: number): SignerFixture[] {
  return Array.from({ length: count }, () => {
    const keypair = Keypair.random();
    return { keypair, publicKey: keypair.publicKey() };
  });
}

/** Builds a payment transaction from `sourceAccount` to `destination` on testnet. */
export function buildPaymentTransaction(sourceAccount: string, destination: string): Transaction {
  const source = new Account(sourceAccount, '1234567890');
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '10.5' }))
    .setTimeout(300)
    .build();
}

/** Builds a multi-operation transaction (payment + create account + data entry) with a memo. */
export function buildMixedOperationsTransaction(
  sourceAccount: string,
  destination: string,
  newAccount: string,
  dataName: string,
  dataValue: string,
): Transaction {
  const source = new Account(sourceAccount, '1234567890');
  return new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    memo: Memo.text('coordinator fixture'),
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: '10' }))
    .addOperation(Operation.createAccount({ destination: newAccount, startingBalance: '1' }))
    .addOperation(Operation.manageData({ name: dataName, value: Buffer.from(dataValue, 'utf8') }))
    .setTimeout(300)
    .build();
}

/** Builds a transaction that changes the account's own multisig setup. */
export function buildSetOptionsTransaction(
  sourceAccount: string,
  signerToAdd: string,
  newThreshold: number,
): Transaction {
  const source = new Account(sourceAccount, '1234567890');
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: signerToAdd, weight: 1 },
        medThreshold: newThreshold,
      }),
    )
    .setTimeout(300)
    .build();
}

/** Produces the detached base64 signature of `keypair` over the transaction hash. */
export function signTransaction(transaction: Transaction, keypair: Keypair): string {
  return keypair.sign(transaction.hash()).toString('base64');
}
