import { defineConfig } from "tsup";

export default defineConfig({
    entry: { index: "src/index.ts", "compiler/index": "src/compiler/index.ts", "host/index": "src/host/index.ts", "designer/index": "src/designer/index.ts", bin: "src/bin.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    platform: "node",
    external: ["@cyanmycelium/mcp-core"],
});
