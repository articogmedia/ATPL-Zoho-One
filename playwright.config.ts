import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  workers: 1,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:3000",
    browserName: "chromium",
    headless: true,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "Pixel 7", use: { ...devices["Pixel 7"] } },
    { name: "iPhone 14", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      AUTH_MODE: "demo",
      ALLOW_DEMO_LOGIN: "true",
      DATA_SOURCE: "mock",
      SESSION_SECRET: "playwright-quotation-test-session-secret-32chars",
      ATPL_CALLING_USERNAME: "calling",
      ATPL_CALLING_PASSWORD: "playwright-calling-password",
      ATPL_CALLING_NAME: "Calling Team",
    },
  },
});
