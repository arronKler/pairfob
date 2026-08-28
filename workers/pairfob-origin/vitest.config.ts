import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.e2e.jsonc" },
      miniflare: {
        bindings: {
          OPERATOR_TOKEN: "dev-operator",
          IP_HASH_PEPPER: "dev-pepper-not-for-prod",
          BUILD: "test",
          INTENT_PAD_MS: "0",
        },
      },
    }),
  ],
  test: {
    include: ["e2e/wrangler/**/*.ts"],
    provide: { migrations },
  },
});
