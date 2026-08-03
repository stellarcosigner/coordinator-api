/**
 * Horizon adapters: the two places this service touches the Stellar network are
 * reading an account's real signer list/threshold (verify) and submitting a
 * fully-signed transaction (submit). Both are funnelled through Horizon here so
 * the rest of the service can treat the network as an injectable gateway.
 */
import { Horizon } from '@stellar/stellar-sdk';
import type { Config } from './config.js';
import type {
  AccountGateway,
  AccountState,
  NetworkName,
  SubmissionGateway,
  SubmissionResult,
} from './types.js';
import { parseTransaction } from './transaction.js';

export type HorizonServerFactory = (network: NetworkName) => Horizon.Server;

export function createHorizonServerFactory(config: Config): HorizonServerFactory {
  return (network: NetworkName): Horizon.Server => {
    const url = network === 'testnet' ? config.testnetHorizonUrl : config.mainnetHorizonUrl;
    return new Horizon.Server(url);
  };
}

/**
 * Reads an account's signer list and threshold live from the network.
 * The service never caches or trusts client-supplied signer state.
 */
export class HorizonAccountGateway implements AccountGateway {
  constructor(private readonly serverFactory: HorizonServerFactory) {}

  async fetchAccountState(sourceAccount: string, network: NetworkName): Promise<AccountState> {
    const account = await this.serverFactory(network).loadAccount(sourceAccount);
    return {
      signers: account.signers.map((signer) => ({ key: signer.key, weight: signer.weight })),
      // Operations execute at the medium threshold by default.
      threshold: account.thresholds.med_threshold,
    };
  }
}

/**
 * Submits a fully-signed transaction envelope to the network.
 */
export class HorizonSubmissionGateway implements SubmissionGateway {
  constructor(private readonly serverFactory: HorizonServerFactory) {}

  async submitTransaction(signedEnvelopeXdr: string, network: NetworkName): Promise<SubmissionResult> {
    const transaction = parseTransaction(signedEnvelopeXdr, network);
    const response = await this.serverFactory(network).submitTransaction(transaction);
    return { hash: response.hash };
  }
}
