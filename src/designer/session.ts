import { openGuard } from "@cyanmycelium/mcp-uns";
import type { IBinding } from "../binding/binding.types";
import { canonicalJson, sha256 } from "../compiler/canonical";
import { compile } from "../compiler/compile";
import { Diagnostics, type IDiagnostic } from "../compiler/diagnostics";
import { Spec, isObject, parseSpec, type Json } from "../compiler/spec";
import type { IManifest, IManifestTool } from "../manifest/manifest.types";
import { ManifestEngine, ManifestLoadError, type IPlannedRequest } from "../runtime/engine";
import { NO_NETWORK } from "../runtime/transport";
import { DesignerError } from "./errors";

/**
 * What the designer knows of the host that will serve the manifest: the
 * origins it may call and the names of its secrets, never their values. Read
 * from the host's `mcp-open-api.json` with {@link hostProfileOf}, or typed.
 */
export interface IHostProfile {
    readonly name?: string;
    readonly allowedTargets: readonly string[];
    readonly secrets: readonly string[];
}

/** One operation of the imported spec, as the Selection step lists it. */
export interface IOperationView {
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly summary?: string;
    readonly tags: readonly string[];
    /** Anything but GET and HEAD: needs an authorization and an individual approval. */
    readonly write: boolean;
    readonly deprecated: boolean;
    /** Argument locations the binding can address: `path.id`, `query.debug`, `body.position`. */
    readonly locations: readonly string[];
}

export interface IDraftView {
    readonly spec: { readonly title?: string; readonly version?: string; readonly openapi: string; readonly sha256: string; readonly source?: string };
    readonly operations: readonly IOperationView[];
    readonly binding: IBinding;
}

export interface IManifestDiff {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly { readonly tool: string; readonly fields: readonly string[] }[];
    /** Slot-level fields that differ: `target`, `declaration`, `title`, `instructions`. */
    readonly slot: readonly string[];
}

/** What the Checks and Review steps show. */
export interface IReview {
    /** No error: the manifest can be signed. */
    readonly ok: boolean;
    /** The compiler's, then the host's (`host.*`). */
    readonly diagnostics: readonly IDiagnostic[];
    /** The canonical manifest: the exact text that is signed and served. */
    readonly canonical?: string;
    readonly sha256?: string;
    /** Tools whose method changes state: each needs its own approval. */
    readonly writeTools: readonly string[];
    /** Against the manifest given to {@link DesignSession.compareWith}, or against nothing. */
    readonly diff?: IManifestDiff;
    readonly previous?: { readonly sha256: string };
}

/** The files a reviewed draft produces: the manifest is what a host serves; the sources recompile it. */
export interface IDesignFiles {
    readonly manifest: { readonly name: string; readonly text: string };
    readonly binding: { readonly name: string; readonly text: string };
    readonly spec: { readonly name: string; readonly text: string };
}

const READ_METHODS = new Set(["GET", "HEAD"]);
const SLOT_NAME = /^[a-z][a-z0-9-]{0,47}$/;
/** What a dry run shows instead of a credential: the designer never holds one. */
const placeholder = (ref: string): string => `<secret:${ref}>`;

/** The profile of a host, from its `mcp-open-api.json`: targets and secret names only. */
export function hostProfileOf(config: unknown, name?: string): IHostProfile {
    const c = config as { allowedTargets?: unknown; secrets?: unknown } | null;
    if (!c || !Array.isArray(c.allowedTargets) || !c.allowedTargets.every((t) => typeof t === "string"))
        throw new DesignerError("invalid_host_config", "a host config needs allowedTargets, a list of origins");
    return {
        ...(name ? { name } : {}),
        allowedTargets: c.allowedTargets as string[],
        secrets: isObject(c.secrets) ? Object.keys(c.secrets) : [],
    };
}

/**
 * One API being designed: its spec, the binding being tuned, compiled and
 * checked on every change. Pure: no file, no network, no key; it runs in a
 * browser page as in Node. What it produces is a manifest to sign and hand
 * to a host.
 */
export class DesignSession {
    private _binding: IBinding;
    private _host?: IHostProfile;
    private _previous?: IManifest;

    private constructor(
        private readonly _specText: string,
        private readonly _spec: Spec,
        private readonly _specExt: "json" | "yaml",
        private readonly _source: string | undefined,
        binding: IBinding
    ) {
        this._binding = binding;
    }

