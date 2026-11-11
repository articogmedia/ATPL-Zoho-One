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
    {
      name: "desktop-chromium",
      testIgnore: "**/responsive-layout.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Pixel 7",
      testIgnore: "**/responsive-layout.spec.ts",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "iPhone 14",
      testIgnore: "**/responsive-layout.spec.ts",
      use: { ...devices["iPhone 14"] },
    },
    {
      name: "iPhone-390x844",
      testMatch: "**/responsive-layout.spec.ts",
      use: { ...devices["iPhone 14"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" },
    },
    {
      name: "Android-360x800",
      testMatch: "**/responsive-layout.spec.ts",
      use: { ...devices["Pixel 7"], viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, serviceWorkers: "block" },
    },
    {
      name: "Tablet-768x1024",
      testMatch: "**/responsive-layout.spec.ts",
      use: { ...devices["iPad Mini"], viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, serviceWorkers: "block" },
    },
    {
      name: "Laptop-1366x768",
      testMatch: "**/responsive-layout.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 }, isMobile: false, hasTouch: false, serviceWorkers: "block" },
    },
    {
      name: "Desktop-1920x1080",
      testMatch: "**/responsive-layout.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false, serviceWorkers: "block" },
    },
  ],
  webServer: {
    command: "npm run build && npm run start -- --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 300_000,
    env: {
      AUTH_MODE: "demo",
      ALLOW_DEMO_LOGIN: "true",
      DATA_SOURCE: "mock",
      SESSION_SECRET: "playwright-quotation-test-session-secret-32chars",
      ATPL_CALLING_USERNAME: "calling",
      ATPL_CALLING_PASSWORD: "playwright-calling-password",
      ATPL_CALLING_NAME: "Calling Team",
      ATPL_RESHMA_PASSWORD: "playwright-reshma-password",
      ATPL_PAVAN_PASSWORD: "playwright-pavan-password",
      ATPL_SAIKIRAN_PASSWORD: "playwright-saikiran-password",
    },
  },
});
