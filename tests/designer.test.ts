import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker } from "@cyanmycelium/mcp-broker/testing";
import type { IBinding } from "@cyanmycelium/mcp-open-api";
import { compile } from "@cyanmycelium/mcp-open-api/compiler";
import { DesignSession, DesignerError, fetchSpec, hostProfileOf, type IHostProfile } from "@cyanmycelium/mcp-open-api/designer";
import { OpenApiHost, generateSigningKeys, signManifest } from "@cyanmycelium/mcp-open-api/host";
import { ValveApi } from "./fixtures/valve.api";
import { McpHttpClient } from "./fixtures/mcp.client";
import { pumpBinding, valveBinding, valveSpec } from "./fixtures/valve.binding";

let api: ValveApi;
let profile: IHostProfile;

beforeAll(async () => {
    api = new ValveApi();
    await api.start();
    profile = hostProfileOf({ allowedTargets: [new URL(api.baseUrl).origin], secrets: { otGateway: { env: "VANNES_API_TOKEN" } } }, "vannes");
});

afterAll(async () => {
    await api?.stop();
});

/** The binding a person would reach in the Tuning step, with the draft's own spec reference. */
const tuned = (session: DesignSession, binding: IBinding = valveBinding(api.baseUrl)): IBinding => ({ ...binding, spec: session.binding.spec });

const codeOf = (fn: () => unknown): string => {
    try {
        fn();
    } catch (error) {
        return (error as DesignerError).code;
    }
    return "accepted";
};

describe("a design session", () => {
    it("imports a spec as candidates: nothing exposed, write operations flagged, locations listed", () => {
        const session = DesignSession.import({ slot: "vannes", spec: valveSpec, host: profile });
        const view = session.view();
        expect(view.binding.tools).toEqual({});
        expect(view.binding.target.auth).toEqual({ secretRef: "otGateway" });
        const ops = Object.fromEntries(view.operations.map((o) => [o.key, o]));
        expect(ops.setValvePosition).toMatchObject({ method: "PUT", write: true, locations: ["path.id", "body.position", "body.mode"] });
        expect(ops.getValve).toMatchObject({ write: false, locations: ["path.id", "query.debug"] });
    });

    it("suggests the spec's server, unless the host does not allow its origin", () => {
        expect(DesignSession.import({ slot: "vannes", spec: valveSpec }).binding.target.baseUrl).toBe("https://ot-gw.local/api/v2");
        expect(DesignSession.import({ slot: "vannes", spec: valveSpec, host: profile }).binding.target.baseUrl).toBe(new URL(api.baseUrl).origin);
    });

    it("refuses what is not OpenAPI 3, and says so for Swagger 2.0", () => {
        expect(codeOf(() => DesignSession.import({ slot: "vannes", spec: '{"swagger":"2.0","info":{},"paths":{}}' }))).toBe("swagger_2");
        expect(codeOf(() => DesignSession.import({ slot: "vannes", spec: "{}" }))).toBe("spec_invalid");
        expect(codeOf(() => DesignSession.import({ slot: "Vannes", spec: valveSpec }))).toBe("invalid_slot");
    });

    it("reviews a draft: compiler diagnostics, write tools, and what the host would refuse", () => {
        const session = DesignSession.import({ slot: "vannes", spec: valveSpec, host: profile });
        const good = session.update(tuned(session));
        expect(good.ok).toBe(true);
        expect(good.writeTools).toEqual(["ouvrir_vanne"]);
        expect(good.diff).toEqual({ added: ["lire_vanne", "lister_vannes", "ouvrir_vanne"], removed: [], changed: [], slot: [] });

        const elsewhere = session.update({ ...tuned(session), target: { baseUrl: "https://ot-gw.local/api/v2", auth: { secretRef: "otGateway" } } });
        expect(elsewhere.diagnostics.map((d) => d.code)).toContain("host.refused");
        const noSecret = session.update({ ...tuned(session), target: { baseUrl: api.baseUrl, auth: { secretRef: "other" } } });
        expect(noSecret.diagnostics.find((d) => d.code === "host.refused")?.message).toContain('no secret "other"');

        session.setHost(undefined);
        const unchecked = session.update({ ...tuned(session), target: { baseUrl: "https://ot-gw.local/api/v2", auth: { secretRef: "other" } } });
        expect(unchecked.ok).toBe(true);
        expect(unchecked.diagnostics.map((d) => d.code)).toContain("host.unchecked");
    });

    it("diffs against the version a host serves today", () => {
        const session = DesignSession.import({ slot: "vannes", spec: valveSpec, host: profile });
        const first = session.update(tuned(session));
        session.compareWith(JSON.parse(first.canonical!));
        const binding = tuned(session);
        const edited = session.update({ ...binding, tools: { ...binding.tools, getValve: { ...binding.tools!.getValve!, description: "Reads one valve." } } });
        expect(edited.previous?.sha256).toBe(first.sha256);
        expect(edited.diff).toEqual({ added: [], removed: [], changed: [{ tool: "lire_vanne", fields: ["description"] }], slot: [] });
    });

    it("dry-runs a call: the request as the engine builds it, credentials as placeholders, nothing sent", () => {
        const session = DesignSession.import({ slot: "vannes", spec: valveSpec, host: profile });
        session.update(tuned(session));
        const plan = session.dryRun("ouvrir_vanne", { vanne: "V-012", pourcent: 40 });
        expect(plan).toMatchObject({ method: "PUT", url: `${api.baseUrl}/valves/V-012/position`, body: { position: 40, mode: "manual" }, resourcePath: "/site/nord/valves/V-012" });
        expect(plan.headers.authorization).toBe("Bearer <secret:otGateway>");
        expect(api.received).toEqual([]);
        expect(codeOf(() => session.dryRun("ouvrir_vanne", { vanne: "V-012", pourcent: 140 }))).toBe("invalid_arguments");
    });

    it("produces the manifest and sources that recompile into it, and nothing while it has errors", () => {
        const session = DesignSession.import({ slot: "vannes", spec: valveSpec, host: profile });
        session.update({ ...tuned(session), target: { baseUrl: "https://ot-gw.local/api/v2", auth: { secretRef: "otGateway" } } });
        expect(codeOf(() => session.files())).toBe("not_ready");
        const review = session.update(tuned(session));
        const files = session.files();
        expect(files.manifest.name).toBe("vannes.json");
        expect(compile({ binding: files.binding.text, spec: files.spec.text }).sha256).toBe(review.sha256);
    });
});