    /** Reads a spec and opens a draft on it: every operation is a candidate, none is exposed yet. */
    static import(input: { readonly slot: string; readonly spec: string; readonly source?: string; readonly host?: IHostProfile; readonly maxSpecBytes?: number }): DesignSession {
        if (!SLOT_NAME.test(input.slot)) throw new DesignerError("invalid_slot", `"${input.slot}" is not a slot name (^[a-z][a-z0-9-]{0,47}$)`);
        const max = input.maxSpecBytes ?? 5 * 1024 * 1024;
        const bytes = new TextEncoder().encode(input.spec).length;
        if (bytes > max) throw new DesignerError("spec_too_large", `the spec is ${bytes} bytes, past the ${max} limit`);

        let doc: unknown;
        try {
            doc = parseSpec(input.spec);
        } catch (error) {
            throw new DesignerError("spec_parse", `the spec is neither JSON nor YAML: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (isObject(doc) && doc.swagger === "2.0")
            throw new DesignerError(
                "swagger_2",
                "this is a Swagger 2.0 description: only OpenAPI 3.0 and 3.1 are supported. Convert it first (swagger2openapi, or editor.swagger.io)"
            );
        const diag = new Diagnostics();
        const spec = Spec.load(doc, diag);
        if (!spec || diag.hasErrors)
            throw new DesignerError(
                "spec_invalid",
                "the spec cannot be imported",
                diag.list.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)
            );

        const specExt = input.spec.trimStart().startsWith("{") ? "json" : "yaml";
        const secretNames = input.host?.secrets ?? [];
        const schemes = isObject(spec.doc.components) && isObject(spec.doc.components.securitySchemes) ? Object.keys(spec.doc.components.securitySchemes) : [];
        const info = isObject(spec.doc.info) ? spec.doc.info : {};
        const binding: IBinding = {
            binding: 1,
            slot: input.slot,
            ...(typeof info.title === "string" ? { title: info.title } : {}),
            spec: { path: `${input.slot}.openapi.${specExt}`, sha256: sha256(input.spec) },
            target: {
                baseUrl: suggestBaseUrl(spec, input.host?.allowedTargets, input.source),
                ...(schemes.length > 0 && secretNames.length === 1 ? { auth: { secretRef: secretNames[0]!, ...(schemes.length > 1 ? { scheme: schemes[0]! } : {}) } } : {}),
            },
            tools: {},
        };
        const session = new DesignSession(input.spec, spec, specExt, input.source, binding);
        if (input.host) session._host = input.host;
        return session;
    }

    get binding(): IBinding {
        return this._binding;
    }

    view(): IDraftView {
        const info = isObject(this._spec.doc.info) ? this._spec.doc.info : {};
        return {
            spec: {
                ...(typeof info.title === "string" ? { title: info.title } : {}),
                ...(typeof info.version === "string" ? { version: info.version } : {}),
                openapi: String(this._spec.doc.openapi),
                sha256: sha256(this._specText),
                ...(this._source ? { source: this._source } : {}),
            },
            operations: [...this._spec.operations.values()].map((op) => ({
                key: op.key,
                method: op.method,
                path: op.path,
                ...(typeof op.operation.summary === "string" ? { summary: op.operation.summary } : {}),
                tags: Array.isArray(op.operation.tags) ? op.operation.tags.filter((t): t is string => typeof t === "string") : [],
                write: !READ_METHODS.has(op.method),
                deprecated: op.operation.deprecated === true,
                locations: locationsOf(this._spec, op),
            })),
            binding: this._binding,
        };
    }

    /** The host the manifest is meant for; without one, targets and secrets are not checked. */
    setHost(host: IHostProfile | undefined): void {
        this._host = host;
    }

    /** The version a host serves today, to review what changes. */
    compareWith(previous: unknown): void {
        if (previous === undefined) {
            this._previous = undefined;
            return;
        }
        const m = previous as Partial<IManifest> | null;
        if (!m || m.manifest !== 1 || !Array.isArray(m.tools)) throw new DesignerError("invalid_manifest", "this is not a manifest-1 file");
        this._previous = previous as IManifest;
    }

    /** Replaces the binding; the spec stays the imported one. */
    update(binding: unknown): IReview {
        if (!isObject(binding)) throw new DesignerError("invalid_binding", "the binding must be an object");
        const slot = typeof binding.slot === "string" ? binding.slot : this._binding.slot;
        this._binding = { ...(binding as unknown as IBinding), spec: { path: `${slot}.openapi.${this._specExt}`, sha256: sha256(this._specText) } };
        return this.review();
    }

    /** Compiles the binding and checks it against the host: what the Checks and Review steps show. */
    review(): IReview {
        const result = compile({ binding: this._binding, spec: this._specText });
        const diagnostics: IDiagnostic[] = [...result.diagnostics];
        if (!result.manifest) return { ok: false, diagnostics, writeTools: [] };
        const manifest = result.manifest;
        const host = this._host;
        if (!host)
            diagnostics.push({
                code: "host.unchecked",
                severity: "warning",
                message: "no host profile: the target and the secrets are not checked against the host that will serve this manifest",
            });
        else {
            try {
                this._engine(manifest).close();
            } catch (error) {
                if (!(error instanceof ManifestLoadError)) throw error;
                for (const problem of error.problems)
                    diagnostics.push({ code: "host.refused", severity: "error", message: `${host.name ? `host "${host.name}"` : "the host"} would refuse it: ${problem}` });
            }
        }
        return {
            ok: !diagnostics.some((d) => d.severity === "error"),
            diagnostics,
            canonical: result.canonical!,
            sha256: result.sha256!,
            writeTools: manifest.tools.filter((t) => !READ_METHODS.has(t.http.method)).map((t) => t.name),
            diff: diff(this._previous, manifest),
            ...(this._previous ? { previous: { sha256: sha256(canonicalJson(this._previous)) } } : {}),
        };
    }

    /** The HTTP request a call would send, credentials as placeholders. Nothing is sent. */
    dryRun(tool: string, args: Record<string, unknown>): IPlannedRequest {
        const result = compile({ binding: this._binding, spec: this._specText });
        if (!result.manifest)
            throw new DesignerError(
                "not_compiled",
                "the draft does not compile",
                result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)
            );
        let engine: ManifestEngine;
        try {
            engine = this._engine(result.manifest);
        } catch (error) {
            if (error instanceof ManifestLoadError) throw new DesignerError("host_refused", "the host would refuse the manifest", error.problems);
            throw error;
        }
        const plan = engine.plan(tool, args);
        engine.close();
        if ("error" in plan) {
            const content = plan.error.content[0];
            const error = (JSON.parse(content?.type === "text" ? content.text : "{}") as { error: { code: string; message: string } }).error;
            throw new DesignerError(error.code, error.message);
        }
        return plan.request;
    }

    /** The manifest and its sources, ready to save. Refused while the draft has errors. */
    files(): IDesignFiles {
        const review = this.review();
        if (!review.ok)
            throw new DesignerError(
                "not_ready",
                "the draft has errors",
                review.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)
            );
        const slot = this._binding.slot;
        return {
            manifest: { name: `${slot}.json`, text: `${review.canonical!}\n` },
            binding: { name: `${slot}.binding.json`, text: `${JSON.stringify(this._binding, null, 4)}\n` },
            spec: { name: `${slot}.openapi.${this._specExt}`, text: this._specText },
        };
    }

    private _engine(manifest: IManifest): ManifestEngine {
        const host = this._host;
        return new ManifestEngine(manifest, {
            guard: openGuard(),
            pool: NO_NETWORK,
            ...(host ? { allowedTargets: host.allowedTargets } : {}),
            secrets: (ref) => (!host || host.secrets.includes(ref) ? placeholder(ref) : undefined),
        });
    }
}

/**
 * The spec's first server the host allows (any, without a host); else the
 * host's first allowed target. A relative server URL (`/api/v3`) is relative
 * to where the spec was fetched from.
 */
function suggestBaseUrl(spec: Spec, allowedTargets: readonly string[] | undefined, source?: string): string {
    const servers = Array.isArray(spec.doc.servers) ? spec.doc.servers : [];
    for (const server of servers) {
        if (!isObject(server) || typeof server.url !== "string") continue;
        try {
            const url = new URL(server.url, source);
            if (!allowedTargets || allowedTargets.includes(url.origin)) return url.href.replace(/\/$/, "");
        } catch {
            // a relative server URL without a source says nothing about the origin
        }
    }
    return allowedTargets?.[0] ?? "https://api.example.com";
}

/** The argument locations of an operation, for the Tuning step. The compiler stays the judge of what each one supports. */
function locationsOf(spec: Spec, op: { pathItem: Record<string, Json>; operation: Record<string, Json>; at: string }): string[] {
    const quiet = new Diagnostics();
    const out = new Set<string>();
    for (const list of [op.pathItem.parameters, op.operation.parameters]) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
            const param = spec.deref(raw, op.at, quiet);
            if (isObject(param) && typeof param.name === "string" && (param.in === "path" || param.in === "query" || param.in === "header")) out.add(`${param.in}.${param.name}`);
        }
    }
    const body = spec.deref(op.operation.requestBody, op.at, quiet);
    if (isObject(body) && isObject(body.content)) {
        const type = Object.keys(body.content).find((t) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(t));
        const media = type ? body.content[type] : undefined;
        const schema = isObject(media) ? spec.deref(media.schema, op.at, quiet) : undefined;
        if (isObject(schema) && isObject(schema.properties)) for (const prop of Object.keys(schema.properties)) out.add(`body.${prop}`);
        else if (type) out.add("body");
    }
    return [...out];
}

/** What changes between the published manifest and the reviewed one, tool by tool. */
function diff(before: IManifest | undefined, after: IManifest): IManifestDiff {
    const old = new Map((before?.tools ?? []).map((t) => [t.name, t]));
    const now = new Map(after.tools.map((t) => [t.name, t]));
    const changed: { tool: string; fields: string[] }[] = [];
    for (const [name, tool] of now) {
        const prev = old.get(name);
        if (!prev) continue;
        const keys = new Set([...Object.keys(prev), ...Object.keys(tool)]) as Set<keyof IManifestTool>;
        const fields = [...keys].filter((k) => canonicalJson(prev[k] ?? null) !== canonicalJson(tool[k] ?? null)).sort();
        if (fields.length > 0) changed.push({ tool: name, fields });
    }
    const slotFields = ["title", "instructions", "target", "declaration"] as const;
    return {
        added: [...now.keys()].filter((n) => !old.has(n)).sort(),
        removed: [...old.keys()].filter((n) => !now.has(n)).sort(),
        changed,
        slot: before ? slotFields.filter((k) => canonicalJson(before[k] ?? null) !== canonicalJson(after[k] ?? null)) : [],
    };
}
