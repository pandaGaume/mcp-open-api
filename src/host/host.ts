import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MultiplexTransport } from "@cyanmycelium/mcp-broker-provider";
import type { IManifest } from "../manifest/manifest.types";
import { HttpPool } from "../runtime/http";
import { serveManifestOver, type IServedManifest } from "../runtime/serve";
import { signatureProblem, trustedKeysFrom } from "./signature";

/**
 * The configuration of an mcp-open-api host: the process that serves
 * manifests as broker slots. The broker knows nothing of manifests; to it,
 * the host is one provider identity publishing several slots.
 */
export interface IHostConfig {
    readonly broker: {
        /** The broker's shared provider socket: `ws://<host>:<port>/providers`. */
        readonly url: string;
        /** Environment variable holding the host's provider secret (its identity in the broker's security file). */
        readonly secretEnv?: string;
        /** Puts every slot in `_all` too. Default false. */
        readonly aggregate?: boolean;
    };
    /**
     * The manifests to serve, one slot each: a manifest file, a directory of
     * `*.json` manifests, or a list of either. Each has its `<file>.sig`.
     * Relative to the config file.
     */
    readonly manifests: string | readonly string[];
    /** PEM files of the Ed25519 keys a manifest may be signed with. Relative to the config file. */
    readonly trustedKeys?: readonly string[];
    /** Serve unsigned manifests. For development only; false by default. */
    readonly allowUnsigned?: boolean;
    /** Origins (`https://host:port`) manifests may call; a manifest with any other target is refused. */
    readonly allowedTargets: readonly string[];
    /** Where each `secretRef` of the manifests is read from. */
    readonly secrets?: Readonly<Record<string, { readonly env: string }>>;
}

export interface IHostedSlot {
    readonly file: string;
    readonly slot: string;
    readonly served: IServedManifest;
}

export interface IRefusedManifest {
    readonly file: string;
    readonly reasons: readonly string[];
}

/** Reads a config file; relative paths in it are resolved against its directory. */
export function loadHostConfig(path: string): { config: IHostConfig; baseDir: string } {
    const config = JSON.parse(readFileSync(path, "utf8")) as IHostConfig;
    if (!config.broker?.url || !config.manifests || !Array.isArray(config.allowedTargets)) {
        throw new Error(`${path}: broker.url, manifests and allowedTargets are required`);
    }
    return { config, baseDir: dirname(resolve(path)) };
}

/**
 * Opens one broker slot per manifest it is given, over one shared socket. A manifest is served only if it is signed by a trusted key, calls an
 * allowed target, has all its secrets, and its declaration is accepted; any
 * other is refused with its reasons, and the others are still served.
 */
export class OpenApiHost {
    readonly slots: IHostedSlot[] = [];
    readonly refused: IRefusedManifest[] = [];
    private readonly _pool = new HttpPool();

    constructor(
        private readonly _config: IHostConfig,
        private readonly _baseDir: string = process.cwd(),
        private readonly _env: Readonly<Record<string, string | undefined>> = process.env
    ) {}

    async start(): Promise<this> {
        const config = this._config;
        const keys = trustedKeysFrom((config.trustedKeys ?? []).map((p) => readFileSync(resolve(this._baseDir, p), "utf8")));
        const secret = config.broker.secretEnv ? this._env[config.broker.secretEnv] : undefined;
        if (config.broker.secretEnv && !secret) throw new Error(`the provider secret variable ${config.broker.secretEnv} is not set`);

        const paths: string[] = [];
        for (const entry of typeof config.manifests === "string" ? [config.manifests] : config.manifests) {
            const path = resolve(this._baseDir, entry);
            if (!existsSync(path)) {
                this.refused.push({ file: entry, reasons: ["not found"] });
                continue;
            }
            if (statSync(path).isDirectory())
                paths.push(
                    ...readdirSync(path)
                        .filter((f) => f.endsWith(".json"))
                        .sort()
                        .map((f) => join(path, f))
                );
            else paths.push(path);
        }
        const seen = new Set<string>();
        for (const path of paths) {
            const file = basename(path);
            const reasons: string[] = [];
            let manifest: IManifest;
            try {
                manifest = JSON.parse(readFileSync(path, "utf8")) as IManifest;
            } catch (error) {
                this.refused.push({ file, reasons: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] });
                continue;
            }
            if (seen.has(manifest.slot)) {
                this.refused.push({ file, reasons: [`slot "${manifest.slot}" is already served by another manifest of this host`] });
                continue;
            }
            let signature: unknown;
            try {
                signature = JSON.parse(readFileSync(`${path}.sig`, "utf8"));
            } catch {
                signature = undefined;
            }
            if (signature === undefined) {
                if (!config.allowUnsigned) reasons.push(`no signature (${file}.sig)`);
            } else {
                const problem = signatureProblem(manifest, signature, keys);
                if (problem) reasons.push(problem);
            }
            if (reasons.length > 0) {
                this.refused.push({ file, reasons });
                continue;
            }

            const transport = MultiplexTransport.create(manifest.slot, config.broker.url, {
                ...(secret ? { secret } : {}),
                ...(config.broker.aggregate ? { aggregate: true } : {}),
            });
            try {
                const served = await serveManifestOver(transport, manifest, {
                    allowedTargets: config.allowedTargets,
                    secrets: (ref) => {
                        const env = config.secrets?.[ref]?.env;
                        return env ? this._env[env] : undefined;
                    },
                    pool: this._pool,
                });
                this.slots.push({ file, slot: manifest.slot, served });
                seen.add(manifest.slot);
            } catch (error) {
                transport.close();
                const e = error as { problems?: readonly string[]; reasons?: readonly string[]; message?: string };
                this.refused.push({ file, reasons: e.problems ?? e.reasons ?? [e.message ?? String(error)] });
            }
        }
        return this;
    }

    async stop(): Promise<void> {
        for (const { served } of this.slots) await served.stop();
        this.slots.length = 0;
        this._pool.close();
    }
}
