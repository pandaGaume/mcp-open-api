// Check the compiled broker CLI and this package's compiled plugin together.
// Build both repositories, then run:
// node scripts/plugin-check.mjs ../mcp-broker/node/packages/broker
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { compile, sha256 } from "../dist/compiler/index.js";
import { generateSigningKeys, signManifest } from "../dist/host/index.js";

if (!process.argv[2] || (process.argv[2] === "--docker" && !process.argv[3]))
    throw new Error("usage: node scripts/plugin-check.mjs <built-broker-package-directory> | --docker <image>");
const dockerImage = process.argv[2] === "--docker" ? process.argv[3] : undefined;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const brokerBin = dockerImage ? undefined : resolve(process.argv[2], "dist/bin.js");
const work = mkdtempSync(join(tmpdir(), "open-api-plugin-check-"));
const containerName = basename(work);
const sessions = [];
let child;
let exited;
let output = "";
let credential;
const api = createServer((req, res) => {
    credential = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "V-012", state: "open", position: 42 }));
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

try {
    await new Promise((done) => api.listen(0, dockerImage ? "0.0.0.0" : "127.0.0.1", done));
    const baseUrl = `http://${dockerImage ? "host.docker.internal" : "127.0.0.1"}:${api.address().port}/api/v2`;
    const probe = createTcpServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
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
                    description: "Reads a valve.",
                    args: { "path.id": { name: "vanne" }, "query.debug": { hide: true } },
                    output: { pick: ["id", "state"] },
                    authorization: { capability: "valves.read", resourcePath: "valves/{path.id}" },
                },
            },
        },
        spec,
    });
    assert.ok(result.manifest, JSON.stringify(result.diagnostics));
    const keys = generateSigningKeys();
    writeFileSync(join(work, "vannes.json"), result.canonical);
    writeFileSync(join(work, "vannes.json.sig"), JSON.stringify(signManifest(result.manifest, keys.privateKeyPem)));
    writeFileSync(join(work, "operator.pub.pem"), keys.publicKeyPem);
    writeFileSync(
        join(work, "security.json"),
        JSON.stringify({
            providers: [{ id: "plugin-check", secretEnv: "PLUGIN_CHECK_PROVIDER", allowedResources: ["/site/**"] }],
            auth: {
                dev: {
                    callers: [
                        { id: "operator", tokenEnv: "PLUGIN_CHECK_CALLER" },
                        { id: "ungranted", tokenEnv: "PLUGIN_CHECK_UNGRANTED" },
                    ],
                    ...(dockerImage ? { networks: ["lan"] } : {}),
                },
                slotResources: { vannes: "/site/nord/vannes" },
                roles: { operator: { capabilities: ["mcp.tools.call", "mcp.tools.list", "valves.read"] } },
                assignments: [{ id: "operator", subject: "user:operator", role: "operator", resource: "/site/**" }],
            },
        })
    );
    writeFileSync(
        join(work, "config.json"),
        JSON.stringify({
            host: dockerImage ? "0.0.0.0" : "127.0.0.1",
            port: dockerImage ? 3000 : port,
            securityFile: "security.json",
            pluginsDirectory: dockerImage ? "/opt/mcp-broker-plugins" : root,
            plugins: [
                {
                    id: "valves",
                    module: "@cyanmycelium/mcp-open-api/plugin",
                    provider: "plugin-check",
                    aggregate: true,
                    config: {
                        manifests: ["vannes.json"],
                        trustedKeys: ["operator.pub.pem"],
                        allowedTargets: [new URL(baseUrl).origin],
                        secrets: { ot: { env: "PLUGIN_CHECK_API" } },
                    },
                },
            ],
        })
    );
    // Start with a controlled environment, so a local broker installation cannot
    // silently override the isolated test config with inherited MCP_BROKER_* values.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MCP_BROKER_")));
    child = spawn(
        dockerImage ? "docker" : process.execPath,
        dockerImage
            ? [
                  "run",
                  "--rm",
                  "--name",
                  containerName,
                  "--add-host",
                  "host.docker.internal:host-gateway",
                  "-p",
                  `127.0.0.1:${port}:3000`,
                  "--mount",
                  `type=bind,source=${work},target=/config,readonly`,
                  "-e",
                  "MCP_BROKER_CONFIG=/config/config.json",
                  "-e",
                  "PLUGIN_CHECK_PROVIDER",
                  "-e",
                  "PLUGIN_CHECK_CALLER",
                  "-e",
                  "PLUGIN_CHECK_UNGRANTED",
                  "-e",
                  "PLUGIN_CHECK_API",
                  dockerImage,
              ]
            : [brokerBin],
        {
            cwd: work,
            env: {
                ...env,
                MCP_BROKER_CONFIG: join(work, "config.json"),
                PLUGIN_CHECK_PROVIDER: "plugin-provider-check",
                PLUGIN_CHECK_CALLER: "plugin-caller-check",
                PLUGIN_CHECK_UNGRANTED: "plugin-ungranted-check",
                PLUGIN_CHECK_API: "plugin-api-check",
            },
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
    exited = once(child, "close");
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const deadline = Date.now() + 15000;
    while (!output.includes("[plugin:valves] started")) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`plugin startup failed:\n${output}`);
        await sleep(50);
    }

    const connect = async (slot, token) => {
        const url = `http://127.0.0.1:${port}/${slot}/mcp`;
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
        const init = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 0,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-check", version: "1" } },
            }),
        });
        const session = init.headers.get("mcp-session-id");
        await init.text();
        assert.ok(session, `initialize ${slot}: HTTP ${init.status}`);
        const sessionHeaders = { ...headers, "mcp-session-id": session };
        sessions.push({ url, headers: sessionHeaders });
        return async (method, params = {}) => {
            const response = await fetch(url, { method: "POST", headers: sessionHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
            const text = await response.text();
            return JSON.parse(
                text.startsWith("event:") || text.startsWith("data:")
                    ? text
                          .split("\n")
                          .find((line) => line.startsWith("data:"))
                          .slice(5)
                    : text
            );
        };
    };
    const direct = await connect("vannes", "plugin-caller-check");
    const tools = await direct("tools/list");
    assert.ok(tools.result.tools.some((tool) => tool.name === "lire_vanne"));
    const answer = await direct("tools/call", { name: "lire_vanne", arguments: { vanne: "V-012" } });
    assert.deepEqual(answer.result?.structuredContent, { id: "V-012", state: "open" });
    assert.equal(credential, "Bearer plugin-api-check");
    const aggregate = await connect("_all", "plugin-caller-check");
    let aggregated;
    while (Date.now() < deadline) {
        aggregated = (await aggregate("tools/list")).result?.tools.find((tool) => tool.name.includes("lire_vanne"));
        if (aggregated) break;
        await sleep(50);
    }
    assert.ok(aggregated, "slot did not join _all");
    assert.deepEqual((await aggregate("tools/call", { name: aggregated.name, arguments: { vanne: "V-012" } })).result?.structuredContent, { id: "V-012", state: "open" });
    const denied = await connect("vannes", "plugin-ungranted-check");
    const refusal = await denied("tools/call", { name: "lire_vanne", arguments: { vanne: "V-012" } });
    assert.ok(refusal.error || refusal.result?.isError, "ungranted caller was accepted");
    console.log("plugin-check passed: compiled CLI loaded the plugin by configuration, verified its signature, served direct and aggregated calls, and denied an ungranted caller");
} finally {
    for (const session of sessions) {
        try {
            await fetch(session.url, { method: "DELETE", headers: session.headers });
        } catch {
            // The child may already have exited after a startup failure.
        }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
        if (dockerImage) await promisify(execFile)("docker", ["stop", "--time", "5", containerName]);
        else child.kill("SIGTERM");
        await exited;
        if (dockerImage) {
            assert.equal(child.exitCode, 0, `container did not stop cleanly:\n${output}`);
            assert.ok(output.includes("[plugin:valves] stopped"), "plugin cleanup was not completed before container exit");
        }
    }
    await new Promise((done) => api.close(done));
    rmSync(work, { recursive: true, force: true });
}
