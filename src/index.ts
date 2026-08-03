/**
 * API server entry point: loads config, builds the app, and listens.
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createHorizonServerFactory, HorizonAccountGateway, HorizonSubmissionGateway } from './horizon.js';
import { createPool, Store } from './store.js';

const config = loadConfig();
const store = new Store(createPool(config.databaseUrl));
const serverFactory = createHorizonServerFactory(config);
const accountGateway = new HorizonAccountGateway(serverFactory);
const submissionGateway = new HorizonSubmissionGateway(serverFactory);

const app = await buildApp({ config, store, accountGateway, submissionGateway });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, 'failed to start server');
  await store.close();
  process.exit(1);
}
