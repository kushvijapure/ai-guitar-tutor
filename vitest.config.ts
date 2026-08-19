import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure DSP and geometry — no DOM needed, and node is much faster to start.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
