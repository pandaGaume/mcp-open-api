import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { serveManifest, type IBinding, type IManifest, type IServedManifest } from "@cyanmycelium/mcp-open-api";
import { compile, sha256 } from "@cyanmycelium/mcp-open-api/compiler";
import { ValveApi } from "./fixtures/valve.api";
import { McpHttpClient, errorOf } from "./fixtures/mcp.client";
import { fixture, valveBinding, valveSpec } from "./fixtures/valve.binding";

const petstoreSpec = fixture("petstore.yaml");

const codes = (result: ReturnType<typeof compile>): string[] => result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
const tool = (manifest: IManifest, name: string) => manifest.tools.find((t) => t.name === name)!;

describe("compiling the valve API", () => {
    const result = compile({ binding: valveBinding("http://127.0.0.1:1/api/v2"), spec: valveSpec });
    const manifest = result.manifest!;

    it("produces a manifest without errors", () => {
        expect(codes(result)).toEqual([]);
        expect(manifest.tools.map((t) => t.name)).toEqual(["lire_vanne", "lister_vannes", "ouvrir_vanne"]);
        expect(manifest.compiler).toMatch(/^@cyanmycelium\/mcp-open-api@/);
        expect(manifest.target.auth).toEqual({ kind: "bearer", secretRef: "otGateway" });
    });

    it("composes the binding's restrictions with the spec's schema, and leaves out what is fixed or hidden", () => {
        const ouvrir = tool(manifest, "ouvrir_vanne");
        // `required` is an array: its order is kept. Object keys are sorted by the canonical form.
        expect(ouvrir.inputSchema.required).toEqual(["vanne", "pourcent"]);
        expect(Object.keys(ouvrir.inputSchema.properties as object)).toEqual(["pourcent", "vanne"]);
        expect(JSON.stringify(ouvrir.inputSchema.properties)).toContain('"maximum":150');
        expect(JSON.stringify(ouvrir.inputSchema.properties)).toContain('{"maximum":100,"minimum":0}');
        expect(tool(manifest, "lire_vanne").http.query).toBeUndefined();
    });

    it("writes the HTTP plan: path template, body assignments with the fixed value", () => {
        const ouvrir = tool(manifest, "ouvrir_vanne");
        expect(ouvrir.http).toEqual({
            method: "PUT",
            path: ["/valves/", { arg: "vanne" }, "/position"],
            body: [
                { pointer: "/position", arg: "pourcent" },
                { pointer: "/mode", value: "manual" },
            ],
        });
        expect(ouvrir.authorization).toEqual({ capability: "valves.write", resourcePath: ["valves/", { arg: "vanne" }], value: "pourcent", resultRequired: true });
    });

    it("declares the limits it derives from the value's schema, as a pattern", () => {
        expect(manifest.declaration).toEqual({
            domain: "valves",
            namespace: "/site/nord",
            capabilities: ["valves.read", "valves.write"],
            resources: [{ resourcePattern: "valves/{vanne}", limits: { minValue: 0, maxValue: 100 } }],
            resultsRequired: ["valves.write"],
        });
    });

    it("projects the output schema, with references resolved", () => {
        expect(tool(manifest, "lire_vanne").outputSchema).toEqual({
            type: "object",
            properties: {
                id: { type: "string" },
                position: { type: "number", minimum: 0, maximum: 150 },
                state: { type: "string", enum: ["open", "closed", "fault"] },
                updatedAt: { type: "string" },
            },
        });
        expect(JSON.stringify(tool(manifest, "lister_vannes").outputSchema)).not.toContain("internal");
    });

    it("is deterministic, whatever the key order of the binding", () => {
        const binding = valveBinding("http://127.0.0.1:1/api/v2");
        const shuffled = JSON.parse(JSON.stringify(binding, Object.keys(binding).reverse()));
        const again = compile({ binding: JSON.stringify(binding), spec: valveSpec });
        expect(again.sha256).toBe(result.sha256);
        expect(compile({ binding: { ...shuffled, ...binding }, spec: valveSpec }).sha256).toBe(result.sha256);
    });
});

