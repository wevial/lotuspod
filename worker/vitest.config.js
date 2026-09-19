import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { experimental_readRawConfig } from "wrangler";

const configPath = fileURLToPath(new URL("./wrangler.toml", import.meta.url));
const fixtureAssets = fileURLToPath(new URL("./test/fixtures/assets", import.meta.url));

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
        },
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
    // wrangler.toml as wrangler parses it, and as written, for the tests.
    provide: {
      wranglerConfig: JSON.parse(
        JSON.stringify(experimental_readRawConfig({ config: configPath }).rawConfig),
      ),
      wranglerConfigText: readFileSync(configPath, "utf8"),
    },
  },
});
