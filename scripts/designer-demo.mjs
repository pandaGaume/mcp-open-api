// The designer, end to end, on one machine: a broker serving the Tier 4 page,
// a fake valve API, the designer, and an operator key. Run `npm run build`
// first, then open the printed URL.
//
//   node scripts/designer-demo.mjs [port]

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestBroker } from "@cyanmycelium/mcp-broker/testing";
import { DESIGNER_UI_DIR, startDesigner } from "../dist/designer/index.js";
import { generateSigningKeys } from "../dist/host/index.js";

const port = Number(process.argv[2] ?? process.env.PORT ?? 3790);

// A fake OT gateway: the API the slot is designed for.
const valves = new Map([
    ["V-001", { id: "V-001", position: 0, state: "closed" }],
    ["V-012", { id: "V-012", position: 35, state: "open" }],
]);
const api = createServer((req, res) => {
    const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://api");
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

const broker = await startTestBroker({
    callers: { operator: { groups: ["operators"] } },
    providers: { "openapi-designer": {} },
    policy: {
        slotResources: { designer: "/designer" },
        roles: { designer: { capabilities: ["mcp.tools.call", "mcp.tools.list"] } },
        assignments: [{ id: "designers", subject: "group:operators", role: "designer", resource: "/designer" }],
    },
    configure: (builder) =>
        builder
            .withPort(port)
            .withAllowedOrigins([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
            .withStaticMount("/ui/designer", DESIGNER_UI_DIR),
});

// The host folder the designer publishes into, and the operator's key.
const work = mkdtempSync(join(tmpdir(), "mcp-open-api-demo-"));
mkdirSync(join(work, "manifests"));
const keys = generateSigningKeys();
writeFileSync(join(work, "operator.pem"), keys.privateKeyPem);
writeFileSync(join(work, "operator.pub.pem"), keys.publicKeyPem);
const spec = {
    openapi: "3.1.0",
    info: { title: "OT gateway, valves", version: "2.0.0" },
    servers: [{ url: `${apiOrigin}/api/v2` }],
    security: [{ gatewayToken: [] }],
    paths: {
        "/valves": {
            get: {
                operationId: "listValves",
                summary: "List the valves",
                tags: ["valves"],
                responses: {
                    200: {
                        description: "ok",
                        content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { $ref: "#/components/schemas/Valve" } } } } } },
                    },
                },
            },
        },
        "/valves/{id}": {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", maxLength: 16 } }],
            get: {
                operationId: "getValve",
                summary: "Read a valve",
                tags: ["valves"],
                responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Valve" } } } } },
            },
        },
        "/valves/{id}/position": {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", maxLength: 16 } }],
            put: {
                operationId: "setValvePosition",
                summary: "Set a valve's opening",
                tags: ["valves"],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["position", "mode"],
                                properties: { position: { type: "number", minimum: 0, maximum: 150 }, mode: { type: "string", enum: ["manual", "auto"] } },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "ok",
                        content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, position: { type: "number" } } } } },
                    },
                },
            },
        },
    },
    components: {
        securitySchemes: { gatewayToken: { type: "http", scheme: "bearer" } },
        schemas: { Valve: { type: "object", properties: { id: { type: "string" }, position: { type: "number" }, state: { type: "string", enum: ["open", "closed", "fault"] } } } },
    },
};
writeFileSync(join(work, "valves.openapi.json"), JSON.stringify(spec, null, 2));

const host = {
    name: "vannes",
    baseDir: work,
    config: {
        broker: { url: broker.providersUrl },
        manifests: "manifests",
        trustedKeys: ["operator.pub.pem"],
        allowedTargets: [apiOrigin],
        secrets: { otGateway: { env: "VANNES_API_TOKEN" } },
    },
};
const designer = await startDesigner({ broker: { url: broker.providersUrl, secretEnv: "SECRET" } }, [host], {
    env: { SECRET: broker.providerSecret("openapi-designer") },
    onPublish: (event) => console.log(`published ${JSON.stringify(event)}`),
});

console.log(`page:      http://127.0.0.1:${port}/ui/designer/`);
console.log(`token:     operator`);
console.log(`spec:      ${join(work, "valves.openapi.json")}`);
console.log(`key:       ${join(work, "operator.pem")}`);
console.log(`host dir:  ${join(work, "manifests")}`);

const stop = async () => {
    await designer.stop();
    await broker.stop();
    api.close();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
