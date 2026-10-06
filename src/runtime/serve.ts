import { LoopbackTransport, McpServerBuilder, type IMessageTransport } from "@cyanmycelium/mcp-core";
import { BrokerAccessGuard, type IBrokerAuthority } from "@cyanmycelium/mcp-uns";
import type { IManifest } from "../manifest/manifest.types";
import { ManifestBehavior } from "./behavior";
import { ManifestEngine, type IEngineOptions } from "./engine";

/** What a broker method answers on a loopback handle (mcp-broker `BrokerMethodOutcome`). */
export type BrokerMethodOutcome = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

/**
 * The part of mcp-broker's `ILoopbackProviderHandle` the engine uses, restated
 * so this package does not depend on the broker at runtime.
 */
export interface ILoopbackProviderHandle {
    declare(params: unknown): Promise<BrokerMethodOutcome>;
    authorize(params: unknown): Promise<BrokerMethodOutcome>;
    reportResult(params: unknown): void;
}

/** The part of mcp-broker's `WsTunnel` the engine uses. */
export interface ILoopbackHost {
    registerLoopbackProvider(
        name: string,
        transport: IMessageTransport,
        options?: { readonly principal?: { readonly id: string; readonly allowedResources?: readonly string[] } }
    ): ILoopbackProviderHandle;
}

export interface IServeManifestOptions extends Omit<IEngineOptions, "guard"> {
    /** The provider identity the slot publishes and declares under. Required when the manifest has a declaration. */
    readonly principal?: { readonly id: string; readonly allowedResources?: readonly string[] };
}

export interface IServedManifest {
    readonly engine: ManifestEngine;
    readonly handle: ILoopbackProviderHandle;
    /** The broker's answer to the declaration, `undefined` when the manifest has none. */
    readonly declaration?: BrokerMethodOutcome;
    stop(): Promise<void>;
}

/** The broker as the authority a {@link BrokerAccessGuard} asks: loopback outcomes unwrapped, errors thrown. */
function authorityOf(handle: () => ILoopbackProviderHandle): IBrokerAuthority {
    return {
        async authorize(query) {
            const outcome = await handle().authorize(query);
            if ("error" in outcome) throw new Error(outcome.error.message);
            return outcome.result as Awaited<ReturnType<IBrokerAuthority["authorize"]>>;
        },
        reportResult(report) {
            handle().reportResult(report);
        },
    };
}

/**
 * Serves a manifest in the broker's own process: no socket, no framing. The
 * slot is registered as a loopback provider, then its authorization is
 * declared. Engineering limits returned by the broker are applied by the engine
 * (`constraints: "return"`).
 *
 * The manifest must have been verified (signature, hash) before it gets here.
 */
export async function serveManifest(host: ILoopbackHost, manifest: IManifest, options: IServeManifestOptions = {}): Promise<IServedManifest> {
    let handle: ILoopbackProviderHandle | undefined;
    const guard = new BrokerAccessGuard(
        authorityOf(() => handle!),
        { constraints: "return" }
    );
    const engine = new ManifestEngine(manifest, { ...options, guard });

    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder().withName(manifest.slot).withTransport(serverEnd).register(new ManifestBehavior(engine)).build();
    await server.start();
    handle = host.registerLoopbackProvider(manifest.slot, clientEnd, options.principal ? { principal: options.principal } : {});

    const stop = async (): Promise<void> => {
        await server.stop();
        engine.close();
    };

    let declaration: BrokerMethodOutcome | undefined;
    if (manifest.declaration) {
        const d = manifest.declaration;
        const namespace = d.namespace.replace(/\/$/, "");
        declaration = await handle.declare({
            version: `${manifest.provenance.binding}`,
            domain: d.domain,
            namespace: { resource: d.namespace },
            capabilities: d.capabilities,
            ...(d.resources?.length
                ? {
                      resources: d.resources.map((r) =>
                          "resourcePattern" in r
                              ? { resourcePattern: `${namespace}/${r.resourcePattern}`, ...(r.where ? { where: r.where } : {}), limits: r.limits }
                              : { resource: r.resource, resourcePath: `${namespace}/${r.resourcePath}`, ...(r.limits ? { limits: r.limits } : {}) }
                      ),
                  }
                : {}),
            ...(d.resultsRequired?.length ? { resultsRequired: d.resultsRequired } : {}),
        });
        // A slot whose declaration was refused would answer every call with a
        // denial: it is not served at all, and the reasons are thrown.
        if ("error" in declaration) {
            await stop();
            throw new ManifestDeclarationError(manifest.slot, declaration.error);
        }
    }

    return { engine, handle, ...(declaration ? { declaration } : {}), stop };
}

/** The broker refused the slot's declaration; the slot is not served. */
export class ManifestDeclarationError extends Error {
    /** What the broker said, every problem included (`data.errors`). */
    readonly reasons: readonly string[];

    constructor(
        readonly slot: string,
        readonly brokerError: { readonly code: number; readonly message: string; readonly data?: unknown }
    ) {
        const errors = (brokerError.data as { errors?: unknown } | undefined)?.errors;
        const reasons = Array.isArray(errors) ? errors.map(String) : [brokerError.message];
        super(`the broker refused the declaration of slot "${slot}":\n- ${reasons.join("\n- ")}`);
        this.name = "ManifestDeclarationError";
        this.reasons = reasons;
    }
}
