import type { McpToolResult } from "@cyanmycelium/mcp-core";
import { AccessUnavailableError, type IAccessContext, type IAccessDecision, type IAccessGuard } from "@cyanmycelium/mcp-uns";
import { HTTP_METHODS, MANIFEST_VERSION, type IManifest, type IManifestTool, type ManifestAuth } from "../manifest/manifest.types";
import { HttpCallError, HttpPool } from "./http";
import { compileProjection, type IProjection } from "./projection";
import { compileBody, compileParams, compileTemplate, templateArgs, type Args } from "./template";
import { compileValidator, type Validator } from "./validator";

/** Resolves a `secretRef` to its value, at load. `undefined` when there is no such secret. */
export type SecretResolver = (secretRef: string) => string | undefined;

export interface IEngineOptions {
    /** Where tools with an `authorization` ask. Required as soon as one tool has one. */
    readonly guard?: IAccessGuard;
    /** Required when the manifest's target has `auth`. */
    readonly secrets?: SecretResolver;
    /** Origins (`https://host:port`) the manifest may call. When given, any other `baseUrl` refuses the load. */
    readonly allowedTargets?: readonly string[];
    /** Shared between engines to share connections; one per engine otherwise. */
    readonly pool?: HttpPool;
}

/** Every problem found while loading a manifest, not only the first. */
export class ManifestLoadError extends Error {
    constructor(readonly problems: readonly string[]) {
        super(`the manifest cannot be loaded:\n- ${problems.join("\n- ")}`);
        this.name = "ManifestLoadError";
    }
}

/** Error codes a tool result can carry, in `{ "error": { "code" } }`. */
export type EngineErrorCode =
    | "unknown_tool"
    | "invalid_arguments"
    | "denied"
    | "authorization_unavailable"
    | "constraint_violation"
    | "upstream_error"
    | "upstream_timeout"
    | "response_too_large"
    | "redirect_refused"
    | "network_error"
    | "invalid_response";

/** What {@link ManifestEngine.plan} returns: the HTTP request a call would send. */
export interface IPlannedRequest {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    /** The resource path the broker would be asked about, namespace included. */
    readonly resourcePath?: string;
}

interface ICompiledTool {
    readonly tool: IManifestTool;
    readonly validate: Validator;
    readonly method: string;
    readonly path: (args: Args) => string;
    readonly query: (args: Args) => [string, string][];
    readonly headers: (args: Args) => [string, string][];
    readonly body: (args: Args) => unknown;
    readonly project: (value: unknown) => IProjection;
    readonly resourcePath?: (args: Args) => string;
    readonly timeoutMs: number;
}

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const errorResult = (code: EngineErrorCode, message: string, detail?: Record<string, unknown>): McpToolResult => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...(detail ? { detail } : {}) } }) }],
});

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Runs one manifest: turns each `tools/call` into one HTTP call, under the
 * broker's decision. Everything is prepared at load (validators, templates,
 * bodies, projections, credentials); a call only runs closures. No code is
 * generated from the manifest, ever.
 */
export class ManifestEngine {
    readonly manifest: IManifest;
    private readonly _tools = new Map<string, ICompiledTool>();
    private readonly _guard?: IAccessGuard;
    private readonly _pool: HttpPool;
    private readonly _ownsPool: boolean;
    private readonly _base: URL;
    private readonly _fixedHeaders: Readonly<Record<string, string>>;
    private readonly _authQuery?: [string, string];
    /** Qualifies native resource ids: `valves:/site/nord/valves/V-012`. A resource belongs to its domain, not to the slot. */
    private readonly _domain: string;

