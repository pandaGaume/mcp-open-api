import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import type { IBinding } from "@cyanmycelium/mcp-open-api";
import { compile } from "@cyanmycelium/mcp-open-api/compiler";
import { DESIGNER_UI_DIR, DesignerError, Workbench, startDesigner, type IDesignHost, type IPublishEvent, type IRunningDesigner } from "@cyanmycelium/mcp-open-api/designer";
import { OpenApiHost, generateSigningKeys, signManifest } from "@cyanmycelium/mcp-open-api/host";
import { ValveApi } from "./fixtures/valve.api";
import { McpHttpClient } from "./fixtures/mcp.client";
import { valveBinding, valveSpec } from "./fixtures/valve.binding";

const operatorKeys = generateSigningKeys();

/** A host folder and its config, as `mcp-open-api serve` would read them. */
function hostFolder(api: ValveApi, name = "vannes"): IDesignHost {
    const baseDir = mkdtempSync(join(tmpdir(), "mcp-open-api-designer-"));
    mkdirSync(join(baseDir, "manifests"));
    writeFileSync(join(baseDir, "operator.pub.pem"), operatorKeys.publicKeyPem);
    return {
        name,
        baseDir,
        config: {
            broker: { url: "ws://unused/providers", secretEnv: "VANNES_PROVIDER_SECRET" },
            manifests: "manifests",
            trustedKeys: ["operator.pub.pem"],
            allowedTargets: [new URL(api.baseUrl).origin],
            secrets: { otGateway: { env: "VANNES_API_TOKEN" } },
        },
    };
}

/** The binding a person would reach in the Tuning step, with the draft's own spec reference. */
function tuned(api: ValveApi, draftBinding: IBinding): IBinding {
    return { ...valveBinding(api.baseUrl), spec: draftBinding.spec };
}

let api: ValveApi;

beforeAll(async () => {
    api = new ValveApi();
    await api.start();
});

afterAll(async () => {
    await api?.stop();
});

