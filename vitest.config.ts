import { defineConfig } from "vitest/config";

export default defineConfig({
  // Server tests run whole Monte Carlo simulations; a shared CI runner is several times slower than a laptop.
  test: { include: ["src/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
});
