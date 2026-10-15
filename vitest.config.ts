import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // DB tests share one Postgres database; run files serially.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