    constructor(manifest: IManifest, options: IEngineOptions = {}) {
        const problems: string[] = [];
        this.manifest = manifest;
        this._guard = options.guard;
        this._domain = manifest.declaration?.domain ?? manifest.slot;

        if (manifest.manifest !== MANIFEST_VERSION) problems.push(`unknown manifest version ${JSON.stringify(manifest.manifest)}; this engine runs version ${MANIFEST_VERSION}`);

        // The target: an http(s) origin, allowed, with its credentials resolved now.
        let base: URL | undefined;
        try {
            base = new URL(manifest.target.baseUrl);
            if (base.protocol !== "http:" && base.protocol !== "https:") problems.push(`target.baseUrl must be http or https: ${manifest.target.baseUrl}`);
            if (base.search || base.hash || base.username || base.password) problems.push("target.baseUrl must not carry a query, a fragment or credentials");
            if (options.allowedTargets && !options.allowedTargets.includes(base.origin)) problems.push(`target ${base.origin} is not in the allowed targets`);
        } catch {
            problems.push(`target.baseUrl is not a URL: ${manifest.target.baseUrl}`);
        }
        this._base = base ?? new URL("http://invalid.invalid");
        const auth = this._resolveAuth(manifest.target.auth, options.secrets, problems);
        this._fixedHeaders = { accept: "application/json", ...lowerKeys(manifest.target.headers ?? {}), ...auth.headers };
        this._authQuery = auth.query;

        // The declaration a tool's authorization relies on.
        const declaration = manifest.declaration;
        const capabilities = new Set(declaration?.capabilities ?? []);

        for (const tool of manifest.tools) {
            const at = `tool "${tool.name}"`;
            if (!TOOL_NAME.test(tool.name)) problems.push(`${at}: invalid name`);
            if (this._tools.has(tool.name)) problems.push(`${at}: duplicated`);
            if (!HTTP_METHODS.includes(tool.http.method)) problems.push(`${at}: unknown method ${tool.http.method}`);

            const properties = isPlainObject(tool.inputSchema.properties) ? Object.keys(tool.inputSchema.properties) : [];
            const known = new Set(properties);
            const reads = [
                ...templateArgs(tool.http.path),
                ...[...(tool.http.query ?? []), ...(tool.http.headers ?? []), ...(tool.http.body ?? [])].flatMap((v) => (v.arg !== undefined ? [v.arg] : [])),
                ...(tool.authorization ? templateArgs(tool.authorization.resourcePath) : []),
                ...(tool.authorization?.value !== undefined ? [tool.authorization.value] : []),
            ];
            for (const arg of reads) if (!known.has(arg)) problems.push(`${at}: reads argument "${arg}", absent from its inputSchema`);

            if (tool.authorization) {
                if (!declaration) problems.push(`${at}: has an authorization but the manifest has no declaration`);
                else if (!capabilities.has(tool.authorization.capability)) problems.push(`${at}: capability ${tool.authorization.capability} is not declared`);
                if (!this._guard) problems.push(`${at}: has an authorization but the engine has no guard`);
            }

            try {
                const auth = tool.authorization;
                const namespace = (declaration?.namespace ?? "").replace(/\/$/, "");
                const resource = auth ? compileTemplate(auth.resourcePath) : undefined;
                this._tools.set(tool.name, {
                    tool,
                    validate: compileValidator(tool.inputSchema),
                    method: tool.http.method,
                    path: compileTemplate(tool.http.path),
                    query: compileParams(tool.http.query),
                    headers: compileParams(tool.http.headers),
                    body: compileBody(tool.http.body),
                    project: compileProjection(tool.output),
                    ...(resource ? { resourcePath: (args: Args) => `${namespace}/${resource(args)}` } : {}),
                    timeoutMs: tool.timeoutMs ?? manifest.target.timeoutMs,
                });
            } catch (error) {
                problems.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (problems.length > 0) throw new ManifestLoadError(problems);
        this._pool = options.pool ?? new HttpPool();
        this._ownsPool = !options.pool;
    }

    /** The tools, as `tools/list` shows them. */
    get tools(): readonly IManifestTool[] {
        return this.manifest.tools;
    }

    /** Runs one `tools/call`. Never throws: every failure is a tool result with `isError`. */
    async callToolAsync(name: string, args: Args, context?: IAccessContext): Promise<McpToolResult> {
        const compiled = this._tools.get(name);
        if (!compiled) return errorResult("unknown_tool", `unknown tool: ${name}`);
        const { tool } = compiled;

        const invalid = compiled.validate(args);
        if (invalid) return errorResult("invalid_arguments", `argument ${invalid.path || "/"} fails "${invalid.keyword}"`, { path: invalid.path, keyword: invalid.keyword });

        // The broker decides before anything leaves the engine.
        let decision: IAccessDecision | undefined;
        if (tool.authorization && compiled.resourcePath) {
            const resourcePath = compiled.resourcePath(args);
            try {
                [decision] = await this._guard!.authorizeAsync([{ capability: tool.authorization.capability, resource: `${this._domain}:${resourcePath}`, resourcePath }], context);
            } catch (error) {
                if (error instanceof AccessUnavailableError) return errorResult("authorization_unavailable", error.message);
                throw error;
            }
            if (!decision?.allowed)
                return errorResult("denied", `denied by the broker: ${decision?.reason ?? "no decision"}`, decision?.decisionId ? { decisionId: decision.decisionId } : undefined);
            // Limits bound the value written. A read-only tool writes none, so they do not
            // apply to it; a tool that writes without naming its value is refused instead.
            // The method decides, not the readOnlyHint annotation, which MCP calls a hint.
            const readOnly = (compiled.method === "GET" || compiled.method === "HEAD") && tool.authorization.value === undefined;
            const violation = decision.constraints && !readOnly ? constraintViolation(decision.constraints, tool.authorization.value, args) : null;
            if (violation) {
                this._guard!.report(decision, "refused", "constraint_violation");
                return errorResult("constraint_violation", violation, decision.decisionId ? { decisionId: decision.decisionId } : undefined);
            }
        }
        const report = (outcome: "success" | "failure", errorCode?: string): void => {
            if (decision && tool.authorization?.resultRequired) this._guard!.report(decision, outcome, errorCode);
        };

        const request = this._request(compiled, args, context);
        if ("error" in request) return request.error;
        const { url, headers, body: bodyValue } = request;
        const body = bodyValue === undefined ? undefined : Buffer.from(JSON.stringify(bodyValue));

        let response;
        try {
            response = await this._pool.send({
                method: compiled.method,
                url,
                headers,
                ...(body ? { body } : {}),
                timeoutMs: compiled.timeoutMs,
                maxResponseBytes: this.manifest.target.maxResponseBytes,
            });
        } catch (error) {
            const e = error instanceof HttpCallError ? error : new HttpCallError("network", String(error));
            report("failure", e.code);
            const code: EngineErrorCode =
                e.code === "timeout" ? "upstream_timeout" : e.code === "too_large" ? "response_too_large" : e.code === "redirect" ? "redirect_refused" : "network_error";
            return errorResult(code, e.message);
        }

        if (response.status >= 400) {
            report("failure", `http_${response.status}`);
            return errorResult("upstream_error", `the API answered ${response.status}`, { status: response.status, ...problemDetails(response.contentType, response.body) });
        }

        let parsed: unknown = null;
        if (response.body.length > 0) {
            if (!/\bjson\b/i.test(response.contentType)) {
                report("failure", "invalid_response");
                return errorResult("invalid_response", `the API answered ${response.contentType || "an untyped body"}, not JSON`);
            }
            try {
                parsed = JSON.parse(response.body.toString("utf8"));
            } catch {
                report("failure", "invalid_response");
                return errorResult("invalid_response", "the API answered malformed JSON");
            }
        }

        const { value, truncated } = compiled.project(parsed);
        report("success");
        const text = JSON.stringify(value);
        const content: McpToolResult["content"] = [{ type: "text", text }];
        if (truncated.length > 0) content.push({ type: "text", text: `Truncated: ${truncated.map((t) => `${t.path} had ${t.total} items`).join(", ")}.` });
        return { content, structuredContent: isPlainObject(value) ? value : { value } };
    }

    /**
     * The request a call would send, built exactly as {@link callToolAsync}
     * builds it, without asking the broker and without sending it: what a dry
     * run shows. Credentials appear as the engine's secret resolver returned
     * them, so a designer resolves them to placeholders.
     */
    plan(name: string, args: Args): { readonly request: IPlannedRequest } | { readonly error: McpToolResult } {
        const compiled = this._tools.get(name);
        if (!compiled) return { error: errorResult("unknown_tool", `unknown tool: ${name}`) };
        const invalid = compiled.validate(args);
        if (invalid)
            return { error: errorResult("invalid_arguments", `argument ${invalid.path || "/"} fails "${invalid.keyword}"`, { path: invalid.path, keyword: invalid.keyword }) };
        const request = this._request(compiled, args);
        if ("error" in request) return request;
        return {
            request: {
                method: compiled.method,
                url: request.url.href,
                headers: request.headers,
                ...(request.body !== undefined ? { body: request.body } : {}),
                ...(compiled.resourcePath ? { resourcePath: compiled.resourcePath(args) } : {}),
            },
        };
    }

    /** Closes the connections this engine opened. */
    close(): void {
        if (this._ownsPool) this._pool.close();
    }

    /** The request of one call: every piece was prepared at load. */
    private _request(compiled: ICompiledTool, args: Args, context?: IAccessContext): { url: URL; headers: Record<string, string>; body?: unknown } | { error: McpToolResult } {
        const url = new URL(this._base.pathname.replace(/\/$/, "") + compiled.path(args), this._base);
        for (const [k, v] of compiled.query(args)) url.searchParams.append(k, v);
        if (this._authQuery) url.searchParams.set(this._authQuery[0], this._authQuery[1]);
        if (url.origin !== this._base.origin) return { error: errorResult("invalid_arguments", "the arguments would change the target origin") };

        const headers: Record<string, string> = { ...this._fixedHeaders };
        for (const [k, v] of compiled.headers(args)) headers[k.toLowerCase()] = v;
        const traceparent = context?.meta?.["traceparent"];
        if (typeof traceparent === "string" && TRACEPARENT.test(traceparent)) headers["traceparent"] = traceparent;
        const body = compiled.body(args);
        if (body !== undefined) headers["content-type"] = "application/json";
        return { url, headers, ...(body !== undefined ? { body } : {}) };
    }

    private _resolveAuth(auth: ManifestAuth | undefined, secrets: SecretResolver | undefined, problems: string[]): { headers: Record<string, string>; query?: [string, string] } {
        if (!auth) return { headers: {} };
        const secret = secrets?.(auth.secretRef);
        if (secret === undefined) {
            problems.push(`target.auth: no secret "${auth.secretRef}"`);
            return { headers: {} };
        }
        switch (auth.kind) {
            case "bearer":
                return { headers: { authorization: `Bearer ${secret}` } };
            case "basic":
                return { headers: { authorization: `Basic ${Buffer.from(secret).toString("base64")}` } };
            case "apiKey":
                return auth.in === "header" ? { headers: { [auth.name.toLowerCase()]: secret } } : { headers: {}, query: [auth.name, secret] };
        }
    }
}

const lowerKeys = (h: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** Applies a decision's engineering limits to the written value. `null` when they hold. */
function constraintViolation(constraints: object, valueArg: string | undefined, args: Args): string | null {
    const c = constraints as { minValue?: number; maxValue?: number; allowedValues?: readonly unknown[]; destinations?: readonly string[] };
    // `destinations` names provider-defined levels; an HTTP call has none to choose from.
    if (c.minValue === undefined && c.maxValue === undefined && c.allowedValues === undefined) return null;
    if (valueArg === undefined) return "the broker returned limits, but this tool names no value argument to apply them to";
    const value = args[valueArg];
    if (c.allowedValues && !c.allowedValues.some((x) => x === value)) return `${valueArg} must be one of ${JSON.stringify(c.allowedValues)}`;
    if (c.minValue !== undefined || c.maxValue !== undefined) {
        if (typeof value !== "number") return `${valueArg} must be a number to be checked against the limits`;
        if (c.minValue !== undefined && value < c.minValue) return `${valueArg} ${value} is below the minimum ${c.minValue}`;
        if (c.maxValue !== undefined && value > c.maxValue) return `${valueArg} ${value} is above the maximum ${c.maxValue}`;
    }
    return null;
}

/** `title` and `detail` of an RFC 9457 problem; nothing from any other error body, which may hold anything. */
function problemDetails(contentType: string, body: Buffer): Record<string, unknown> {
    if (!/application\/problem\+json/i.test(contentType)) return {};
    try {
        const p = JSON.parse(body.toString("utf8")) as { title?: unknown; detail?: unknown };
        return { ...(typeof p.title === "string" ? { title: p.title.slice(0, 200) } : {}), ...(typeof p.detail === "string" ? { detail: p.detail.slice(0, 500) } : {}) };
    } catch {
        return {};
    }
}