describe("the compiled manifest, served", () => {
    let api: ValveApi;
    let broker: ITestBroker;
    let served: IServedManifest;
    let operator: McpHttpClient;

    beforeAll(async () => {
        api = new ValveApi();
        await api.start();
        broker = await startTestBroker({
            callers: { operator: { groups: ["operators"] } },
            providers: { "openapi-vannes": { allowedResources: ["/site/nord/**"] } },
            policy: {
                slotResources: { vannes: "/site/nord/vannes" },
                roles: { operator: { capabilities: ["mcp.tools.call", "mcp.tools.list", "valves.read", "valves.write"] } },
                assignments: [{ id: "operators", subject: "group:operators", role: "operator", resource: "/site/**" }],
            },
        });
        const compiled = compile({ binding: valveBinding(api.baseUrl), spec: valveSpec });
        expect(codes(compiled)).toEqual([]);
        served = await serveManifest(broker.tunnel, compiled.manifest!, {
            principal: { id: "openapi-vannes", allowedResources: ["/site/nord/**"] },
            secrets: () => "compiled-secret",
        });
        operator = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("operator"));
    });

    afterAll(async () => {
        await served?.stop();
        await broker?.stop();
        await api?.stop();
    });

    it("reads and writes through the real broker, like the hand-written manifest", async () => {
        const read = await operator.callTool("lire_vanne", { vanne: "V-012" });
        expect(read.structuredContent).toEqual({ id: "V-012", position: 42, state: "open", updatedAt: "2026-10-05T10:00:00Z" });

        api.received.length = 0;
        const write = await operator.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 55 });
        expect(write.structuredContent).toEqual({ id: "V-001", position: 55 });
        expect(JSON.parse(api.received[0]!.body)).toEqual({ position: 55, mode: "manual" });
        expect(api.received[0]!.headers.authorization).toBe("Bearer compiled-secret");
    });

    it("refuses what the binding narrowed, before any HTTP call", async () => {
        api.received.length = 0;
        expect(errorOf(await operator.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 120 })).code).toBe("invalid_arguments");
        expect(errorOf(await operator.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 50, mode: "auto" })).code).toBe("invalid_arguments");
        expect(api.received).toHaveLength(0);
    });
});

describe("compiling an OpenAPI 3.0 spec (Petstore, YAML)", () => {
    const binding: IBinding = {
        binding: 1,
        slot: "petstore",
        spec: { path: "petstore.yaml", sha256: sha256(petstoreSpec) },
        target: { baseUrl: "https://petstore3.swagger.io/api/v3", auth: { secretRef: "petstoreKey" } },
        governance: { domain: "pets", namespace: "/store" },
        tools: {
            getPetById: { output: "all" },
            findPetsByStatus: { output: { pick: ["id", "name", "status"], maxItems: 10 } },
            addPet: {
                description: "Ajoute un animal au magasin.",
                output: { pick: ["id", "name"] },
                annotations: { idempotentHint: false, destructiveHint: false },
                authorization: { capability: "pets.write", resourcePath: "pets" },
            },
        },
    };
    const result = compile({ binding, spec: petstoreSpec });
    const manifest = result.manifest!;

    it("compiles, with default names and the only security scheme", () => {
        expect(codes(result)).toEqual([]);
        expect(manifest.tools.map((t) => t.name)).toEqual(["add_pet", "find_pets_by_status", "get_pet_by_id"]);
        expect(manifest.target.auth).toEqual({ kind: "apiKey", secretRef: "petstoreKey", in: "header", name: "api_key" });
    });

    it("converts 3.0 forms and drops what the engine does not read", () => {
        const add = tool(manifest, "add_pet");
        const props = add.inputSchema.properties as Record<string, any>;
        expect(Object.keys(props)).toEqual(["category", "name", "photoUrls", "status", "tags"]); // id is readOnly: out
        expect(props.status.type).toEqual(["string", "null"]);
        expect(props.status.enum).toContain(null);
        expect(props.category.properties.name).toEqual({ type: "string" });
        const text = JSON.stringify(manifest);
        for (const dropped of ['"xml"', '"format"', '"example"', '"readOnly"', '"nullable"']) expect(text).not.toContain(dropped);
    });

    it("keeps an optional query parameter with its default, and wraps a root array", () => {
        const find = tool(manifest, "find_pets_by_status");
        expect(find.http.query).toEqual([{ name: "status", arg: "status" }]);
        expect(find.inputSchema.required).toBeUndefined();
        expect((find.outputSchema as any).properties.value.type).toBe("array");
        expect(tool(manifest, "get_pet_by_id").annotations).toEqual({ readOnlyHint: true });
    });

    it("warns about descriptions taken from the spec unreviewed", () => {
        const warnings = result.diagnostics.filter((d) => d.severity === "warning").map((d) => `${d.code}${d.binding}`);
        expect(warnings).toContain("description.from-spec/tools/getPetById");
    });
});

