import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openGuard } from "@cyanmycelium/mcp-uns";
import type { KeyObject } from "node:crypto";
import type { IBinding } from "../binding/binding.types";
import { canonicalJson, sha256 } from "../compiler/canonical";
import { compile } from "../compiler/compile";
import { Diagnostics, type IDiagnostic } from "../compiler/diagnostics";
import { Spec, isObject, parseSpec, type Json } from "../compiler/spec";
import type { IHostConfig } from "../host/host";
import { signatureProblem, trustedKeysFrom } from "../host/signature";
import type { IManifest, IManifestTool } from "../manifest/manifest.types";
import { ManifestEngine, ManifestLoadError, type IPlannedRequest } from "../runtime/engine";

/** A host the designer publishes into: its configuration, as the host itself reads it. */
export interface IDesignHost {
    readonly name: string;
    readonly config: IHostConfig;
    /** Directory the host's relative paths resolve against. */
    readonly baseDir: string;
}

export interface IWorkbenchOptions {
    /** Drafts kept in memory; the oldest is dropped past it. Default 32. */
    readonly maxDrafts?: number;
    /** Largest spec accepted, in bytes. Default 5 MB. */
    readonly maxSpecBytes?: number;
    /** Each publication, for the audit trail. */
    readonly onPublish?: (event: IPublishEvent) => void;
}

export interface IPublishEvent {
    readonly host: string;
    readonly slot: string;
    readonly sha256: string;
    /** SHA-256 of the verifying public key (SPKI DER), the operator's identity for the audit. */
    readonly key: string;
    readonly approvedWriteTools: readonly string[];
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
    readonly draftId: string;
    readonly host: string;
    readonly spec: { readonly title?: string; readonly version?: string; readonly openapi: string; readonly sha256: string };
    readonly operations: readonly IOperationView[];
    readonly binding: IBinding;
}

/** What the Checks and Review steps show. */
export interface IReview {
    readonly draftId: string;
    /** No error: the manifest can be signed. */
    readonly ok: boolean;
    /** The compiler's, then the host's (`host.*`). */
    readonly diagnostics: readonly IDiagnostic[];
    /** The canonical manifest: the exact text the operator signs. */
    readonly canonical?: string;
    readonly sha256?: string;
    /** Tools whose method changes state: each needs its own approval. */
    readonly writeTools: readonly string[];
    /** The version the host currently has for this slot, if any. */
    readonly published?: { readonly sha256: string; readonly file: string };
    readonly diff?: IManifestDiff;
}

export interface IManifestDiff {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly { readonly tool: string; readonly fields: readonly string[] }[];
    /** Slot-level fields that differ: `target`, `declaration`, `title`, `instructions`. */
    readonly slot: readonly string[];
}

export interface IPublishRequest {
    /** The manifest the operator reviewed: publication is refused if the draft changed since. */
    readonly sha256: string;
    /** `{ alg: "Ed25519", manifest, signature }`, made with a key the host trusts. */
    readonly signature: unknown;
    /** Every write tool, approved one by one. */
    readonly approvedWriteTools: readonly string[];
}

export interface IPublishResult {
    readonly host: string;
    readonly slot: string;
    readonly sha256: string;
    readonly files: readonly string[];
    /** Hosts load manifests at startup. */
    readonly next: string;
}

/** A refusal of the designer, with every reason. */
export class DesignerError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly problems: readonly string[] = []
    ) {
        super(problems.length > 0 ? `${message}:\n- ${problems.join("\n- ")}` : message);
        this.name = "DesignerError";
    }
}

interface IDraft {
    readonly id: string;
    readonly host: IResolvedHost;
    readonly specText: string;
    readonly specSha: string;
    readonly specExt: "json" | "yaml";
    readonly spec: Spec;
    binding: IBinding;
    touched: number;
}

interface IResolvedHost extends IDesignHost {
    readonly manifestsDir: string;
    readonly trustedKeys: readonly KeyObject[];
}

const READ_METHODS = new Set(["GET", "HEAD"]);
const SLOT_NAME = /^[a-z][a-z0-9-]{0,47}$/;
/** What a dry run shows instead of a credential: the designer never holds one. */
const placeholder = (ref: string): string => `<secret:${ref}>`;

/**
 * The designer's state: drafts made from imported specs, compiled on every
 * change, checked against the host that will serve them, and published into
 * that host's folder once a person has signed them.
 *
 * The workbench holds no key a host trusts and no API secret: it cannot
 * publish anything nobody signed, and a dry run shows placeholders.
 */
