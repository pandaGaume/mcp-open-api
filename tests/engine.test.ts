import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { ManifestDeclarationError, ManifestEngine, ManifestLoadError, serveManifest, type IServedManifest } from "@cyanmycelium/mcp-open-api";
import { ValveApi } from "./fixtures/valve.api";
import { pompesManifest, vannesManifest } from "./fixtures/vannes.manifest";
import { McpHttpClient, errorOf } from "./fixtures/mcp.client";

const SECRET = "s3cr3t-ot-gateway-token";

let api: ValveApi;
let broker: ITestBroker;
let served: IServedManifest;
let pompes: IServedManifest;
let operator: McpHttpClient;
let visitor: McpHttpClient;

beforeAll(async () => {
    api = new ValveApi();
    await api.start();
    broker = await startTestBroker({
        callers: { operator: { groups: ["operators"] }, visitor: {} },
        providers: { "openapi-vannes": { allowedResources: ["/site/nord/**"] }, intruder: { allowedResources: ["/site/nord/**"] } },
        policy: {
            slotResources: { vannes: "/site/nord/vannes", pompes: "/site/nord/pompes", intrus: "/site/nord/intrus" },
            roles: {
                caller: { capabilities: ["mcp.tools.call", "mcp.tools.list"] },
                reader: { inherits: ["caller"], capabilities: ["valves.read", "pumps.read"] },
                operator: { inherits: ["reader"], capabilities: ["valves.write"] },
            },
            assignments: [
                { id: "operators", subject: "group:operators", role: "operator", resource: "/site/**" },
                { id: "visitors", subject: "user:visitor", role: "reader", resource: "/site/**" },
            ],
        },
    });
    served = await serveManifest(broker.tunnel, vannesManifest(api.baseUrl), {
        principal: { id: "openapi-vannes", allowedResources: ["/site/nord/**"] },
        secrets: (ref) => (ref === "otGateway" ? SECRET : undefined),
        allowedTargets: [new URL(api.baseUrl).origin],
    });
    // Broker 1.7.0: a second slot of the same identity, in its own domain, keeps the first declaration.
    pompes = await serveManifest(broker.tunnel, pompesManifest(api.baseUrl), {
        principal: { id: "openapi-vannes", allowedResources: ["/site/nord/**"] },
        secrets: (ref) => (ref === "otGateway" ? SECRET : undefined),
    });
    operator = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("operator"));
    visitor = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("visitor"));
});

afterAll(async () => {
    await pompes?.stop();
    await served?.stop();
    await broker?.stop();
    await api?.stop();
});

beforeEach(() => {
    api.received.length = 0;
});

