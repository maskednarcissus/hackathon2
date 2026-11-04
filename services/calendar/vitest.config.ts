import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Inline PostCSS config stops Vite from searching parent package.json files (the root one has a BOM).
  css: { postcss: {} },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
