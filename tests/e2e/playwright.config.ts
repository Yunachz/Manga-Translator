import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Run from the repository root:
 *
 *   npx playwright test -c tests/e2e/playwright.config.ts
 *
 * Specs use the `.e2e.ts` suffix so Vitest never collects them.
 *   fixtures.e2e.ts          Fixture reader only. Works with any Playwright Chromium.
 *   extension-smoke.e2e.ts   Needs the unpacked build and full Chromium (`npx playwright install chromium`).
 */
export default defineConfig({
  testDir: here,
  testMatch: '**/*.e2e.ts',
  outputDir: resolve(here, '../../test-results/e2e'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
