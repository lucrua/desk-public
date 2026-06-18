import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { globalSetup: "./src/test/global-setup.ts", setupFiles: ["./src/test/setup-env.ts"], fileParallelism: false, env: { AUTH_MODE: "dev" } },
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
});
