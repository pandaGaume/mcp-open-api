import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpAdapterBase, McpBehavior, McpServerBuilder, type IMcpServer, type McpTool, type McpToolResult } from "@cyanmycelium/mcp-core";
import { MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";
import { loadHostConfig } from "../host/host";
import { opened } from "../runtime/open";
import { DesignerError, Workbench, type IDesignHost, type IPublishEvent } from "./workbench";

/** The configuration of a designer: the broker it publishes its slot on, and the hosts it publishes manifests into. */
export interface IDesignerConfig {
    readonly broker: {
        /** The broker's shared provider socket: `ws://<host>:<port>/providers`. */
        readonly url: string;
        /** Environment variable holding the designer's provider secret. */
        readonly secretEnv?: string;
    };
    /** The designer's slot. Default `designer`. Never in `_all`: design is not a tool for every agent. */
    readonly slot?: string;
    /** Host name to the path of that host's `mcp-open-api.json`, relative to this file. */
    readonly hosts: Readonly<Record<string, string>>;
    readonly maxDrafts?: number;
    readonly maxSpecBytes?: number;
    /**
     * Origins a spec may be fetched from by URL, besides each host's
     * `allowedTargets`: a documentation portal on another origin than the API.
     * No other origin is ever contacted.
     */
    readonly specOrigins?: readonly string[];
}

/** Reads a designer config and the host configs it names. */
export function loadDesignerConfig(path: string): { config: IDesignerConfig; hosts: IDesignHost[] } {
    const config = JSON.parse(readFileSync(path, "utf8")) as IDesignerConfig;
    if (!config.broker?.url || typeof config.hosts !== "object" || config.hosts === null || Object.keys(config.hosts).length === 0) {
        throw new Error(`${path}: broker.url and at least one entry in hosts are required`);
    }
    const baseDir = dirname(resolve(path));
    const hosts = Object.entries(config.hosts).map(([name, hostPath]) => {
        const loaded = loadHostConfig(resolve(baseDir, hostPath));
        return { name, config: loaded.config, baseDir: loaded.baseDir };
    });
    return { config, hosts };
}

/**
 * The Tier 4 page: static files at the package root, served by the broker
 * under `/ui/<slot>/`. Found from this module, wherever the bundler put it.
 */
export const DESIGNER_UI_DIR = ["../ui/", "../../ui/", "../../../ui/"]
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((dir) => existsSync(join(dir, "designer.js")))!;

const object = (properties: Record<string, unknown>, required: string[] = []): McpTool["inputSchema"] =>
    ({ type: "object", additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) }) as McpTool["inputSchema"];

const DRAFT_ID = { type: "string", description: "The draft, as designer_import returned it." };

/** The design tools. Every one of them is reachable by an agent; none of them publishes without a person's signature. */
export const DESIGNER_TOOLS: readonly McpTool[] = [
    {
        name: "designer_hosts",
        description: "Lists the mcp-open-api hosts this designer publishes into: their allowed targets, secret names and published slots.",
        inputSchema: object({}),
        annotations: { readOnlyHint: true },
    },
    {
        name: "designer_import",
        description:
            "Imports an OpenAPI 3.0 or 3.1 spec into a new draft for a slot of a host, from its text or from a URL. A URL may be the spec itself or a documentation page (Swagger UI, ReDoc) that loads it. Every operation becomes a candidate; none is exposed yet.",
        inputSchema: object(
            {
                host: { type: "string", description: "A host from designer_hosts." },
                slot: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "The slot the API will be published on." },
                spec: { type: "string", description: "The spec's text (JSON or YAML). Give this or url." },
                url: {
                    type: "string",
                    description: "Where to fetch the spec. Only the host's allowedTargets and the designer's specOrigins (designer_hosts lists them) are contacted.",
                },
            },
            ["host", "slot"]
        ),
    },
    {
        name: "designer_get",
        description: "Returns a draft: the spec's operations with their argument locations, and the current binding (binding-1).",
        inputSchema: object({ draftId: DRAFT_ID }, ["draftId"]),
        annotations: { readOnlyHint: true },
    },
    {
        name: "designer_update",
        description: "Replaces the draft's binding (binding-1, see docs/binding.md), then compiles and checks it. Returns the review.",
        inputSchema: object({ draftId: DRAFT_ID, binding: { type: "object", description: "The whole binding." } }, ["draftId", "binding"]),
        annotations: { idempotentHint: true },
    },
    {
        name: "designer_review",
        description:
            "Compiles the draft and checks it against its host: every diagnostic, the canonical manifest and its SHA-256, the write tools to approve, the diff with the published version.",
        inputSchema: object({ draftId: DRAFT_ID }, ["draftId"]),
        annotations: { readOnlyHint: true },
    },
    {
        name: "designer_dry_run",
        description: "Shows the HTTP request a tool would send for these arguments, credentials replaced by placeholders. Nothing is sent and the broker is not asked.",
        inputSchema: object({ draftId: DRAFT_ID, tool: { type: "string" }, arguments: { type: "object" } }, ["draftId", "tool"]),
        annotations: { readOnlyHint: true },
    },
    {
        name: "designer_publish",
        description:
            "Writes the reviewed manifest and its signature into the host's folder. Refused unless the draft is error-free, unchanged since the review, every write tool is approved, and a key the host trusts signed it. The designer holds no such key.",
        inputSchema: object(
            {
                draftId: DRAFT_ID,
                sha256: { type: "string", pattern: "^[0-9a-f]{64}$", description: "The reviewed manifest's SHA-256." },
                signature: {
                    type: "object",
                    description: "{ alg: 'Ed25519', manifest: <sha256>, signature: <base64> } over the canonical manifest.",
                },
                approvedWriteTools: { type: "array", items: { type: "string" } },
            },
            ["draftId", "sha256", "signature", "approvedWriteTools"]
        ),
    },
];

