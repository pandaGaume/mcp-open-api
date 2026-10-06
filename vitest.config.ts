import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// Tests run against the sources: no build needed.
export default defineConfig({
    resolve: {
        alias: [
            { find: "@cyanmycelium/mcp-open-api/compiler", replacement: source("compiler/index.ts") },
            { find: "@cyanmycelium/mcp-open-api/host", replacement: source("host/index.ts") },
            { find: "@cyanmycelium/mcp-open-api/designer", replacement: source("designer/index.ts") },
            { find: /^@cyanmycelium\/mcp-open-api$/, replacement: source("index.ts") },
        ],
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
    },
});