describe("the workbench", () => {
    it("imports a spec as candidates: nothing exposed, write operations flagged, locations listed", () => {
        const host = hostFolder(api);
        const draft = new Workbench([host]).importSpec({ host: "vannes", slot: "vannes", spec: valveSpec });
        expect(draft.binding.tools).toEqual({});
        expect(draft.binding.target.auth).toEqual({ secretRef: "otGateway" });
        const ops = Object.fromEntries(draft.operations.map((o) => [o.key, o]));
        expect(ops.setValvePosition).toMatchObject({ method: "PUT", write: true, locations: ["path.id", "body.position", "body.mode"] });
        expect(ops.getValve).toMatchObject({ write: false, locations: ["path.id", "query.debug"] });
    });

    it("suggests the spec's server only when the host allows its origin", () => {
        const draft = new Workbench([hostFolder(api)]).importSpec({ host: "vannes", slot: "vannes", spec: valveSpec });
        // The spec names https://ot-gw.local, which this host does not allow.
        expect(draft.binding.target.baseUrl).toBe(new URL(api.baseUrl).origin);
    });

    it("refuses a spec that is not OpenAPI, and an unknown host", () => {
        const bench = new Workbench([hostFolder(api)]);
        expect(() => bench.importSpec({ host: "vannes", slot: "vannes", spec: '{"swagger":"2.0"}' })).toThrow(DesignerError);
        expect(() => bench.importSpec({ host: "nope", slot: "vannes", spec: valveSpec })).toThrow(/no host "nope"/);
    });

    it("reviews a draft: compiler diagnostics, write tools, and the host's own refusals", () => {
        const bench = new Workbench([hostFolder(api)]);
        const draft = bench.importSpec({ host: "vannes", slot: "vannes", spec: valveSpec });

        const good = bench.update(draft.draftId, tuned(api, draft.binding));
        expect(good.ok).toBe(true);
        expect(good.writeTools).toEqual(["ouvrir_vanne"]);
        expect(good.diff).toEqual({ added: ["lire_vanne", "lister_vannes", "ouvrir_vanne"], removed: [], changed: [], slot: [] });

        const elsewhere = bench.update(draft.draftId, { ...tuned(api, draft.binding), target: { baseUrl: "https://ot-gw.local/api/v2", auth: { secretRef: "otGateway" } } });
        expect(elsewhere.ok).toBe(false);
        expect(elsewhere.diagnostics.map((d) => d.code)).toContain("host.refused");

        const noSecret = bench.update(draft.draftId, { ...tuned(api, draft.binding), target: { baseUrl: api.baseUrl, auth: { secretRef: "other" } } });
        expect(noSecret.diagnostics.find((d) => d.code === "host.refused")?.message).toContain('no secret "other"');
    });

    it("dry-runs a call: the request as the engine builds it, with a placeholder for the credential", () => {
        const bench = new Workbench([hostFolder(api)]);
        const draft = bench.importSpec({ host: "vannes", slot: "vannes", spec: valveSpec });
        bench.update(draft.draftId, tuned(api, draft.binding));
        const plan = bench.dryRun(draft.draftId, "ouvrir_vanne", { vanne: "V-012", pourcent: 40 });
        expect(plan).toMatchObject({
            method: "PUT",
            url: `${api.baseUrl}/valves/V-012/position`,
            body: { position: 40, mode: "manual" },
            resourcePath: "/site/nord/valves/V-012",
        });
        expect(plan.headers.authorization).toBe("Bearer <secret:otGateway>");
        expect(api.received).toEqual([]);
        expect(() => bench.dryRun(draft.draftId, "ouvrir_vanne", { vanne: "V-012", pourcent: 140 })).toThrow(/fails "maximum"/);
    });

    it("publishes only a reviewed, approved manifest signed by a key the host trusts", () => {
        const host = hostFolder(api);
        const events: IPublishEvent[] = [];
        const bench = new Workbench([host], { onPublish: (e) => events.push(e) });
        const draft = bench.importSpec({ host: "vannes", slot: "vannes", spec: valveSpec });
        const review = bench.update(draft.draftId, tuned(api, draft.binding));
        const manifest = JSON.parse(review.canonical!);
        const signature = signManifest(manifest, operatorKeys.privateKeyPem);
        const request = { sha256: review.sha256!, signature, approvedWriteTools: ["ouvrir_vanne"] };

        const refusal = (fn: () => unknown): string => {
            try {
                fn();
            } catch (error) {
                return (error as DesignerError).code;
            }
            return "accepted";
        };
        expect(refusal(() => bench.publish(draft.draftId, { ...request, approvedWriteTools: [] }))).toBe("not_approved");
        expect(refusal(() => bench.publish(draft.draftId, { ...request, signature: signManifest(manifest, generateSigningKeys().privateKeyPem) }))).toBe("bad_signature");
        expect(refusal(() => bench.publish(draft.draftId, { ...request, sha256: "0".repeat(64) }))).toBe("stale_review");
        expect(existsSync(join(host.baseDir, "manifests", "vannes.json"))).toBe(false);

        const result = bench.publish(draft.draftId, request);
        expect(result.files.map((f) => f.slice(host.baseDir.length).replace(/\\/g, "/"))).toEqual([
            "/manifests/sources/vannes.openapi.json",
            "/manifests/sources/vannes.binding.json",
            "/manifests/vannes.json",
            "/manifests/vannes.json.sig",
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ host: "vannes", slot: "vannes", sha256: review.sha256, approvedWriteTools: ["ouvrir_vanne"] });

        // The sources recompile into the very manifest that was signed.
        const binding = readFileSync(join(host.baseDir, "manifests", "sources", "vannes.binding.json"), "utf8");
        const spec = readFileSync(join(host.baseDir, "manifests", "sources", "vannes.openapi.json"));
        expect(compile({ binding, spec }).sha256).toBe(review.sha256);

        // A new review sees it as published, and diffs against it.
        const edited = bench.update(draft.draftId, {
            ...tuned(api, draft.binding),
            tools: { ...tuned(api, draft.binding).tools, getValve: { ...tuned(api, draft.binding).tools!.getValve!, description: "Reads one valve." } },
        });
        expect(edited.published?.sha256).toBe(review.sha256);
        expect(edited.diff).toEqual({ added: [], removed: [], changed: [{ tool: "lire_vanne", fields: ["description"] }], slot: [] });
    });

    it("ships the Tier 4 page", () => {
        for (const file of ["index.html", "designer.js", "designer.css"]) expect(existsSync(join(DESIGNER_UI_DIR, file))).toBe(true);
        expect(readFileSync(join(DESIGNER_UI_DIR, "index.html"), "utf8")).not.toMatch(/<script>|style="/);
    });
});

describe("the designer, behind a broker", () => {
    let broker: ITestBroker;
    let designer: IRunningDesigner;
    let host: IDesignHost;
    let served: OpenApiHost | undefined;

    beforeAll(async () => {
        broker = await startTestBroker({
            callers: { operator: { groups: ["operators"] } },
            providers: { "openapi-designer": {}, "openapi-vannes": { allowedResources: ["/site/nord/**"] } },
            policy: {
                slotResources: { designer: "/designer", vannes: "/site/nord/vannes" },
                roles: { operator: { capabilities: ["mcp.tools.call", "mcp.tools.list", "valves.read", "valves.write"] } },
                assignments: [
                    { id: "operators", subject: "group:operators", role: "operator", resource: "/site/**" },
                    { id: "designers", subject: "group:operators", role: "operator", resource: "/designer" },
                ],
            },
        });
        host = hostFolder(api);
        designer = await startDesigner({ broker: { url: broker.providersUrl, secretEnv: "DESIGNER_SECRET" }, hosts: { vannes: "unused" } }, [host], {
            env: { DESIGNER_SECRET: broker.providerSecret("openapi-designer") },
        });
    });

    afterAll(async () => {
        await served?.stop();
        await designer?.stop();
        await broker?.stop();
    });

    it("takes an OpenAPI spec to a governed slot: import, tune, dry run, sign, publish, serve", async () => {
        const client = new McpHttpClient(broker.mcpUrl("designer"), broker.bearer("operator"));
        const tools = (await client.request("tools/list")).result.tools.map((t: { name: string }) => t.name);
        expect(tools).toContain("designer_publish");

        const draft = (await client.callTool("designer_import", { host: "vannes", slot: "vannes", spec: valveSpec })).structuredContent;
        const review = (await client.callTool("designer_update", { draftId: draft.draftId, binding: tuned(api, draft.binding) })).structuredContent;
        expect(review.ok).toBe(true);
        const plan = (await client.callTool("designer_dry_run", { draftId: draft.draftId, tool: "lire_vanne", arguments: { vanne: "V-012" } })).structuredContent;
        expect(plan.url).toBe(`${api.baseUrl}/valves/V-012`);

        // What the page does in the browser: sign the canonical text with the operator's key.
        const signature = signManifest(JSON.parse(review.canonical), operatorKeys.privateKeyPem);
        const unapproved = await client.callTool("designer_publish", { draftId: draft.draftId, sha256: review.sha256, signature, approvedWriteTools: [] });
        expect(unapproved.isError).toBe(true);
        expect(JSON.parse(unapproved.content[0]!.text).error.code).toBe("not_approved");
        const published = await client.callTool("designer_publish", { draftId: draft.draftId, sha256: review.sha256, signature, approvedWriteTools: ["ouvrir_vanne"] });
        expect(published.structuredContent).toMatchObject({ slot: "vannes", sha256: review.sha256 });

        // The host, restarted, serves what was signed, under the broker's governance.
        served = await new OpenApiHost({ ...host.config, broker: { url: broker.providersUrl, secretEnv: "VANNES_PROVIDER_SECRET" } }, host.baseDir, {
            VANNES_PROVIDER_SECRET: broker.providerSecret("openapi-vannes"),
            VANNES_API_TOKEN: "token",
        }).start();
        expect(served.refused).toEqual([]);
        const vannes = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("operator"));
        expect((await vannes.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 30 })).structuredContent).toEqual({ id: "V-001", position: 30 });
    });
});
