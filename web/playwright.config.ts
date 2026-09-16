import { defineConfig } from "@playwright/test";
const baseURL = `http://127.0.0.1:4173${process.env.BASE_PATH || "/"}`;
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
  },
});
