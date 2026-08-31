import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Private Windows fixtures use bounded PowerShell processes; avoid startup contention.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    pool: "threads",
  },
});
