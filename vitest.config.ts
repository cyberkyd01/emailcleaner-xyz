import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // config.ts reads the environment at import time, so the test keys must be
    // in place before any module under test is loaded.
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