export class Workbench {
    private readonly _hosts = new Map<string, IResolvedHost>();
    private readonly _drafts = new Map<string, IDraft>();
    private readonly _maxDrafts: number;
    private readonly _maxSpecBytes: number;

    constructor(
        hosts: readonly IDesignHost[],
        private readonly _options: IWorkbenchOptions = {}
    ) {
        for (const host of hosts) {
            const pems = (host.config.trustedKeys ?? []).map((p) => readFileSync(resolve(host.baseDir, p), "utf8"));
            this._hosts.set(host.name, { ...host, manifestsDir: resolve(host.baseDir, host.config.manifests), trustedKeys: trustedKeysFrom(pems) });
        }
        this._maxDrafts = _options.maxDrafts ?? 32;
        this._maxSpecBytes = _options.maxSpecBytes ?? 5 * 1024 * 1024;
    }

    /** The hosts, with what a designer must respect: targets, secret names, published slots. */
    hosts(): unknown[] {
        return [...this._hosts.values()].map((h) => ({
            name: h.name,
            allowedTargets: h.config.allowedTargets,
            secrets: Object.keys(h.config.secrets ?? {}),
            trustedKeys: h.trustedKeys.length,
            published: this._published(h),
        }));
    }

    /** Reads a spec and opens a draft on it: every operation is a candidate, none is exposed yet. */
    importSpec(input: { readonly host: string; readonly slot: string; readonly spec: string }): IDraftView {
        const host = this._host(input.host);
        if (!SLOT_NAME.test(input.slot)) throw new DesignerError("invalid_slot", `"${input.slot}" is not a slot name (^[a-z][a-z0-9-]{0,47}$)`);
        const bytes = Buffer.byteLength(input.spec, "utf8");
        if (bytes > this._maxSpecBytes) throw new DesignerError("spec_too_large", `the spec is ${bytes} bytes, past the ${this._maxSpecBytes} limit`);

        let doc: unknown;
        try {
            doc = parseSpec(input.spec);
        } catch (error) {
            throw new DesignerError("spec_parse", `the spec is neither JSON nor YAML: ${error instanceof Error ? error.message : String(error)}`);
        }
        const diag = new Diagnostics();
        const spec = Spec.load(doc, diag);
        if (!spec || diag.hasErrors)
            throw new DesignerError(
                "spec_invalid",
                "the spec cannot be imported",
                diag.list.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)
            );

        const specSha = sha256(input.spec);
        const specExt = input.spec.trimStart().startsWith("{") ? "json" : "yaml";
        const baseUrl = suggestBaseUrl(spec, host.config.allowedTargets);
        const secretNames = Object.keys(host.config.secrets ?? {});
        const schemes = isObject(spec.doc.components) && isObject(spec.doc.components.securitySchemes) ? Object.keys(spec.doc.components.securitySchemes) : [];
        const info = isObject(spec.doc.info) ? spec.doc.info : {};

