import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import plugin, { type IOpenApiPluginConfig, type IOpenApiPluginContext } from "../src/plugin/index";
import { compile } from "../src/compiler/index";
import { generateSigningKeys, signManifest } from "../src/host/signature";
import { ValveApi } from "./fixtures/valve.api";
import { valveBinding, valveSpec } from "./fixtures/valve.binding";
import { McpHttpClient, errorOf } from "./fixtures/mcp.client";

describe("the open-api broker plugin", () => {
    let api: ValveApi;
    let broker: ITestBroker;
    let work: string;
    let context: IOpenApiPluginContext;
    let config: IOpenApiPluginConfig;
    let client: McpHttpClient;
    const keys = generateSigningKeys();
    const cleanups: Array<() => void | Promise<void>> = [];

    beforeAll(async () => {
        api = new ValveApi();
        await api.start();
        broker = await startTestBroker({
            callers: { operator: {}, reader: {} },
            policy: {
                slotResources: { vannes: "/site/nord/vannes" },
                roles: {
                    operator: { capabilities: ["mcp.tools.call", "mcp.tools.list", "valves.read", "valves.write"] },
                    reader: { capabilities: ["mcp.tools.call", "mcp.tools.list", "valves.read"] },
                },
                assignments: [
                    { id: "operator", subject: "user:operator", role: "operator", resource: "/site/**" },
                    { id: "reader", subject: "user:reader", role: "reader", resource: "/site/**" },
                ],
            },
        });
    });

    beforeEach(() => {
        work = mkdtempSync(join(tmpdir(), "open-api-plugin-"));
        const result = compile({ binding: valveBinding(api.baseUrl), spec: valveSpec });
        writeFileSync(join(work, "vannes.json"), result.canonical!);
        writeFileSync(join(work, "vannes.json.sig"), JSON.stringify(signManifest(result.manifest, keys.privateKeyPem)));
        writeFileSync(join(work, "operator.pub.pem"), keys.publicKeyPem);
        process.env.PLUGIN_VALVE_TOKEN = "plugin-valve-token";
        config = {
            manifests: ["vannes.json"],
            trustedKeys: ["operator.pub.pem"],
            allowedTargets: [new URL(api.baseUrl).origin],
            secrets: { otGateway: { env: "PLUGIN_VALVE_TOKEN" } },
        };
        context = {
            baseDir: work,
            registerSlot: (name, transport) => broker.tunnel.registerLoopbackProvider(name, transport, { principal: { id: "plugin-api", allowedResources: ["/site/nord/**"] } }),
            onCleanup: (dispose) => cleanups.push(dispose),
            log: () => {},
        };
        client = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("operator"));
        api.received.length = 0;
    });

    afterEach(async () => {
        await client.close();
        for (const dispose of cleanups.splice(0).reverse()) await dispose();
        delete process.env.PLUGIN_VALVE_TOKEN;
        rmSync(work, { recursive: true, force: true });
    });

    afterAll(async () => {
        await broker.stop();
        await api.stop();
    });

    it("verifies, publishes and executes a signed manifest with broker authorization", async () => {
        const handle = await plugin.start(context, config);
        expect((await client.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toContain("lire_vanne");
        expect((await client.callTool("lire_vanne", { vanne: "V-001" })).structuredContent).toMatchObject({ id: "V-001" });
        expect(api.received.at(-1)?.headers.authorization).toBe("Bearer plugin-valve-token");
        const reader = new McpHttpClient(broker.mcpUrl("vannes"), broker.bearer("reader"));
        try {
            expect(errorOf(await reader.callTool("ouvrir_vanne", { vanne: "V-001", pourcent: 20 })).code).toBe("denied");
        } finally {
            await reader.close();
        }
        await Promise.all([handle.stop(), handle.stop()]);
        expect(broker.tunnel.getProviderInfo("vannes")?.connected).toBe(false);
    });

    it("refuses a modified signed manifest before registering any slot", async () => {
        const manifest = JSON.parse(readFileSync(join(work, "vannes.json"), "utf8"));
        manifest.tools[0].description = "changed";
        writeFileSync(join(work, "vannes.json"), JSON.stringify(manifest));
        let registrations = 0;
        await expect(
            plugin.start(
                {
                    ...context,
                    registerSlot: () => {
                        registrations++;
                        throw new Error("unexpected registration");
                    },
                },
                config
            )
        ).rejects.toThrow("changed after signing");
        expect(registrations).toBe(0);
    });

    it("refuses missing secrets and targets outside the allowlist", async () => {
        await expect(plugin.start(context, { ...config, allowedTargets: ["https://other.example"] })).rejects.toThrow("allowed");
        delete process.env.PLUGIN_VALVE_TOKEN;
        await expect(plugin.start(context, config)).rejects.toThrow('no secret "otGateway"');
    });

    it("requires signatures and explicit trusted keys", async () => {
        await expect(plugin.start(context, { ...config, trustedKeys: [] })).rejects.toThrow("trustedKeys");
        await expect(plugin.start(context, { ...config, allowUnsigned: true })).rejects.toThrow("signed manifests");
        rmSync(join(work, "vannes.json.sig"));
        await expect(plugin.start(context, config)).rejects.toThrow();
    });

    it("refuses duplicate slots before publishing", async () => {
        await expect(plugin.start(context, { ...config, manifests: ["vannes.json", "vannes.json"] })).rejects.toThrow('duplicate manifest slot "vannes"');
    });

    it("cleans up a started slot when a later slot cannot be registered", async () => {
        const result = compile({ binding: { ...valveBinding(api.baseUrl), slot: "second" }, spec: valveSpec });
        writeFileSync(join(work, "second.json"), result.canonical!);
        writeFileSync(join(work, "second.json.sig"), JSON.stringify(signManifest(result.manifest, keys.privateKeyPem)));
        await expect(
            plugin.start(
                {
                    ...context,
                    registerSlot(name, transport) {
                        if (name === "second") throw new Error("registration refused");
                        return context.registerSlot(name, transport);
                    },
                },
                { ...config, manifests: ["vannes.json", "second.json"] }
            )
        ).rejects.toThrow("registration refused");
        expect(broker.tunnel.getProviderInfo("vannes")?.connected).toBe(false);
    });
});
