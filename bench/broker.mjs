// A real broker (test kit) with prototype runtimes registered as loopback
// providers, the way a published slot definition would run. Each runtime does
// what the declarative runtime will do per tools/call: check the arguments,
// fill a precompiled path template, call the REST API, read the body under a
// size cap, parse it, project it, answer structuredContent.
import { request, Agent } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { LoopbackTransport } from "@cyanmycelium/mcp-core";
import { startTestBroker } from "@cyanmycelium/mcp-broker/testing";
import { callerReferenceOf } from "@cyanmycelium/mcp-broker-provider";

const targetPort = Number(process.argv[2]);
const MAX_BYTES = 8 * 1024 * 1024;

const broker = await startTestBroker({
    callers: { bench: {} },
    providers: { openapi: { allowedResources: ["/bench/**"] } },
    policy: {
        slotResources: { echo: "/bench/echo", rest: "/bench/rest", restnoka: "/bench/restnoka", restgov: "/bench/restgov" },
        roles: { caller: { capabilities: ["mcp.tools.call", "mcp.tools.list", "bench.valve.read"] } },
        assignments: [{ id: "bench", subject: "user:bench", role: "caller", resource: "/bench/**" }],
    },
});

const keepAlive = new Agent({ keepAlive: true, maxSockets: 256 });
const ID = /^V-\d{1,6}$/;
// Precompiled once, at load: the path template of `getValve`.
const pathOf = (args) => `/valves/${encodeURIComponent(args.id)}?size=${args.size ?? 1024}`;

function get(path, agent) {
    return new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: targetPort, path, agent }, (res) => {
            const chunks = [];
            let length = 0;
            res.on("data", (chunk) => {
                length += chunk.length;
                if (length > MAX_BYTES) req.destroy(new Error("response too large"));
                else chunks.push(chunk);
            });
            res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
    });
}

// Projection: keep the fields an agent needs, drop the rest.
const project = (doc) => ({ count: doc.items.length, items: doc.items.slice(0, 20).map((v) => ({ id: v.id, position: v.position, state: v.state })) });

function runtime(slot, { agent, http = true, govern = false }) {
    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const handle = broker.tunnel.registerLoopbackProvider(slot, clientEnd, { principal: { id: "openapi", allowedResources: ["/bench/**"] } });
    serverEnd.onMessage = (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return;
        const reply = (result) => serverEnd.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        const fail = (text) => reply({ isError: true, content: [{ type: "text", text }] });
        if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", serverInfo: { name: slot, version: "0" }, capabilities: { tools: {} } });
        if (msg.method !== "tools/call") return reply({});
        if (!http) return reply({ content: [{ type: "text", text: "ok" }] });

        const args = msg.params?.arguments ?? {};
        if (typeof args.id !== "string" || !ID.test(args.id)) return fail("id: expected V-<n>");
        const call = async () => {
            if (govern) {
                const caller = callerReferenceOf(msg.params?._meta);
                const outcome = await handle.authorize({
                    principal: { type: "caller-ref", ref: caller.ref },
                    checks: [{ capability: "bench.valve.read", resource: `valve:${args.id}`, resourcePath: `/bench/valves/${args.id}` }],
                });
                if (!outcome.result?.decisions?.[0]?.allowed) return fail(`denied: ${JSON.stringify(outcome)}`);
            }
            const res = await get(pathOf(args), agent);
            if (res.status >= 400) return fail(`HTTP ${res.status}`);
            const projected = project(JSON.parse(res.text));
            reply({ structuredContent: projected, content: [{ type: "text", text: JSON.stringify(projected) }] });
        };
        call().catch((err) => fail(String(err)));
    };
    serverEnd.connect?.();
    return handle;
}

runtime("echo", { http: false });
runtime("rest", { agent: keepAlive });
runtime("restnoka", { agent: false });
const gov = runtime("restgov", { agent: keepAlive, govern: true });
const declared = await gov.declare({ version: "1", domain: "bench", namespace: { resource: "/bench" }, capabilities: ["bench.valve.read"] });

const lag = monitorEventLoopDelay({ resolution: 1 });
process.on("message", (m) => {
    if (m === "lag:reset") {
        lag.reset();
        lag.enable();
        process.send({ lagReset: true });
    } else if (m === "lag:read") {
        lag.disable();
        process.send({ lag: { p50: lag.percentile(50) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 } });
    } else if (m === "stop") {
        void broker.stop().then(() => process.exit(0));
    }
});
process.send({ url: broker.url, declared });
