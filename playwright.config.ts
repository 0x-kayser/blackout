import { defineConfig, devices } from "@playwright/test";

// Builds the web app, then runs the API serving dist/ on one origin (the production shape).
const PORT = 8898;
export default defineConfig({
  testDir: "tests/e2e/browser",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: `pnpm build:web && rm -f /tmp/blackout-e2e.sqlite* && PORT=${PORT} DATABASE_PATH=/tmp/blackout-e2e.sqlite LOG_JSON=false WORLD_INPUTS=off EXCHANGE_ALLOW_GUESTS=true WEB_ORIGINS=http://127.0.0.1:${PORT} pnpm --filter @blackout/api start`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
