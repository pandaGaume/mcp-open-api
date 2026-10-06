import { cpSync, mkdirSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig([
    {
        entry: { index: "src/index.ts", "compiler/index": "src/compiler/index.ts", "host/index": "src/host/index.ts", "designer/index": "src/designer/index.ts", bin: "src/bin.ts" },
        format: ["esm"],
        dts: true,
        sourcemap: true,
        clean: true,
        target: "es2022",
        platform: "node",
        external: ["@cyanmycelium/mcp-core"],
    },
    {
        // The Tier 4 page: static files and the designer bundled for a browser,
        // to host anywhere. The designer, the compiler and the engine use no
        // Node API; Node's HTTP pool is only ever created by the host.
        entry: { "designer-core": "src/designer/index.ts" },
        outDir: "dist/ui",
        format: ["esm"],
        platform: "browser",
        target: "es2022",
        minify: true,
        sourcemap: true,
        dts: false,
        clean: false,
        noExternal: [/.*/],
        onSuccess: async () => {
            mkdirSync("dist/ui", { recursive: true });
            cpSync("ui", "dist/ui", { recursive: true });
        },
    },
]);
