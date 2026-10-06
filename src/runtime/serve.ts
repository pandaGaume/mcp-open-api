import { LoopbackTransport, McpServerBuilder, type IMessageTransport } from "@cyanmycelium/mcp-core";
import { BrokerAccessGuard, type IBrokerAuthority } from "@cyanmycelium/mcp-uns";
import type { IManifest } from "../manifest/manifest.types";
import { ManifestBehavior } from "./behavior";
import { ManifestEngine, type IEngineOptions } from "./engine";
import { HttpPool } from "./http";
import { opened } from "./open";

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

/**
 * A provider transport of `@cyanmycelium/mcp-broker-provider`
 * (`MultiplexTransport`, `DirectTransport`): the MCP traffic of one slot,
 * plus `broker`, the broker's own methods for that slot.
 */
export interface IProviderTransport extends IMessageTransport {
    readonly broker: {
        declare(declaration: never): Promise<unknown>;
        authorize: IBrokerAuthority["authorize"];
        reportResult: IBrokerAuthority["reportResult"];
    };
}

export interface IServeManifestOptions extends Omit<IEngineOptions, "guard"> {
    /** Loopback only: the provider identity the slot publishes and declares under. */
    readonly principal?: { readonly id: string; readonly allowedResources?: readonly string[] };
    /** Provider transport only: how long to wait for the socket before declaring. Default 10 s. */
    readonly openTimeoutMs?: number;
}

export interface IServedManifest {
    readonly engine: ManifestEngine;
    /** Loopback only. */
    readonly handle?: ILoopbackProviderHandle;
    /** The broker's answer to the declaration, `undefined` when the manifest has none. */
    readonly declaration?: BrokerMethodOutcome;
    stop(): Promise<void>;
}

/** The broker refused the slot's declaration; the slot is not served. */
export class ManifestDeclarationError extends Error {
    /** What the broker said, every problem included (`data.errors`). */
    readonly reasons: readonly string[];

    constructor(
        readonly slot: string,
        readonly brokerError: { readonly code?: number; readonly message: string; readonly data?: unknown }
    ) {
        const errors = (brokerError.data as { errors?: unknown } | undefined)?.errors;
        const reasons = Array.isArray(errors) ? errors.map(String) : [brokerError.message];
        super(`the broker refused the declaration of slot "${slot}":\n- ${reasons.join("\n- ")}`);
        this.name = "ManifestDeclarationError";
        this.reasons = reasons;
    }
}

/**
 * The `broker/authorization/declare` parameters of a manifest, paths made
 * absolute: what a host sends with `transport.broker.declare(...)`, like
 * mcp-cache's `buildCacheDeclaration`. `undefined` when the manifest declares
 * nothing.
 */
export function buildManifestDeclaration(manifest: IManifest): Record<string, unknown> | undefined {
    return declarationOf(manifest);
}

/** The `broker/authorization/declare` parameters of a manifest, paths made absolute. */
export function declarationOf(manifest: IManifest): Record<string, unknown> | undefined {
    const d = manifest.declaration;
    if (!d) return undefined;
    const namespace = d.namespace.replace(/\/$/, "");
    return {
        version: manifest.provenance.binding,
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
    };
}

/**
 * Serves a manifest in the broker's own process: no socket, no framing. For
 * an application that embeds the broker; a standalone host uses
 * {@link serveManifestOver} instead, and keeps large responses out of the
 * broker's event loop.
 *
 * The manifest must have been verified (signature, hash) before it gets here.
 */
export async function serveManifest(host: ILoopbackHost, manifest: IManifest, options: IServeManifestOptions = {}): Promise<IServedManifest> {
    let handle: ILoopbackProviderHandle | undefined;
    const authority: IBrokerAuthority = {
        async authorize(query) {
            const outcome = await handle!.authorize(query);
            if ("error" in outcome) throw new Error(outcome.error.message);
            return outcome.result as Awaited<ReturnType<IBrokerAuthority["authorize"]>>;
        },
        reportResult: (report) => handle!.reportResult(report),
    };
    const pool = options.pool ?? new HttpPool();
    const engine = new ManifestEngine(manifest, { ...options, pool, guard: new BrokerAccessGuard(authority, { constraints: "return" }) });

    const [serverEnd, clientEnd] = LoopbackTransport.createPair();
    const server = new McpServerBuilder().withName(manifest.slot).withTransport(serverEnd).register(new ManifestBehavior(engine)).build();
    await server.start();
    handle = host.registerLoopbackProvider(manifest.slot, clientEnd, options.principal ? { principal: options.principal } : {});
    const stop = async (): Promise<void> => {
        await server.stop();
        engine.close();
        if (!options.pool) pool.close();
    };

    const params = declarationOf(manifest);
    if (!params) return { engine, handle, stop };
    const declaration = await handle.declare(params);
    if ("error" in declaration) {
        await stop();
        throw new ManifestDeclarationError(manifest.slot, declaration.error);
    }
    return { engine, handle, declaration, stop };
}

/**
 * Serves a manifest over a provider transport: the slot is published from
 * this process (an mcp-open-api host), not from the broker's. The transport's
 * identity is the provider's: its secret, its `allowedResources`.
 */
export async function serveManifestOver(transport: IProviderTransport, manifest: IManifest, options: IServeManifestOptions = {}): Promise<IServedManifest> {
    const pool = options.pool ?? new HttpPool();
    const engine = new ManifestEngine(manifest, { ...options, pool, guard: new BrokerAccessGuard(transport.broker, { constraints: "return" }) });
    const server = new McpServerBuilder().withName(manifest.slot).withTransport(transport).register(new ManifestBehavior(engine)).build();
    // The message handler is installed before the socket opens: the broker may
    // replay `initialize` the moment it does.
    await server.start();
    const stop = async (): Promise<void> => {
        await server.stop();
        engine.close();
        if (!options.pool) pool.close();
    };
    try {
        await opened(transport, options.openTimeoutMs ?? 10_000);
    } catch (error) {
        await stop();
        throw error;
    }

    const params = declarationOf(manifest);
    if (!params) return { engine, stop };
    try {
        const result = await transport.broker.declare(params as never);
        return { engine, declaration: { result }, stop };
    } catch (error) {
        await stop();
        const e = error as { message?: string; code?: number; data?: unknown };
        throw new ManifestDeclarationError(manifest.slot, { message: e.message ?? String(error), ...(e.code !== undefined ? { code: e.code } : {}), data: e.data });
    }
}