describe("diagnostics", () => {
    const base = "http://127.0.0.1:1/api/v2";

    it("stops at once when the spec is not the one the binding was written for", () => {
        const result = compile({ binding: valveBinding(base), spec: valveSpec.replace("Read a valve", "Read one valve") });
        expect(codes(result)).toEqual(["spec.sha256-mismatch"]);
    });

    it("reports a binding that breaks its schema, with the field", () => {
        const binding = { ...valveBinding(base), extra: true };
        const result = compile({ binding, spec: valveSpec });
        expect(result.diagnostics[0]).toMatchObject({ code: "binding.schema", message: expect.stringContaining('unknown field "extra"') });
    });

    it("lists every problem of a binding, not only the first", () => {
        const binding = valveBinding(base);
        const tools = binding.tools as Record<string, any>;
        tools.getValve.args["query.nope"] = { hide: true };
        tools.getValve.output = { pick: ["id", "nope"] };
        delete tools.setValvePosition.authorization;
        tools.setValvePosition.args = { "body.mode": { hide: true }, "body.position": { minimum: 120, maximum: 100 } };
        tools.listValves.authorization = { capability: "other.read", resourcePath: "valves" };
        tools.deleteValve = { output: "all" };
        const result = compile({ binding, spec: valveSpec });
        expect(result.manifest).toBeUndefined();
        expect(new Set(codes(result))).toEqual(
            new Set([
                "args.unknown-location",
                "output.pick-unknown",
                "authorization.required",
                "args.required-hidden",
                "args.contradiction",
                "authorization.capability-domain",
                "tool.unknown-operation",
            ])
        );
        // Each one points into the binding.
        expect(result.diagnostics.find((d) => d.code === "args.required-hidden")!.binding).toBe("/tools/setValvePosition/args/body.mode");
    });

    it("refuses an enum value or a fixed value the spec does not allow", () => {
        const binding = valveBinding(base);
        (binding.tools as Record<string, any>).setValvePosition.args["body.mode"] = { fixed: "remote" };
        expect(codes(compile({ binding, spec: valveSpec }))).toContain("args.fixed-invalid");
        (binding.tools as Record<string, any>).setValvePosition.args["body.mode"] = { enum: ["manual", "remote"] };
        expect(codes(compile({ binding, spec: valveSpec }))).toContain("args.enum-invalid");
    });

    it("refuses limits on a value that is neither a number nor an enum", () => {
        const binding = valveBinding(base);
        (binding.tools as Record<string, any>).setValvePosition.authorization.value = "path.id";
        expect(codes(compile({ binding, spec: valveSpec }))).toContain("authorization.value-type");
    });

    it("refuses a validation keyword the engine does not check, rather than dropping it", () => {
        const spec = JSON.parse(valveSpec);
        spec.components.schemas.PositionCommand.properties.position.multipleOf = 5;
        const text = JSON.stringify(spec);
        const result = compile({ binding: valveBinding(base, text), spec: text });
        expect(result.diagnostics.find((d) => d.code === "schema.unsupported-keyword")).toMatchObject({
            spec: "/components/schemas/PositionCommand/properties/position/multipleOf",
        });
    });
});
