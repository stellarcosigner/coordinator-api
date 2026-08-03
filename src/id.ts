/**
 * Cryptographically random, unguessable request IDs.
 *
 * IDs are 16 bytes of CSPRNG output, hex-encoded to 32 characters — 128 bits of
 * entropy. They are never sequential and never derived from anything
 * predictable (account address, timestamp, etc.), so a pending request is only
 * reachable by someone who was given its exact ID. There is no listing API.
 */
import { randomBytes } from 'node:crypto';

export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

export function generateRequestId(): string {
  return randomBytes(16).toString('hex');
}
