import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// Tests run against the sources: no build needed.
export default defineConfig({
    resolve: {
        alias: [{ find: /^@cyanmycelium\/mcp-open-api$/, replacement: source("index.ts") }],
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
