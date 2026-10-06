// End-to-end check of the built binary, which vitest cannot do: vitest itself
// does not run where code generation is disallowed. Starts a broker, signs a
// manifest, runs `mcp-open-api serve` as a real process (it must re-launch
// itself with --disallow-code-generation-from-strings), calls a tool through
// the broker, and stops everything. Exit 0 on success.
//
//   npm run build && node scripts/serve-check.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestBroker } from "@cyanmycelium/mcp-broker/testing";
import { compile, sha256 } from "../dist/compiler/index.js";
import { generateSigningKeys, signManifest } from "../dist/host/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => {
    console.error(`serve-check FAILED: ${message}`);
    process.exit(1);
};

// The API: answers one valve, and records the credential it received.
let credential;
const api = createServer((req, res) => {
    credential = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "V-012", position: 42, state: "open", updatedAt: "2026-10-06T10:00:00Z" }));
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${api.address().port}/api/v2`;

const broker = await startTestBroker({
    callers: { operator: {} },
    providers: { "openapi-check": { allowedResources: ["/site/**"] } },
    policy: {
        slotResources: { vannes: "/site/nord/vannes" },
        roles: { operator: { capabilities: ["mcp.tools.call", "valves.read"] } },
        assignments: [{ id: "op", subject: "user:operator", role: "operator", resource: "/site/**" }],
    },
});

const spec = readFileSync(join(root, "tests/fixtures/valve.openapi.json"), "utf8");
const result = compile({
    binding: {
        binding: 1,
        slot: "vannes",
        spec: { path: "valve.openapi.json", sha256: sha256(spec) },
        target: { baseUrl, auth: { secretRef: "ot" } },
        governance: { domain: "valves", namespace: "/site/nord" },
        tools: {
            getValve: {
                name: "lire_vanne",
                description: "Lit une vanne.",
                args: { "path.id": { name: "vanne", pattern: "^V-\\d{3}$" }, "query.debug": { hide: true } },
                output: { pick: ["id", "state"] },
                authorization: { capability: "valves.read", resourcePath: "valves/{path.id}" },
            },
        },
    },
    spec,
});
if (!result.manifest) fail(JSON.stringify(result.diagnostics));

const work = mkdtempSync(join(tmpdir(), "mcp-open-api-serve-"));
const keys = generateSigningKeys();
mkdirSync(join(work, "manifests"));
writeFileSync(join(work, "operator.pub.pem"), keys.publicKeyPem);
writeFileSync(join(work, "manifests", "vannes.json"), result.canonical);
writeFileSync(join(work, "manifests", "vannes.json.sig"), JSON.stringify(signManifest(result.manifest, keys.privateKeyPem)));
writeFileSync(
    join(work, "mcp-open-api.json"),
    JSON.stringify({
        broker: { url: broker.providersUrl, secretEnv: "CHECK_PROVIDER_SECRET" },
        manifests: "manifests",
        trustedKeys: ["operator.pub.pem"],
        allowedTargets: [new URL(baseUrl).origin],
        secrets: { ot: { env: "CHECK_API_TOKEN" } },
    })
);

const child = spawn(process.execPath, [join(root, "dist/bin.js"), "serve", "--config", join(work, "mcp-open-api.json")], {
    env: { ...process.env, CHECK_PROVIDER_SECRET: broker.providerSecret("openapi-check"), CHECK_API_TOKEN: "check-token" },
    stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (b) => (output += b));
child.stderr.on("data", (b) => (output += b));

const deadline = Date.now() + 15000;
while (!output.includes('serving slot "vannes"')) {
    if (child.exitCode !== null || Date.now() > deadline) fail(`the host did not serve the slot:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
}

// The host process must run with code generation disallowed: it re-launched itself.
if (!output.includes("code generation: disallowed")) fail(`the host runs with code generation allowed:\n${output}`);

const headers = { ...broker.bearer("operator"), "content-type": "application/json", accept: "application/json, text/event-stream" };
const post = (body, session) =>
    fetch(broker.mcpUrl("vannes"), { method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
const init = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "0" } } });
const session = init.headers.get("mcp-session-id");
await init.text();
const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lire_vanne", arguments: { vanne: "V-012" } } }, session);
const text = await res.text();
const data = JSON.parse(
    text.startsWith("event:") || text.startsWith("data:")
        ? text
              .split("\n")
              .find((l) => l.startsWith("data:"))
              .slice(5)
        : text
);

child.kill("SIGTERM");
await new Promise((r) => child.on("exit", r));
await broker.stop();
api.close();

if (JSON.stringify(data.result?.structuredContent) !== JSON.stringify({ id: "V-012", state: "open" })) fail(`unexpected answer: ${text}`);
if (credential !== "Bearer check-token") fail(`the API received ${credential}`);
console.log("serve-check passed: the built host served a signed manifest through the broker");
