import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve-release.mjs --port 4173',
    url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI,
  },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: '.work/management-e2e.json' }]],
});
