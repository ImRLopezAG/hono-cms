import { defineConfig, devices } from "@playwright/test";

const ADMIN_PORT = Number(process.env.PLAYWRIGHT_ADMIN_PORT ?? 5173);
const CMS_PORT = Number(process.env.PLAYWRIGHT_CMS_PORT ?? 8787);
const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}`;
const CMS_URL = `http://127.0.0.1:${CMS_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 7_500 },
  use: {
    baseURL: ADMIN_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command: "bun src/dev-server.ts",
      cwd: "../../examples/newsroom",
      url: `${CMS_URL}/cms/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { PORT: String(CMS_PORT) }
    },
    {
      command: `vite --host 127.0.0.1 --port ${ADMIN_PORT}`,
      url: ADMIN_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { VITE_CMS_API_URL: CMS_URL }
    }
  ]
});
