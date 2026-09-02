import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4329',
    headless: true,
    video: 'off',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: '/usr/bin/google-chrome' },
  },
  webServer: {
    command: 'python3 -m http.server 4329 --directory dist',
    url: 'http://127.0.0.1:4329/limelight',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
