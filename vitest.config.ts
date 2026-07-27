import { defineConfig } from 'vitest/config';

const testTimeout = process.platform === 'win32' ? 120_000 : 30_000;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout,
    hookTimeout: testTimeout,
    // Native SQLite bindings and process/fault fixtures need process isolation.
    // A thread pool can terminate the complete Vitest process when one native
    // worker faults. Forks keep that boundary without reducing test coverage.
    pool: 'forks',
    // Use one fork so native fault fixtures cannot delay worker result delivery.
    // Keep every test and every per-test deadline unchanged.
    maxWorkers: 1,
    minWorkers: 1,
  },
});
