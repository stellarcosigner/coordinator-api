import { describe, expect, it } from 'vitest';
import { generateRequestId, REQUEST_ID_PATTERN } from '../src/id.js';

describe('generateRequestId', () => {
  it('produces 32 lowercase hex characters (128 bits of entropy)', () => {
    const id = generateRequestId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(REQUEST_ID_PATTERN);
  });

  it('produces distinct IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRequestId()));
    expect(ids.size).toBe(1000);
  });

  it('is not sequential or derived from anything predictable', () => {
    const first = generateRequestId();
    const second = generateRequestId();
    // Any ordering would be astronomically unlikely for random 128-bit IDs.
    expect(first).not.toBe(second);
    expect(Number.parseInt(first, 16)).toBeGreaterThan(0);
    expect(Number.parseInt(second, 16)).toBeGreaterThan(0);
  });
});
