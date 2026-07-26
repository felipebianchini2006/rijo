import { defineConfig } from 'vitest/config';

const testTimeout = process.platform === 'win32' ? 120_000 : 30_000;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout,
    hookTimeout: testTimeout,
    pool: 'threads',
  },
});
