import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { experimental_readRawConfig } from "wrangler";

const configPath = fileURLToPath(new URL("./wrangler.toml", import.meta.url));
const fixtureAssets = fileURLToPath(new URL("./test/fixtures/assets", import.meta.url));
const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath },
      miniflare: {
        // The settings provisioning supplies, at a reserved example domain.
        bindings: {
          ACCESS_TEAM_DOMAIN: "team.example.com",
          ACCESS_AUD: "fixture-audience-tag",
          ALLOWED_EMAIL: "maintainer@example.org",
          MACHINE_CLIENT_ID: "fixture-machine.access",
          CSRF_SECRET: "fixture-csrf-secret-not-used-anywhere-real",
          // For test/apply-migrations.js, which runs inside the Worker.
          TEST_MIGRATIONS: migrations,
        },
        // A local database for the tests only: wrangler.toml takes its
        // database ids later from the provisioned inventory.
        d1Databases: ["DB"],
        // Serve the fixtures in place of ../publish, still Worker first.
        assets: {
          directory: fixtureAssets,
          binding: "ASSETS",
          routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: true,
          },
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.js"],
    // wrangler.toml as wrangler parses it, and as written, for the tests.
    provide: {
      wranglerConfig: JSON.parse(
        JSON.stringify(experimental_readRawConfig({ config: configPath }).rawConfig),
      ),
      wranglerConfigText: readFileSync(configPath, "utf8"),
    },
  },
});
