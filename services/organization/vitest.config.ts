import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Inline PostCSS config stops Vite from walking up to JSON files saved with a UTF-8 BOM.
  css: { postcss: {} },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
