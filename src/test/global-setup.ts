import { config } from "dotenv";
import { execSync } from "node:child_process";

// globalSetup runs in the vitest runner process (not in forked workers).
// Calling dotenv here fills the runner's process.env; forked worker processes
// inherit that env at spawn time. setup-env.ts re-runs dotenv as a safety net
// for any non-fork pool that initialises before the inheritance takes effect.
export default function setup() {
  config({ path: ".env.local" });
  execSync(`pnpm drizzle-kit migrate`, {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    stdio: "inherit",
  });
}
