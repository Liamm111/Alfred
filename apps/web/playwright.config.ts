import { defineConfig, devices } from '@playwright/test';
import { E2E_DB, OUTBOX } from './e2e/support';

const WEB = 'http://127.0.0.1:3100';
const API = 'http://127.0.0.1:4100';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './e2e/global-setup.ts',
  timeout: 45_000,
  workers: 1, // one shared DB / mail outbox
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    // Sandbox without `playwright install`: point at a preinstalled Chromium. CI leaves this unset.
    ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  webServer: [
    {
      command: 'node ../api/dist/server.js',
      url: `${API}/health/live`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? '',
        APP_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: E2E_DB,
        API_PORT: '4100',
        PUBLIC_WEB_ORIGIN: WEB,
        EMAIL_TRANSPORT: 'file',
        EMAIL_OUTBOX_DIR: OUTBOX,
        AUTH_MAGIC_LINK_MAX_PER_MIN: '100',
        MIGRATIONS_DIR: '../../packages/db/drizzle',
      },
    },
    {
      command: 'next start -p 3100',
      url: `${WEB}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', NEXT_DIST_DIR: '.next-e2e', API_ORIGIN: API },
    },
  ],
});
