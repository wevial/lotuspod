import { applyD1Migrations, env } from "cloudflare:test";

// The migrations as vitest.config.js read them, applied to the local D1.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
