/**
 * HTTP route registration. There is deliberately no "list requests" endpoint:
 * pending transactions are only reachable via their exact, unguessable ID.
 */
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app.js';

export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/health', async () => {
    await deps.store.ping();
    return { status: 'ok' };
  });
}
