import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "core/**/*.test.ts",
      "agents/**/*.test.ts",
      "tools/**/*.test.ts",
      "scheduler/**/*.test.ts",
      "security/**/*.test.ts",
      "apps/api/tests/**/*.test.ts",
    ],
    testTimeout: 20000,
    // Sequential test files avoid SQLite write-lock contention between
    // suites that share the same dev.db file.
    fileParallelism: false,
  },
});
