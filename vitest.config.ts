import { defineConfig } from 'vitest/config';

// Vitest requires a default export from its config file.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
