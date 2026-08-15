import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // reference_repos/ is a read-only corpus of prior art with its own test
    // suites and its own dependencies. It must never enter our runs.
    exclude: ['node_modules/**', 'dist/**', 'reference_repos/**'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
