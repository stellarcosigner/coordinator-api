/**
 * CLI migration runner: `npm run db:migrate`.
 */
import { loadConfig } from './config.js';
import { createPool, Store } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(createPool(config.databaseUrl));
  try {
    await store.migrate();
    console.log('Migrations applied.');
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