describe("the engine behind a real broker", () => {
    it("has its declaration accepted", () => {
        expect(served.declaration).toBeDefined();
        expect("error" in served.declaration!).toBe(false);
    });

    it("lists the manifest's tools, with their schemas and annotations", async () => {
        const { result } = await operator.request("tools/list");
        const names = result.tools.map((t: { name: string }) => t.name);
        expect(names).toEqual(expect.arrayContaining(["lire_vanne", "lister_vannes", "ouvrir_vanne"]));
        const lire = result.tools.find((t: { name: string }) => t.name === "lire_vanne");
        expect(lire.annotations).toEqual({ readOnlyHint: true });
        expect(lire.inputSchema.required).toEqual(["vanne"]);
    });

    it("calls the API with the slot's credential, and returns only the picked fields", async () => {
        const result = await operator.callTool("lire_vanne", { vanne: "V-012" });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({ id: "V-012", position: 42, state: "open" });
        expect(api.received).toHaveLength(1);
        expect(api.received[0]!.url).toBe("/api/v2/valves/V-012");
        expect(api.received[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).not.toContain("not for agents");
    });

    it("forwards the W3C trace context to the API", async () => {
        await operator.callTool("lire_vanne", { vanne: "V-001" });
        expect(api.received[0]!.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    });

    it("refuses invalid arguments before any HTTP call", async () => {
        const tooHigh = await operator.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 120 });
        expect(errorOf(tooHigh)).toMatchObject({ code: "invalid_arguments", detail: { path: "/pourcent", keyword: "maximum" } });
        const badId = await operator.callTool("lire_vanne", { vanne: "../admin" });
        expect(errorOf(badId).code).toBe("invalid_arguments");
        const extra = await operator.callTool("lire_vanne", { vanne: "V-001", debug: true });
        expect(errorOf(extra).code).toBe("invalid_arguments");
        expect(api.received).toHaveLength(0);
    });

    it("lets the broker deny a write to a caller without the capability, before any HTTP call", async () => {
        const result = await visitor.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 10 });
        expect(errorOf(result).code).toBe("denied");
        expect(api.received).toHaveLength(0);
        const read = await visitor.callTool("lire_vanne", { vanne: "V-001" });
        expect(read.isError).toBeFalsy();
    });

    it("builds the body from arguments and fixed values", async () => {
        const result = await operator.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 55 });
        expect(result.structuredContent).toEqual({ id: "V-001", position: 55 });
        expect(api.received[0]!.method).toBe("PUT");
        expect(JSON.parse(api.received[0]!.body)).toEqual({ position: 55, mode: "manual" });
    });

    it("applies the engineering limits the broker returns for a declared resource", async () => {
        const over = await operator.callTool("ouvrir_vanne", { vanne: "V-012", pourcent: 50 });
        expect(errorOf(over).code).toBe("constraint_violation");
        expect(api.received).toHaveLength(0);
        const within = await operator.callTool("ouvrir_vanne", { vanne: "V-012", pourcent: 30 });
        expect(within.isError).toBeFalsy();
        // Another valve has no declared limits: only the input schema applies.
        const other = await operator.callTool("ouvrir_vanne", { vanne: "V-013", pourcent: 50 });
        expect(other.isError).toBeFalsy();
    });

    it("applies limits declared by pattern (broker 1.7.0) on top of the concrete ones", async () => {
        const over = await operator.callTool("ouvrir_vanne", { vanne: "V-123", pourcent: 70 });
        expect(errorOf(over)).toMatchObject({ code: "constraint_violation" });
        expect(errorOf(over).message).toContain("above the maximum 60");
        const within = await operator.callTool("ouvrir_vanne", { vanne: "V-123", pourcent: 55 });
        expect(within.isError).toBeFalsy();
        // Outside the V-1xx series, only the input schema applies.
        const other = await operator.callTool("ouvrir_vanne", { vanne: "V-023", pourcent: 70 });
        expect(other.isError).toBeFalsy();
    });

    it("keeps one declaration per slot: a second slot of the same identity does not erase the first (broker 1.7.0)", async () => {
        expect("error" in pompes.declaration!).toBe(false);
        const pompe = await new McpHttpClient(broker.mcpUrl("pompes"), broker.bearer("visitor")).callTool("lire_pompe", { vanne: "V-001" });
        expect(pompe.isError).toBeFalsy();
        // The first slot still has its own declaration: its reads are still allowed.
        const vanne = await visitor.callTool("lire_vanne", { vanne: "V-001" });
        expect(vanne.isError).toBeFalsy();
    });

    it("refuses to serve a slot whose declaration the broker refused", async () => {
        const intrus = { ...vannesManifest(api.baseUrl), slot: "intrus" };
        const attempt = serveManifest(broker.tunnel, intrus, {
            principal: { id: "intruder", allowedResources: ["/site/nord/**"] },
            secrets: () => SECRET,
        });
        await expect(attempt).rejects.toBeInstanceOf(ManifestDeclarationError);
        await expect(attempt).rejects.toThrow(/a domain has one owner/);
    });

    it("cuts arrays at maxItems and says so", async () => {
        const result = await operator.callTool("lister_vannes", {});
        expect(result.structuredContent.items).toHaveLength(50);
        expect(result.structuredContent.items[0]).toEqual({ id: "V-000", state: "open" });
        expect(result.content[1]!.text).toContain("items[] had 120 items");
    });

    it.each([
        ["grosse_reponse", "response_too_large"],
        ["lente", "upstream_timeout"],
        ["redirigee", "redirect_refused"],
        ["en_panne", "upstream_error"],
    ])("turns %s into %s", async (tool, code) => {
        const result = await operator.callTool(tool, {});
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(code);
    });

    it("keeps only the problem title and detail of an error body", async () => {
        const result = await operator.callTool("en_panne", {});
        expect(errorOf(result).detail).toEqual({ status: 503, title: "Gateway in maintenance", detail: "Back at 12:00" });
    });
});

describe("loading a manifest", () => {
    it("lists every problem, not only the first", () => {
        const manifest = vannesManifest("http://127.0.0.1:1/api");
        const broken = {
            ...manifest,
            tools: [
                { ...manifest.tools[0]!, http: { method: "GET" as const, path: ["/valves/", { arg: "id" }] } },
                { ...manifest.tools[1]!, authorization: { capability: "valves.delete", resourcePath: ["valves"] } },
                { ...manifest.tools[2]!, inputSchema: { type: "object", if: true } },
            ],
        };
        let error: unknown;
        try {
            new ManifestEngine(broken, { secrets: () => undefined, allowedTargets: ["https://ot-gw.local"] });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ManifestLoadError);
        const problems = (error as ManifestLoadError).problems.join("\n");
        expect(problems).toContain("not in the allowed targets");
        expect(problems).toContain('no secret "otGateway"');
        expect(problems).toContain('reads argument "id"');
        expect(problems).toContain("valves.delete is not declared");
        expect(problems).toContain("has an authorization but the engine has no guard");
        expect(problems).toContain('unsupported keyword "if"');
    });

    it("refuses a pattern RE2 does not accept", () => {
        const manifest = vannesManifest("http://127.0.0.1:1/api");
        const lookahead = {
            ...manifest,
            declaration: undefined,
            tools: [{ ...manifest.tools[3]!, inputSchema: { type: "object", properties: { x: { type: "string", pattern: "^(?=a)a$" } } } }],
        };
        expect(() => new ManifestEngine(lookahead, { secrets: () => "x" })).toThrow(/not accepted by RE2/);
    });
});
