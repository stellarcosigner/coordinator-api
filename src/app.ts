/**
 * Fastify application factory. Building the app is separate from listening so
 * the full HTTP surface can be exercised in tests via app.inject().
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { registerRoutes } from './routes.js';
import type { Store } from './store.js';
import type { AccountGateway, SubmissionGateway } from './types.js';

export interface AppDeps {
  config: Config;
  store: Store;
  accountGateway: AccountGateway;
  submissionGateway: SubmissionGateway;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.config.logLevel },
  });

  // Migrations run at boot; they are idempotent and tracked in schema_migrations.
  await deps.store.migrate();

  if (deps.config.corsOrigin.length > 0) {
    await app.register(cors, { origin: deps.config.corsOrigin });
  }

  await app.register(async (instance) => {
    await registerRoutes(instance, deps);
  });

  return app;
}
