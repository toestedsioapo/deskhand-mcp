import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**", ".superpowers/**"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-no-network.ts"],
  },
});