describe("fetching a spec by URL", () => {
    type Route = (res: ServerResponse) => void;
    const json =
        (body: unknown): Route =>
        (res) => (res.writeHead(200, { "content-type": "application/json" }), res.end(typeof body === "string" ? body : JSON.stringify(body)));
    const html =
        (body: string): Route =>
        (res) => (res.writeHead(200, { "content-type": "text/html" }), res.end(body));
    const redirect =
        (to: string): Route =>
        (res) => (res.writeHead(302, { location: to }), res.end());
    const servers: Server[] = [];
    const serve = async (routes: Record<string, Route>): Promise<{ origin: string; hits: string[] }> => {
        const hits: string[] = [];
        const server = createServer((req, res) => {
            hits.push(req.url!);
            const route = routes[req.url!];
            if (route) route(res);
            else (res.writeHead(404), res.end());
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        servers.push(server);
        return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
    };

    let docs: { origin: string; hits: string[] };
    let elsewhere: { origin: string; hits: string[] };
    beforeAll(async () => {
        elsewhere = await serve({ "/openapi.json": json(valveSpec) });
        docs = await serve({
            "/spec.json": json(valveSpec),
            "/ui/": html('<html><script src="./swagger-ui-bundle.js"></script><script src="./swagger-initializer.js"></script></html>'),
            "/ui/swagger-initializer.js": json('window.ui = SwaggerUIBundle({ url: "/spec.json", dom_id: "#swagger-ui" });'),
            "/redoc/": html('<html><redoc spec-url="../spec.json"></redoc></html>'),
            "/portal/": html("<html><body>API reference</body></html>"),
            "/openapi.json": json(valveSpec),
            "/legacy/swagger.json": json({ swagger: "2.0", info: { title: "old", version: "1" }, paths: {} }),
            "/away": redirect(`${elsewhere.origin}/openapi.json`),
            "/big.json": json(`{"openapi":"3.1.0","x":"${"a".repeat(2048)}"}`),
        });
    });
    afterAll(() => {
        for (const s of servers) s.close();
    });
    const code = (p: Promise<unknown>): Promise<string> =>
        p.then(
            () => "accepted",
            (e: DesignerError) => e.code
        );

    it("fetches a spec, or finds it behind a Swagger UI page, a ReDoc page, or at a well-known path", async () => {
        expect((await fetchSpec(`${docs.origin}/spec.json`)).url).toBe(`${docs.origin}/spec.json`);
        expect((await fetchSpec(`${docs.origin}/ui/`)).url).toBe(`${docs.origin}/spec.json`);
        expect((await fetchSpec(`${docs.origin}/redoc/`)).url).toBe(`${docs.origin}/spec.json`);
        expect((await fetchSpec(`${docs.origin}/portal/`)).url).toBe(`${docs.origin}/openapi.json`);
    });

    it("resolves the spec's relative servers against where it came from", async () => {
        const relative = JSON.parse(valveSpec);
        relative.servers = [{ url: "/api/v2" }];
        const session = DesignSession.import({ slot: "vannes", spec: JSON.stringify(relative), source: `${docs.origin}/spec.json` });
        expect(session.binding.target.baseUrl).toBe(`${docs.origin}/api/v2`);
    });

    it("says so when the URL is a Swagger 2.0 description", async () => {
        await expect(fetchSpec(`${docs.origin}/legacy/swagger.json`)).rejects.toThrow(/Swagger 2\.0/);
    });

    it("with an allow-list, contacts no other origin, redirects included", async () => {
        const before = elsewhere.hits.length;
        expect(await code(fetchSpec(`${docs.origin}/spec.json`, { allowedOrigins: [] }))).toBe("origin_not_allowed");
        expect(await code(fetchSpec(`${docs.origin}/away`, { allowedOrigins: [docs.origin] }))).toBe("origin_not_allowed");
        expect(await code(fetchSpec("file:///etc/passwd"))).toBe("invalid_url");
        expect(elsewhere.hits.length).toBe(before);
    });

    it("caps the size of what it reads", async () => {
        expect(await code(fetchSpec(`${docs.origin}/big.json`, { maxBytes: 1024 }))).toBe("spec_too_large");
    });
});

describe("from the page to the broker", () => {
    it("designs, signs, and a host opens one slot per manifest it is given", async () => {
        const keys = generateSigningKeys();
        const work = mkdtempSync(join(tmpdir(), "mcp-open-api-design-"));
        writeFileSync(join(work, "operator.pub.pem"), keys.publicKeyPem);

        // What the page does: design, then sign the canonical text and save the files.
        for (const binding of [valveBinding(api.baseUrl), pumpBinding(api.baseUrl)]) {
            const session = DesignSession.import({
                slot: binding.slot,
                spec: valveSpec,
                host: { allowedTargets: [new URL(api.baseUrl).origin], secrets: ["otGateway", "pumpGateway"] },
            });
            expect(session.update({ ...binding, spec: session.binding.spec }).ok).toBe(true);
            const files = session.files();
            writeFileSync(join(work, files.manifest.name), files.manifest.text);
            writeFileSync(join(work, `${files.manifest.name}.sig`), JSON.stringify(signManifest(JSON.parse(files.manifest.text), keys.privateKeyPem)));
        }

        const broker = await startTestBroker({
            callers: { operator: { groups: ["operators"] } },
            providers: { "openapi-host": { allowedResources: ["/site/nord/**"] } },
            policy: {
                slotResources: { vannes: "/site/nord/vannes", pompes: "/site/nord/pompes" },
                roles: { operator: { capabilities: ["mcp.tools.call", "mcp.tools.list", "valves.read", "valves.write", "pumps.read"] } },
                assignments: [{ id: "operators", subject: "group:operators", role: "operator", resource: "/site/**" }],
            },
        });
        const host = await new OpenApiHost(
            {
                broker: { url: broker.providersUrl, secretEnv: "HOST_SECRET" },
                manifests: ["vannes.json", "pompes.json", "missing.json"],
                trustedKeys: ["operator.pub.pem"],
                allowedTargets: [new URL(api.baseUrl).origin],
                secrets: { otGateway: { env: "OT" }, pumpGateway: { env: "PUMPS" } },
            },
            work,
            { HOST_SECRET: broker.providerSecret("openapi-host"), OT: "ot-token", PUMPS: "pump-token" }
        ).start();
        try {
            expect(host.slots.map((s) => s.slot)).toEqual(["vannes", "pompes"]);
            expect(host.refused).toEqual([{ file: "missing.json", reasons: ["not found"] }]);
            const vannes = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("operator"));
            expect((await vannes.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 30 })).structuredContent).toEqual({ id: "V-001", position: 30 });
            const pompes = new McpHttpClient(broker.mcpUrl("pompes"), broker.bearer("operator"));
            expect((await pompes.callTool("lire_pompe", { pompe: "V-001" })).isError).toBeFalsy();
        } finally {
            await host.stop();
            await broker.stop();
        }
    });
});