        const binding: IBinding = {
            binding: 1,
            slot: input.slot,
            ...(typeof info.title === "string" ? { title: info.title } : {}),
            spec: { path: `${input.slot}.openapi.${specExt}`, sha256: specSha },
            target: {
                baseUrl,
                ...(schemes.length > 0 && secretNames.length === 1 ? { auth: { secretRef: secretNames[0]!, ...(schemes.length > 1 ? { scheme: schemes[0]! } : {}) } } : {}),
            },
            tools: {},
        };
        const draft: IDraft = { id: randomUUID(), host, specText: input.spec, specSha, specExt, spec, binding, touched: Date.now() };
        this._drafts.set(draft.id, draft);
        this._evict();
        return this._view(draft);
    }

    view(draftId: string): IDraftView {
        return this._view(this._draft(draftId));
    }

    /** Replaces the draft's binding; its spec stays the imported one. */
    update(draftId: string, binding: unknown): IReview {
        const draft = this._draft(draftId);
        if (!isObject(binding)) throw new DesignerError("invalid_binding", "the binding must be an object");
        draft.binding = { ...(binding as unknown as IBinding), spec: { path: `${String(binding.slot ?? draft.binding.slot)}.openapi.${draft.specExt}`, sha256: draft.specSha } };
        return this.review(draftId);
    }

    /** Compiles the draft and checks it against its host: what the Checks and Review steps show. */
    review(draftId: string): IReview {
        const draft = this._draft(draftId);
        const result = compile({ binding: draft.binding, spec: draft.specText });
        const diagnostics: IDiagnostic[] = [...result.diagnostics];
        const host = draft.host;
        if (host.trustedKeys.length === 0)
            diagnostics.push({ code: "host.no-trusted-key", severity: "error", message: `host "${host.name}" trusts no key: nothing signed could be served` });

        if (!result.manifest) return { draftId, ok: false, diagnostics, writeTools: [] };
        const manifest = result.manifest;
        try {
            this._engine(draft, manifest).close();
        } catch (error) {
            if (!(error instanceof ManifestLoadError)) throw error;
            for (const problem of error.problems) diagnostics.push({ code: "host.refused", severity: "error", message: `host "${host.name}" would refuse it: ${problem}` });
        }
        const other = this._published(host).find((p) => p.slot === manifest.slot && p.file !== `${manifest.slot}.json`);
        if (other) diagnostics.push({ code: "host.slot-taken", severity: "error", message: `host "${host.name}" already serves slot "${manifest.slot}" from ${other.file}` });

        const current = this._current(host, manifest.slot);
        return {
            draftId,
            ok: !diagnostics.some((d) => d.severity === "error"),
            diagnostics,
            canonical: result.canonical!,
            sha256: result.sha256!,
            writeTools: manifest.tools.filter((t) => !READ_METHODS.has(t.http.method)).map((t) => t.name),
            ...(current ? { published: { sha256: current.sha256, file: current.file }, diff: diff(current.manifest, manifest) } : { diff: diff(undefined, manifest) }),
        };
    }

    /** The HTTP request a call would send, credentials as placeholders. Nothing is sent and the broker is not asked. */
    dryRun(draftId: string, tool: string, args: Record<string, unknown>): IPlannedRequest {
        const draft = this._draft(draftId);
        const result = compile({ binding: draft.binding, spec: draft.specText });
        if (!result.manifest)
            throw new DesignerError(
                "not_compiled",
                "the draft does not compile",
                result.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)
            );
        let engine: ManifestEngine;
        try {
            engine = this._engine(draft, result.manifest);
        } catch (error) {
            if (error instanceof ManifestLoadError) throw new DesignerError("host_refused", `host "${draft.host.name}" would refuse the manifest`, error.problems);
            throw error;
        }
        try {
            const plan = engine.plan(tool, args);
            if ("error" in plan) {
                const content = plan.error.content[0];
                const error = (JSON.parse(content?.type === "text" ? content.text : "{}") as { error: { code: string; message: string } }).error;
                throw new DesignerError(error.code, error.message);
            }
            return plan.request;
        } finally {
            engine.close();
        }
    }

    /**
     * Writes a signed manifest into its host's folder. Refused unless the
     * draft compiles and passes the host's checks, is the manifest that was
     * reviewed, has every write tool approved, and is signed by a key the
     * host trusts: the same check the host makes when it loads it.
     */
    publish(draftId: string, request: IPublishRequest): IPublishResult {
        const draft = this._draft(draftId);
        const review = this.review(draftId);
        if (!review.ok)
            throw new DesignerError(
                "not_publishable",
                "the draft has errors",
                review.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`)
            );
        if (request.sha256 !== review.sha256) throw new DesignerError("stale_review", `the draft is now ${review.sha256}, the review was of ${request.sha256}: review it again`);
        const approved = new Set(request.approvedWriteTools);
        const missing = review.writeTools.filter((t) => !approved.has(t));
        if (missing.length > 0)
            throw new DesignerError(
                "not_approved",
                "each write tool must be approved on its own",
                missing.map((t) => `"${t}" is not approved`)
            );

        const manifest = JSON.parse(review.canonical!) as IManifest;
        const key = draft.host.trustedKeys.find((k) => signatureProblem(manifest, request.signature, [k]) === null);
        if (!key) throw new DesignerError("bad_signature", signatureProblem(manifest, request.signature, draft.host.trustedKeys) ?? "the signature is not accepted");

        const dir = draft.host.manifestsDir;
        const sources = join(dir, "sources");
        mkdirSync(sources, { recursive: true });
        const files = [
            atomicWrite(join(sources, `${manifest.slot}.openapi.${draft.specExt}`), draft.specText),
            atomicWrite(join(sources, `${manifest.slot}.binding.json`), `${JSON.stringify(draft.binding, null, 4)}\n`),
            atomicWrite(join(dir, `${manifest.slot}.json`), `${review.canonical!}\n`),
            atomicWrite(join(dir, `${manifest.slot}.json.sig`), `${JSON.stringify(request.signature, null, 2)}\n`),
        ];
        this._options.onPublish?.({
            host: draft.host.name,
            slot: manifest.slot,
            sha256: review.sha256!,
            key: createHash("sha256")
                .update(key.export({ type: "spki", format: "der" }))
                .digest("hex"),
            approvedWriteTools: review.writeTools,
        });
        return { host: draft.host.name, slot: manifest.slot, sha256: review.sha256!, files, next: `restart host "${draft.host.name}" to serve it` };
    }

    private _engine(draft: IDraft, manifest: IManifest): ManifestEngine {
        const secrets = draft.host.config.secrets ?? {};
        return new ManifestEngine(manifest, {
            guard: openGuard(),
            allowedTargets: draft.host.config.allowedTargets,
            secrets: (ref) => (Object.hasOwn(secrets, ref) ? placeholder(ref) : undefined),
        });
    }

    private _published(host: IResolvedHost): { slot: string; sha256: string; file: string }[] {
        if (!existsSync(host.manifestsDir)) return [];
        return readdirSync(host.manifestsDir)
            .filter((f) => f.endsWith(".json"))
            .sort()
            .flatMap((file) => {
                try {
                    const manifest = JSON.parse(readFileSync(join(host.manifestsDir, file), "utf8")) as IManifest;
                    return typeof manifest.slot === "string" ? [{ slot: manifest.slot, sha256: sha256(canonicalJson(manifest)), file }] : [];
                } catch {
                    return [];
                }
            });
    }

    private _current(host: IResolvedHost, slot: string): { manifest: IManifest; sha256: string; file: string } | undefined {
        const file = `${slot}.json`;
        const path = join(host.manifestsDir, file);
        if (!existsSync(path)) return undefined;
        try {
            const manifest = JSON.parse(readFileSync(path, "utf8")) as IManifest;
            return { manifest, sha256: sha256(canonicalJson(manifest)), file };
        } catch {
            return undefined;
        }
    }

    private _host(name: string): IResolvedHost {
        const host = this._hosts.get(name);
        if (!host) throw new DesignerError("unknown_host", `no host "${name}"; known: ${[...this._hosts.keys()].join(", ") || "none"}`);
        return host;
    }

    private _draft(id: string): IDraft {
        const draft = this._drafts.get(id);
        if (!draft) throw new DesignerError("unknown_draft", `no draft "${id}": drafts live in the designer's memory and are lost when it restarts`);
        draft.touched = Date.now();
        return draft;
    }

    private _evict(): void {
        while (this._drafts.size > this._maxDrafts) {
            const oldest = [...this._drafts.values()].sort((a, b) => a.touched - b.touched)[0]!;
            this._drafts.delete(oldest.id);
        }
    }

    private _view(draft: IDraft): IDraftView {
        const info = isObject(draft.spec.doc.info) ? draft.spec.doc.info : {};
        return {
            draftId: draft.id,
            host: draft.host.name,
            spec: {
                ...(typeof info.title === "string" ? { title: info.title } : {}),
                ...(typeof info.version === "string" ? { version: info.version } : {}),
                openapi: String(draft.spec.doc.openapi),
                sha256: draft.specSha,
            },
            operations: [...draft.spec.operations.values()].map((op) => ({
                key: op.key,
                method: op.method,
                path: op.path,
                ...(typeof op.operation.summary === "string" ? { summary: op.operation.summary } : {}),
                tags: Array.isArray(op.operation.tags) ? op.operation.tags.filter((t): t is string => typeof t === "string") : [],
                write: !READ_METHODS.has(op.method),
                deprecated: op.operation.deprecated === true,
                locations: locationsOf(draft.spec, op),
            })),
            binding: draft.binding,
        };
    }
}

/** The spec's first server, when the host allows its origin; else the host's first allowed target. */
function suggestBaseUrl(spec: Spec, allowedTargets: readonly string[]): string {
    const servers = Array.isArray(spec.doc.servers) ? spec.doc.servers : [];
    for (const server of servers) {
        if (!isObject(server) || typeof server.url !== "string") continue;
        try {
            const url = new URL(server.url);
            if (allowedTargets.includes(url.origin)) return url.href.replace(/\/$/, "");
        } catch {
            // a relative server URL says nothing about the origin
        }
    }
    return allowedTargets[0] ?? "https://example.invalid";
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

/** Writes beside, then renames: a host starting meanwhile reads the old file or the new one, never half of one. */
function atomicWrite(path: string, content: string): string {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return path;
}
