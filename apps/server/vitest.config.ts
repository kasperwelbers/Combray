import { defineConfig } from 'vitest/config';

// Each test starts its own server process; store tests hash passwords with the production
// Argon2 cost, so give them time.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
