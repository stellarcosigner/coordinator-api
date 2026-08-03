/**
 * HTTP route registration. There is deliberately no "list requests" endpoint:
 * pending transactions are only reachable via their exact, unguessable ID.
 */
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './app.js';
import { handleCreate, type CreateRequestBody } from './create.js';

const REQUEST_ID_PATTERN = '^[0-9a-f]{32}$';

export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/health', async () => {
    await deps.store.ping();
    return { status: 'ok' };
  });

  app.post<{ Body: CreateRequestBody }>(
    '/requests',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceAccount', 'transactionXdr', 'network'],
          properties: {
            sourceAccount: { type: 'string' },
            transactionXdr: { type: 'string' },
            network: { type: 'string', enum: ['testnet', 'mainnet'] },
            ttlSeconds: { type: 'integer', minimum: 60 },
          },
        },
      },
    },
    async (request, reply) => handleCreate(request, reply, deps),
  );
}
