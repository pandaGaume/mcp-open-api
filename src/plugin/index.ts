import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { verifyManifest } from "../host/signature";
import { HttpPool } from "../runtime/http";
import { serveManifest, type ILoopbackProviderHandle, type IServedManifest } from "../runtime/serve";
import type { IMessageTransport } from "@cyanmycelium/mcp-core";

/** Structural API v1 contract: no runtime or type dependency on the broker package. */
export interface IOpenApiPluginContext {
    readonly baseDir: string;
    registerSlot(name: string, transport: IMessageTransport): ILoopbackProviderHandle;
    onCleanup(dispose: () => void | Promise<void>): void;
    log(message: string): void;
}

export interface IOpenApiPluginConfig {
    readonly manifests: string | readonly string[];
    readonly trustedKeys: readonly string[];
    readonly allowedTargets: readonly string[];
    readonly secrets?: Readonly<Record<string, { readonly env: string }>>;
}

function parseConfig(value: unknown): IOpenApiPluginConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("open-api plugin config must be an object");
    const config = value as IOpenApiPluginConfig;
    const entries = typeof config.manifests === "string" ? [config.manifests] : config.manifests;
    if (!Array.isArray(entries) || !entries.length || entries.some((entry) => typeof entry !== "string" || !entry))
        throw new Error("manifests must name at least one file or directory");
    if (!Array.isArray(config.trustedKeys) || !config.trustedKeys.length || config.trustedKeys.some((key) => typeof key !== "string" || !key))
        throw new Error("trustedKeys must name at least one public key file");
    if (!Array.isArray(config.allowedTargets) || config.allowedTargets.some((origin) => typeof origin !== "string" || new URL(origin).origin !== origin))
        throw new Error("allowedTargets must contain exact URL origins");
    if (config.secrets !== undefined) {
        if (!config.secrets || typeof config.secrets !== "object" || Array.isArray(config.secrets)) throw new Error("secrets must be an object of environment references");
        for (const [name, source] of Object.entries(config.secrets)) {
            if (!source || typeof source.env !== "string" || !source.env) throw new Error(`secret "${name}" must name an env variable`);
        }
    }
    if ("allowUnsigned" in config) throw new Error("the plugin requires signed manifests; allowUnsigned is unsupported");
    return config;
}

/** A broker plugin loaded from @cyanmycelium/mcp-open-api/plugin. */
const plugin = {
    apiVersion: 1 as const,
    async start(context: IOpenApiPluginContext, value: unknown): Promise<{ stop(): Promise<void> }> {
        const config = parseConfig(value);
        const entries = typeof config.manifests === "string" ? [config.manifests] : config.manifests;
        const paths = entries.flatMap((entry) => {
            const path = resolve(context.baseDir, entry);
            return statSync(path).isDirectory()
                ? readdirSync(path)
                      .filter((file) => file.endsWith(".json"))
                      .sort()
                      .map((file) => join(path, file))
                : [path];
        });
        if (!paths.length) throw new Error("no manifest found");
        const publicKeys = config.trustedKeys.map((file) => readFileSync(resolve(context.baseDir, file), "utf8"));
        // Verify the complete batch before publishing any slot.
        const manifests = paths.map((path) => verifyManifest(readFileSync(path, "utf8"), readFileSync(`${path}.sig`, "utf8"), publicKeys));
        const slots = new Set<string>();
        for (const manifest of manifests) {
            if (slots.has(manifest.slot)) throw new Error(`duplicate manifest slot "${manifest.slot}"`);
            slots.add(manifest.slot);
        }

        const pool = new HttpPool();
        const served: IServedManifest[] = [];
        let stopping: Promise<void> | undefined;
        const stop = (): Promise<void> =>
            (stopping ??= (async () => {
                const failures: unknown[] = [];
                for (const slot of served.reverse()) {
                    try {
                        await slot.stop();
                    } catch (error) {
                        failures.push(error);
                    }
                }
                pool.close();
                if (failures.length) throw new AggregateError(failures, "open-api plugin shutdown failed");
                context.log("stopped");
            })());
        context.onCleanup(stop);
        try {
            const host = { registerLoopbackProvider: (name: string, transport: IMessageTransport) => context.registerSlot(name, transport) };
            for (const manifest of manifests) {
                served.push(
                    await serveManifest(host, manifest, {
                        pool,
                        allowedTargets: config.allowedTargets,
                        secrets: (ref) => {
                            const source = config.secrets?.[ref];
                            return source ? process.env[source.env] : undefined;
                        },
                    })
                );
                context.log(`serving slot "${manifest.slot}"`);
            }
        } catch (error) {
            await stop();
            throw error;
        }
        return { stop };
    },
};

export default plugin;
