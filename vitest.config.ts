import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so unit tests skip the PWA and Tailwind plugins.
export default defineConfig({
  test: {
    include: ['app/src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'tests/eval/**/*.test.ts'],
    environment: 'node',
  },
});
