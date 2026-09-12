import { defineConfig } from '@playwright/test';

/**
 * Smoke test against a running NATS Explorer (default http://localhost:3002)
 * and a NATS server with JetStream (default nats://localhost:4230, see dev/).
 *
 *   NE_URL=http://localhost:3002 NATS_URL=nats://localhost:4230 bun run --filter e2e test
 *
 * PW_CHROME=/usr/bin/google-chrome uses a locally installed Chrome instead of
 * the Playwright-managed Chromium.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  // The files share one backend and disconnect it in beforeAll: run them one after another.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.NE_URL ?? 'http://localhost:3002',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : undefined,
  },
});
