import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      'bun:test': fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    testTimeout: 60000,
    hookTimeout: 30000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/base-*.test.ts'],
          hookTimeout: 120000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.d.ts',
        'packages/*/src/**/types.ts',
        'test/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
    },
  },
})
