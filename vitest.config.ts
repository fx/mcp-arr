import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    watch: false,
    testTimeout: 5_000,
    hookTimeout: 5_000,
    teardownTimeout: 5_000,
    sequence: {
      concurrent: false,
    },
  },
});
