import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['{apps,services,packages,db,scripts,tests}/**/*.test.ts'], exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/e2e/**'] } },
      {
        test: {
          name: 'integration',
          include: ['{apps,services,packages,db,tests}/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
