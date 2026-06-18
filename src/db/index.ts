import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.NODE_ENV === "test" || process.env.VITEST
  ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!url) throw new Error(
  `Missing ${process.env.VITEST || process.env.NODE_ENV === "test" ? "TEST_DATABASE_URL" : "DATABASE_URL"} — check .env.local`
);

export const sql = postgres(url, { max: 5 });
export const db = drizzle(sql, { schema });
export { schema };
