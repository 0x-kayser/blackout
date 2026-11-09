import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 60_000,
    pool: "forks",
    // most tests drive the game through quick guest sessions; sign-in-first is tested on its own
    env: { ALLOW_GUEST_PLAY: "true" },
  },
});
