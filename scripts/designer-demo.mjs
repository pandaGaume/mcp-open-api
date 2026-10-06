// The Tier 4 page on one machine: the static page (dist/ui), and a fake valve
// API that publishes its spec and a Swagger UI-like page, with CORS so the page
// can read them. Run `npm run build` first, then open the printed URL.
//
//   node scripts/designer-demo.mjs [port]
//
// The page produces <slot>.json and its .sig; `mcp-open-api serve` then opens
// one broker slot per manifest its config lists.

import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSigningKeys } from "../dist/host/index.js";

const port = Number(process.argv[2] ?? process.env.PORT ?? 3790);
const ui = fileURLToPath(new URL("../dist/ui/", import.meta.url));
if (!existsSync(join(ui, "designer-core.js"))) {
    console.error("dist/ui is missing: run npm run build first");
    process.exit(1);
}

// The page: any static server does; this one is twenty lines.
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const pages = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://page").pathname)).replace(/^([/\\])+/, "");
    const file = join(ui, path === "" ? "index.html" : path);
    if (!file.startsWith(ui) || !existsSync(file)) {
        res.writeHead(404);
        return res.end();
    }
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
});
await new Promise((resolve) => pages.listen(port, "127.0.0.1", resolve));

// A fake OT gateway, the API the slot is designed for, and its documentation.
const valves = new Map([
    ["V-001", { id: "V-001", position: 0, state: "closed" }],
    ["V-012", { id: "V-012", position: 35, state: "open" }],
]);
const docsPage = `<!doctype html><html><head><title>OT gateway</title></head><body><div id="swagger-ui"></div>
<script src="swagger-ui-bundle.js"></script><script src="swagger-initializer.js"></script></body></html>`;
const initializer = `window.onload = () => { window.ui = SwaggerUIBundle({ url: "/api/v2/openapi.json", dom_id: "#swagger-ui" }); };`;
let spec;
const api = createServer((req, res) => {
    // Its documentation is public: any page may read it.
    res.setHeader("access-control-allow-origin", "*");
    const send = (status, body, type = "application/json") => {
        res.writeHead(status, { "content-type": type });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = new URL(req.url, "http://api");
    if (url.pathname === "/api/v2/openapi.json") return send(200, spec);
    if (url.pathname === "/docs/" || url.pathname === "/docs") return send(200, docsPage, "text/html");
    if (url.pathname === "/docs/swagger-initializer.js") return send(200, initializer, "text/javascript");
    const m = /^\/api\/v2\/valves(?:\/([^/]+))?(\/position)?$/.exec(url.pathname);
    if (!m) return send(404, { title: "not found" });
    if (req.method === "GET" && !m[1]) return send(200, { items: [...valves.values()] });
    const valve = valves.get(decodeURIComponent(m[1] ?? ""));
    if (!valve) return send(404, { title: "unknown valve" });
    if (req.method === "GET" && !m[2]) return send(200, valve);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
        valve.position = JSON.parse(raw || "{}").position ?? valve.position;
        send(200, { id: valve.id, position: valve.position });
    });
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiOrigin = `http://127.0.0.1:${api.address().port}`;
spec = JSON.parse(readFileSync(fileURLToPath(new URL("../tests/fixtures/valve.openapi.json", import.meta.url)), "utf8"));
spec.servers = [{ url: `${apiOrigin}/api/v2` }];

// An operator key and a host config, to try the signature and the host checks.
const work = mkdtempSync(join(tmpdir(), "mcp-open-api-demo-"));
const keys = generateSigningKeys();
writeFileSync(join(work, "operator.pem"), keys.privateKeyPem);
writeFileSync(join(work, "operator.pub.pem"), keys.publicKeyPem);
writeFileSync(
    join(work, "mcp-open-api.json"),
    `${JSON.stringify(
        {
            broker: { url: "ws://127.0.0.1:3000/providers" },
            manifests: ["vannes.json"],
            trustedKeys: ["operator.pub.pem"],
            allowedTargets: [apiOrigin],
            secrets: { otGateway: { env: "OT_GATEWAY_TOKEN" } },
        },
        null,
        4
    )}\n`
);

console.log(`page:        http://127.0.0.1:${port}/`);
console.log(`spec URLs:   ${apiOrigin}/docs/  or  https://petstore3.swagger.io/`);
console.log(`host config: ${join(work, "mcp-open-api.json")}`);
console.log(`signing key: ${join(work, "operator.pem")}`);

const stop = () => {
    pages.close();
    api.close();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
