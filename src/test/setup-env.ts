import { afterAll } from "vitest";
import { config } from "dotenv";

// globalSetup fills the runner-process env; forked workers inherit it.
// Re-running dotenv here is a safety net for non-fork pools that start
// before the runner env is fully propagated.
config({ path: ".env.local" });

// Tear down the postgres pool after every test suite that imports this
// setup file. Dynamic import ensures workers that never touch the DB
// don't accidentally open a pool just by loading this module.
afterAll(async () => {
  const { sql } = await import("@/db");
  await sql.end({ timeout: 1 });
});