const ok = (value: unknown): McpToolResult => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
});

const refused = (error: DesignerError): McpToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.problems.length > 0 ? { problems: error.problems } : {}) } }) }],
});

class DesignerAdapter extends McpAdapterBase {
    constructor(
        slot: string,
        private readonly _workbench: Workbench
    ) {
        super(slot);
    }

    async readResourceAsync(): Promise<undefined> {
        return undefined;
    }

    async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const w = this._workbench;
        const s = (key: string): string => String(args[key] ?? "");
        try {
            switch (toolName) {
                case "designer_hosts":
                    return ok({ hosts: w.hosts() });
                case "designer_import":
                    if ((args.spec === undefined) === (args.url === undefined))
                        return refused(new DesignerError("invalid_arguments", "give the spec's text or its url, one of them"));
                    return ok(
                        args.url !== undefined
                            ? await w.importUrl({ host: s("host"), slot: s("slot"), url: s("url") })
                            : w.importSpec({ host: s("host"), slot: s("slot"), spec: s("spec") })
                    );
                case "designer_get":
                    return ok(w.view(s("draftId")));
                case "designer_update":
                    return ok(w.update(s("draftId"), args.binding));
                case "designer_review":
                    return ok(w.review(s("draftId")));
                case "designer_dry_run":
                    return ok(w.dryRun(s("draftId"), s("tool"), (args.arguments as Record<string, unknown> | undefined) ?? {}));
                case "designer_publish":
                    return ok(
                        w.publish(s("draftId"), {
                            sha256: s("sha256"),
                            signature: args.signature,
                            approvedWriteTools: Array.isArray(args.approvedWriteTools) ? args.approvedWriteTools.map(String) : [],
                        })
                    );
                default:
                    return refused(new DesignerError("unknown_tool", `unknown tool: ${toolName}`));
            }
        } catch (error) {
            if (error instanceof DesignerError) return refused(error);
            throw error;
        }
    }
}

/** The design tools as an mcp-core behavior. */
export class DesignerBehavior extends McpBehavior {
    constructor(slot: string, workbench: Workbench) {
        super(new DesignerAdapter(slot, workbench), { namespace: slot });
    }

    protected override _buildTools(): McpTool[] {
        return [...DESIGNER_TOOLS];
    }
}

export interface IRunningDesigner {
    readonly slot: string;
    readonly workbench: Workbench;
    stop(): Promise<void>;
}

/**
 * Publishes the designer on its slot over the broker's provider socket. The
 * Tier 4 page ({@link DESIGNER_UI_DIR}) calls it at `/<slot>/mcp` on the
 * broker's origin.
 */
export async function startDesigner(
    config: IDesignerConfig,
    hosts: readonly IDesignHost[],
    options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly onPublish?: (event: IPublishEvent) => void; readonly openTimeoutMs?: number } = {}
): Promise<IRunningDesigner> {
    const env = options.env ?? process.env;
    const slot = config.slot ?? "designer";
    const secret = config.broker.secretEnv ? env[config.broker.secretEnv] : undefined;
    if (config.broker.secretEnv && !secret) throw new Error(`the provider secret variable ${config.broker.secretEnv} is not set`);

    const workbench = new Workbench(hosts, {
        ...(config.maxDrafts ? { maxDrafts: config.maxDrafts } : {}),
        ...(config.maxSpecBytes ? { maxSpecBytes: config.maxSpecBytes } : {}),
        ...(config.specOrigins ? { specOrigins: config.specOrigins } : {}),
        ...(options.onPublish ? { onPublish: options.onPublish } : {}),
    });
    const transport = MultiplexTransport.create(slot, config.broker.url, secret ? { secret } : {});
    const server: IMcpServer = new McpServerBuilder().withName(slot).withTransport(transport).register(new DesignerBehavior(slot, workbench)).build();
    await server.start();
    const stop = async (): Promise<void> => {
        await server.stop();
    };
    try {
        await opened(transport, options.openTimeoutMs ?? 10_000);
    } catch (error) {
        await stop();
        throw error;
    }
    return { slot, workbench, stop };
}
