// Self-contained unit tests only — no MySQL, no network, no running server.
// The API suite (vitest.config.mjs, `npm test`) needs a live database and the
// app's .env; this config is what CI runs via `npm run test:ci`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.{js,mjs}'],
    reporters: ['verbose'],
  },
});
