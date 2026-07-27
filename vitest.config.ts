import { defineConfig } from 'vitest/config';

const testTimeout = process.platform === 'win32' ? 120_000 : 30_000;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout,
    hookTimeout: testTimeout,
    pool: 'threads',
    // Process/fault suites spawn real trees and package fixtures. Bounding
    // workers prevents host-memory pressure without skipping tests or changing
    // any per-test deadline.
    maxWorkers: 4,
    minWorkers: 1,
  },
});
