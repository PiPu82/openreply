import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // Deliberately not Europe/Berlin: a zone bug is invisible on a machine
    // that already sits in the target zone. Running the suite in UTC is the
    // same footing the containers are on.
    env: { TZ: "UTC" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
