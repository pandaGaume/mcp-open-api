// With the extension: Node's ESM resolver does not guess it, and ajv has no exports map.
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { openGuard } from "@cyanmycelium/mcp-uns";
import pkg from "../../package.json" with { type: "json" };
import { BINDING_SCHEMA, BINDING_SCHEMA_ID } from "../binding/binding.schema";
import type { BindingOutput, IBinding, IBindingArg, IBindingTool } from "../binding/binding.types";
import type {
    IManifest,
    IManifestDeclaredResource,
    IManifestLimits,
    IManifestTool,
    ManifestAuth,
    ManifestBodyAssignment,
    ManifestOutput,
    ManifestParam,
    TemplatePart,
} from "../manifest/manifest.types";
import { ManifestEngine, ManifestLoadError } from "../runtime/engine";
import { canonicalJson, sha256 } from "./canonical";
import { Diagnostics, type IDiagnostic, pointer, token } from "./diagnostics";
import { type IOperation, type Json, type JsonObject, Spec, isObject, normalizeSchema, parseSpec, re2Accepts } from "./spec";

/** Package and version stamped into every manifest, to recompile it identically. */
export const COMPILER_ID = `${pkg.name}@${pkg.version}`;

export interface ICompileInput {
    /** The binding: a parsed object, or its JSON text. */
    readonly binding: unknown;
    /** The spec's exact bytes (or text): their SHA-256 must match `binding.spec.sha256`. */
    readonly spec: string | Uint8Array;
}

export interface ICompileResult {
    /** Present when there is no error. */
    readonly manifest?: IManifest;
    /** The manifest in canonical JSON (RFC 8785): what is hashed, signed and approved. */
    readonly canonical?: string;
    /** SHA-256 of `canonical`: the manifest's identity. */
    readonly sha256?: string;
    /** Every error and warning, not only the first. */
    readonly diagnostics: readonly IDiagnostic[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(BINDING_SCHEMA);
const validateBinding = ajv.getSchema(BINDING_SCHEMA_ID)!;

const READ_METHODS = new Set(["GET", "HEAD"]);
const SKIPPED_HEADERS = new Set(["authorization", "cookie", "content-type", "accept", "content-length", "host"]);
const RESTRICTIONS = ["pattern", "enum", "minimum", "maximum", "maxLength", "maxItems"] as const;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * Compiles a binding and its spec into a manifest. A pure function: no
 * network, no clock, no randomness. The same inputs and the same compiler
 * version give the same manifest, byte for byte.
 */
export function compile(input: ICompileInput): ICompileResult {
    const diag = new Diagnostics();
    const bindingDoc = typeof input.binding === "string" ? safeJson(input.binding, diag) : input.binding;
    if (bindingDoc === undefined) return { diagnostics: diag.list };

    if (!validateBinding(bindingDoc)) {
        for (const e of validateBinding.errors ?? []) diag.error("binding.schema", describeAjvError(e), { binding: e.instancePath });
        return { diagnostics: diag.list };
    }
    const binding = bindingDoc as IBinding;

    const specBytes = typeof input.spec === "string" ? Buffer.from(input.spec, "utf8") : input.spec;
    const actual = sha256(specBytes);
    if (actual !== binding.spec.sha256) {
        diag.error("spec.sha256-mismatch", `the spec's SHA-256 is ${actual}, the binding expects ${binding.spec.sha256}: the spec changed since the binding was written`, {
            binding: "/spec/sha256",
        });
        return { diagnostics: diag.list };
    }
    let specDoc: unknown;
    try {
        specDoc = parseSpec(Buffer.from(specBytes).toString("utf8"));
    } catch (error) {
        diag.error("spec.parse", `the spec is neither JSON nor YAML: ${error instanceof Error ? error.message : String(error)}`);
        return { diagnostics: diag.list };
    }
    const spec = Spec.load(specDoc, diag);
    if (!spec) return { diagnostics: diag.list };

    if (binding.arazzo) diag.error("arazzo.unsupported", "workflows (Arazzo) are reserved in binding-1 but not compiled yet", { binding: "/arazzo" });
    for (const key of Object.keys(binding.resources ?? {})) {
        diag.error("resources.unsupported", "resources are part of binding-1 but the engine does not serve them yet", { binding: pointer("resources", key) });
    }
    if (binding.governance && !binding.governance.namespace.startsWith("/")) {
        diag.error("governance.namespace", `the namespace must be an absolute broker resource path, like "/site/nord", not "${binding.governance.namespace}"`, {
            binding: "/governance/namespace",
        });
    }

    const target = compileTarget(binding, spec, diag);
    const tools: IManifestTool[] = [];
    const declared = new DeclarationBuilder(binding, diag);
    for (const [key, entry] of Object.entries(binding.tools ?? {})) {
        const at = pointer("tools", key);
        if (entry.from === "workflow") {
            diag.error("tool.workflow-unsupported", "workflow tools (Arazzo) are reserved but not compiled yet", { binding: at });
            continue;
        }
        const op = spec.operations.get(key);
        if (!op) {
            diag.error("tool.unknown-operation", `no operation "${key}" in the spec; known: ${[...spec.operations.keys()].slice(0, 20).join(", ")}`, { binding: at });
            continue;
        }
        const tool = compileTool(op, entry, at, binding, spec, diag, declared);
        if (tool) tools.push(tool);
    }

    // Tool names: valid, unique, short enough once `_all` prefixes them.
    const names = new Map<string, number>();
    for (const tool of tools) names.set(tool.name, (names.get(tool.name) ?? 0) + 1);
    for (const [name, count] of names) if (count > 1) diag.error("tool.duplicate-name", `${count} tools are named "${name}"`, { binding: "/tools" });
    for (const tool of tools) {
        if (`${binding.slot}-${tool.name}`.length > 64) diag.warning("tool.aggregate-length", `"${binding.slot}-${tool.name}" exceeds 64 characters: _all will truncate it`);
    }
    if (tools.length > 40) diag.warning("tool.count", `${tools.length} tools: past 40, every tool costs the agent on every turn`);

    if (diag.hasErrors || !target) return { diagnostics: diag.list };

    const manifest: IManifest = {
        manifest: 1,
        slot: binding.slot,
        ...(binding.title ? { title: binding.title } : {}),
        ...(binding.instructions ? { instructions: binding.instructions } : {}),
        compiler: COMPILER_ID,
        provenance: { binding: sha256(canonicalJson(binding)), spec: binding.spec.sha256 },
        target,
        ...(binding.governance ? { declaration: declared.build() } : {}),
        tools: tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };

    // The engine is the judge: a manifest it would refuse is never produced.
    try {
        new ManifestEngine(manifest, { guard: openGuard(), secrets: () => "secret" }).close();
    } catch (error) {
        if (!(error instanceof ManifestLoadError)) throw error;
        for (const problem of error.problems) diag.error("manifest.engine-refused", problem);
        return { diagnostics: diag.list };
    }
    const canonical = canonicalJson(manifest);
    return { manifest: JSON.parse(canonical) as IManifest, canonical, sha256: sha256(canonical), diagnostics: diag.list };
}

// ── Target ──────────────────────────────────────────────────────────────────

function compileTarget(binding: IBinding, spec: Spec, diag: Diagnostics): IManifest["target"] | undefined {
    const t = binding.target;
    let auth: ManifestAuth | undefined;
    if (t.auth) {
        const components = isObject(spec.doc.components) ? spec.doc.components : {};
        const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
        const names = Object.keys(schemes);
        const name = t.auth.scheme ?? (names.length === 1 ? names[0] : undefined);
        const scheme = name ? spec.deref(schemes[name], pointer("components", "securitySchemes", name), diag) : undefined;
        if (!name || !isObject(scheme)) {
            diag.error(
                "target.auth-scheme",
                names.length === 0 ? "the spec declares no securityScheme" : `name the securityScheme to use with target.auth.scheme: ${names.join(", ")}`,
                {
                    binding: "/target/auth",
                }
            );
            return undefined;
        }
        const kind = `${String(scheme.type)}${typeof scheme.scheme === "string" ? `:${scheme.scheme.toLowerCase()}` : ""}`;
        if (kind === "http:bearer") auth = { kind: "bearer", secretRef: t.auth.secretRef };
        else if (kind === "http:basic") auth = { kind: "basic", secretRef: t.auth.secretRef };
        else if (scheme.type === "apiKey" && (scheme.in === "header" || scheme.in === "query") && typeof scheme.name === "string")
            auth = { kind: "apiKey", secretRef: t.auth.secretRef, in: scheme.in, name: scheme.name };
        else {
            diag.error(
                "target.auth-unsupported",
                `securityScheme "${name}" (${kind}${scheme.in ? ` in ${String(scheme.in)}` : ""}) is not supported yet: bearer, basic, apiKey in header or query are`,
                {
                    binding: "/target/auth",
                    spec: pointer("components", "securitySchemes", name),
                }
            );
            return undefined;
        }
    }
    return {
        baseUrl: t.baseUrl,
        ...(auth ? { auth } : {}),
        ...(t.headers ? { headers: t.headers } : {}),
        timeoutMs: t.timeoutMs ?? 10000,
        maxResponseBytes: t.maxResponseBytes ?? 1048576,
    };
}

// ── Arguments ───────────────────────────────────────────────────────────────

interface ILocation {
    /** `path.id`, `query.limit`, `header.X-Site`, `body`, `body.position`. */
    readonly loc: string;
    readonly in: "path" | "query" | "header" | "body";
    /** The HTTP name: parameter or body property; `""` for the whole body. */
    readonly name: string;
    readonly schema: Json;
    readonly required: boolean;
    readonly description?: string;
    readonly specAt: string;
}

/** What became of one location after the binding: exposed under an MCP name, fixed to a value, or left out. */
type Resolved = { readonly kind: "arg"; readonly name: string } | { readonly kind: "fixed"; readonly value: unknown } | { readonly kind: "omitted" };

function collectLocations(op: IOperation, spec: Spec, diag: Diagnostics, bindingAt: string): ILocation[] {
    const ctx = { spec, diag, mode: "request" as const, binding: bindingAt };
    const out: ILocation[] = [];
    const params = new Map<string, { param: JsonObject; at: string }>();
    const gather = (list: Json | undefined, base: string): void => {
        if (!Array.isArray(list)) return;
        list.forEach((raw, i) => {
            const at = `${base}/parameters/${i}`;
            const param = spec.deref(raw, at, diag);
            if (isObject(param) && typeof param.name === "string" && typeof param.in === "string") params.set(`${param.in}:${param.name}`, { param, at });
        });
    };
    gather(op.pathItem.parameters, pointer("paths", op.path));
    gather(op.operation.parameters, op.at);

    for (const { param, at } of params.values()) {
        const where = param.in as string;
        const name = param.name as string;
        const required = where === "path" || param.required === true;
        if (where === "cookie") {
            if (required) diag.error("param.cookie-unsupported", `required cookie parameter "${name}" is not supported`, { spec: at, binding: bindingAt });
            else diag.warning("param.cookie-skipped", `cookie parameter "${name}" is left out`, { spec: at });
            continue;
        }
        if (where === "header" && SKIPPED_HEADERS.has(name.toLowerCase())) continue;
        if (param.content !== undefined) {
            diag.error("param.content-unsupported", `parameter "${name}" is described by content, not schema: not supported yet`, { spec: at, binding: bindingAt });
            continue;
        }
        const defaultStyle = where === "query" ? "form" : "simple";
        const style = typeof param.style === "string" ? param.style : defaultStyle;
        const explode = typeof param.explode === "boolean" ? param.explode : style === "form";
        const schema = normalizeSchema(param.schema ?? true, `${at}/schema`, ctx);
        const isObjectSchema = isObject(schema) && (schema.type === "object" || isObject(schema.properties));
        if (style !== defaultStyle || (where === "query" && !explode) || isObjectSchema) {
            diag.error(
                "param.style-unsupported",
                `parameter "${name}" (${where}, style ${style}${explode ? ", exploded" : ""}${isObjectSchema ? ", object" : ""}) is not supported yet`,
                {
                    spec: at,
                    binding: bindingAt,
                }
            );
            continue;
        }
        out.push({
            loc: `${where}.${name}`,
            in: where as ILocation["in"],
            name,
            schema,
            required,
            ...(typeof param.description === "string" ? { description: param.description } : {}),
            specAt: at,
        });
    }

    if (op.operation.requestBody !== undefined) {
        const at = `${op.at}/requestBody`;
        const body = spec.deref(op.operation.requestBody, at, diag);
        if (isObject(body)) {
            const content = isObject(body.content) ? body.content : {};
            const type = Object.keys(content).find((t) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(t));
            if (!type) {
                if (body.required === true)
                    diag.error("body.unsupported", `the request body is ${Object.keys(content).join(", ") || "untyped"}: only JSON is supported`, { spec: at, binding: bindingAt });
                else diag.warning("body.skipped", "the optional non-JSON request body is left out", { spec: at });
            } else {
                const media = content[type];
                const bodyAt = `${at}/content/${token(type)}/schema`;
                const schema = normalizeSchema(isObject(media) ? (media.schema ?? true) : true, bodyAt, ctx);
                const bodyRequired = body.required === true;
                if (isObject(schema) && isObject(schema.properties) && (schema.type === undefined || schema.type === "object") && !schema.allOf && !schema.anyOf && !schema.oneOf) {
                    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
                    for (const [prop, sub] of Object.entries(schema.properties)) {
                        out.push({
                            loc: `body.${prop}`,
                            in: "body",
                            name: prop,
                            schema: sub,
                            required: bodyRequired && req.has(prop),
                            ...(isObject(sub) && typeof sub.description === "string" ? { description: sub.description } : {}),
                            specAt: `${bodyAt}/properties/${token(prop)}`,
                        });
                    }
                } else {
                    out.push({ loc: "body", in: "body", name: "", schema, required: bodyRequired, specAt: bodyAt });
                }
            }
        }
    }
    return out;
}

/** Validates a value against a spec schema; the compiler runs at design time, so Ajv is fine here. */
function conforms(schema: Json, value: unknown): string | null {
    try {
        const validate = ajv.compile(schema as object);
        return validate(value) ? null : (validate.errors ?? []).map(describeAjvError).join("; ");
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Top-level numeric bounds and enum of a schema, through `allOf`. */
function bounds(schema: Json): { min?: number; max?: number; enums: unknown[][]; types: Set<string> } {
    const out: { min?: number; max?: number; enums: unknown[][]; types: Set<string> } = { enums: [], types: new Set() };
    const walk = (s: Json): void => {
        if (!isObject(s)) return;
        if (typeof s.minimum === "number") out.min = out.min === undefined ? s.minimum : Math.max(out.min, s.minimum);
        if (typeof s.maximum === "number") out.max = out.max === undefined ? s.maximum : Math.min(out.max, s.maximum);
        if (Array.isArray(s.enum)) out.enums.push(s.enum);
        for (const t of ([] as Json[]).concat(s.type ?? [])) if (typeof t === "string") out.types.add(t);
        if (Array.isArray(s.allOf)) s.allOf.forEach(walk);
    };
    walk(schema);
    return out;
}

// ── Tools ───────────────────────────────────────────────────────────────────

function compileTool(op: IOperation, entry: IBindingTool, at: string, binding: IBinding, spec: Spec, diag: Diagnostics, declared: DeclarationBuilder): IManifestTool | undefined {
    const errorsBefore = diag.errorCount;
    const locations = collectLocations(op, spec, diag, at);
    const byLoc = new Map(locations.map((l) => [l.loc, l]));
    const args = entry.args ?? {};

    // Bindings on locations that do not exist; nested body values may only be fixed.
    const nested: { pointer: string; parent: string; key: string; value: unknown; at: string }[] = [];
    for (const [loc, arg] of Object.entries(args)) {
        if (byLoc.has(loc)) continue;
        const argAt = `${at}/args/${token(loc)}`;
        const parts = loc.split(".");
        if (parts[0] === "body" && parts.length >= 3 && byLoc.has(`body.${parts[1]}`)) {
            if (arg.fixed === undefined) diag.error("args.nested-not-fixed", `"${loc}" is inside a body property: it can only be fixed`, { binding: argAt });
            else nested.push({ pointer: `/${parts.slice(1).map(token).join("/")}`, parent: `body.${parts[1]}`, key: parts.slice(2).join("."), value: arg.fixed, at: argAt });
            continue;
        }
        diag.error("args.unknown-location", `"${loc}" is not a parameter or body property of ${op.method} ${op.path}; known: ${[...byLoc.keys()].join(", ") || "none"}`, {
            binding: argAt,
        });
    }

    // Each location: exposed, fixed, or left out.
    const resolved = new Map<string, Resolved>();
    const properties: Record<string, Json> = {};
    const required: string[] = [];
    for (const l of locations) {
        const arg: IBindingArg = args[l.loc] ?? {};
        const argAt = `${at}/args/${token(l.loc)}`;
        if (arg.fixed !== undefined || arg.hide === true) {
            let value = arg.fixed;
            if (value !== undefined) {
                const problem = conforms(l.schema, value);
                if (problem) diag.error("args.fixed-invalid", `the fixed value of "${l.loc}" does not satisfy the spec: ${problem}`, { binding: argAt, spec: l.specAt });
            } else if (l.required) {
                if (isObject(l.schema) && "default" in l.schema) value = l.schema.default;
                else
                    diag.error("args.required-hidden", `"${l.loc}" is required by the spec and hidden without a fixed value or a spec default`, { binding: argAt, spec: l.specAt });
            }
            resolved.set(l.loc, value === undefined ? { kind: "omitted" } : { kind: "fixed", value });
            continue;
        }
        const name = arg.name ?? (l.loc === "body" ? "body" : l.name);
        if (!name) {
            diag.error("args.no-name", `"${l.loc}" needs a name`, { binding: argAt });
            continue;
        }
        if (Object.hasOwn(properties, name)) {
            diag.error("args.name-collision", `two arguments would be named "${name}": rename one in args`, { binding: argAt, spec: l.specAt });
            continue;
        }
        if (!SAFE_NAME.test(name)) diag.warning("args.name-unusual", `argument name "${name}" is not a plain identifier; rename it for agents`, { binding: argAt });

        // Restrictions are composed with the spec's schema: they can only narrow it.
        const restriction: JsonObject = {};
        for (const key of RESTRICTIONS) if (arg[key] !== undefined) restriction[key] = arg[key] as Json;
        if (typeof restriction.pattern === "string" && !re2Accepts(restriction.pattern))
            diag.error("args.pattern-not-re2", `pattern "${restriction.pattern}" is not accepted by RE2`, { binding: `${argAt}/pattern` });
        if (Array.isArray(restriction.enum)) {
            for (const value of restriction.enum) {
                const problem = conforms(l.schema, value);
                if (problem)
                    diag.error("args.enum-invalid", `enum value ${JSON.stringify(value)} does not satisfy the spec: ${problem}`, { binding: `${argAt}/enum`, spec: l.specAt });
            }
        }
        let schema: Json = Object.keys(restriction).length > 0 ? { allOf: [l.schema, restriction] } : l.schema;
        const b = bounds(schema);
        if (b.min !== undefined && b.max !== undefined && b.min > b.max)
            diag.error("args.contradiction", `"${l.loc}": minimum ${b.min} is above maximum ${b.max}, no value is possible`, { binding: argAt, spec: l.specAt });
        const description = arg.description ?? l.description;
        if (description !== undefined) schema = isObject(schema) && !Array.isArray(schema.allOf) ? { ...schema, description } : { description, allOf: [schema] };
        properties[name] = schema;
        if (l.required) required.push(name);
        resolved.set(l.loc, { kind: "arg", name });
    }

    // A nested fixed value leaves the schema of the property it sits in.
    for (const n of nested) {
        const parent = resolved.get(n.parent);
        if (parent?.kind === "arg" && !n.key.includes(".")) {
            const s = properties[parent.name];
            if (isObject(s) && isObject(s.properties) && n.key in s.properties) {
                const props = { ...s.properties };
                delete props[n.key];
                properties[parent.name] = { ...s, properties: props, ...(Array.isArray(s.required) ? { required: s.required.filter((r) => r !== n.key) } : {}) };
            }
        }
    }

    const value = (loc: string): TemplatePart | undefined => {
        const r = resolved.get(loc);
        if (r?.kind === "arg") return { arg: r.name };
        if (r?.kind === "fixed") return encodeURIComponent(String(r.value));
        return undefined;
    };
    const param = (l: ILocation): ManifestParam | undefined => {
        const r = resolved.get(l.loc);
        if (r?.kind === "arg") return { name: l.name, arg: r.name };
        if (r?.kind === "fixed") return { name: l.name, value: r.value };
        return undefined;
    };

    // The HTTP plan.
    const path: TemplatePart[] = [];
    for (const piece of op.path.split(/(\{[^}]+\})/)) {
        if (!piece) continue;
        const m = /^\{(.+)\}$/.exec(piece);
        if (!m) {
            path.push(piece);
            continue;
        }
        const part = value(`path.${m[1]}`);
        if (part === undefined) diag.error("spec.path-param-missing", `path parameter "${m[1]}" of ${op.path} is not declared in the spec`, { spec: op.at, binding: at });
        else path.push(part);
    }
    const query = locations.filter((l) => l.in === "query").flatMap((l) => param(l) ?? []);
    const headers = locations.filter((l) => l.in === "header").flatMap((l) => param(l) ?? []);
    const bodyLocs = locations.filter((l) => l.in === "body");
    let body: ManifestBodyAssignment[] | undefined;
    if (bodyLocs.length > 0) {
        body = [];
        for (const l of bodyLocs) {
            const r = resolved.get(l.loc);
            const ptr = l.loc === "body" ? "" : `/${token(l.name)}`;
            if (r?.kind === "arg") body.push({ pointer: ptr, arg: r.name });
            else if (r?.kind === "fixed") body.push({ pointer: ptr, value: r.value });
        }
        for (const n of nested) body.push({ pointer: n.pointer, value: n.value });
    }

    const output = compileOutput(op, entry.output, at, spec, diag);
    const annotations = { ...defaultAnnotations(op.method), ...(entry.annotations ?? {}) };
    if ((op.method === "POST" || op.method === "PATCH") && !entry.annotations)
        diag.warning("annotations.missing", `${op.method} has no default annotations: say whether it is idempotent or destructive`, { binding: at });

    const description =
        entry.description ??
        [op.operation.summary, op.operation.description]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n\n")
            .slice(0, 2000);
    if (!description) diag.warning("description.missing", "the tool has no description: agents choose tools by it", { binding: at });
    else if (!entry.description) diag.warning("description.from-spec", "the description is the spec's, unreviewed: rewrite it for an agent", { binding: at });

    // Authorization.
    let authorization: IManifestTool["authorization"];
    const auth = entry.authorization;
    if (!auth && !READ_METHODS.has(op.method)) diag.error("authorization.required", `${op.method} changes state: it needs an authorization`, { binding: at });
    if (auth) {
        const authAt = `${at}/authorization`;
        const domain = binding.governance?.domain;
        if (!domain) diag.error("governance.missing", "a tool has an authorization: the binding needs governance", { binding: authAt });
        else if (!auth.capability.startsWith(`${domain}.`))
            diag.error("authorization.capability-domain", `capability "${auth.capability}" is outside the domain "${domain}"`, { binding: `${authAt}/capability` });
        const resourcePath: TemplatePart[] = [];
        for (const piece of auth.resourcePath.split(/(\{[^}]+\})/)) {
            if (!piece) continue;
            const m = /^\{(.+)\}$/.exec(piece);
            if (!m) resourcePath.push(piece);
            else {
                const part = value(m[1]!);
                if (part === undefined) diag.error("authorization.unknown-location", `"{${m[1]}}" names no exposed or fixed argument`, { binding: `${authAt}/resourcePath` });
                else resourcePath.push(part);
            }
        }
        let valueArg: string | undefined;
        if (auth.value !== undefined) {
            const r = resolved.get(auth.value);
            if (r?.kind !== "arg") diag.error("authorization.value-location", `value "${auth.value}" names no exposed argument`, { binding: `${authAt}/value` });
            else {
                valueArg = r.name;
                const b = bounds(properties[r.name]!);
                const numeric = b.enums.length > 0 || [...b.types].some((t) => t === "number" || t === "integer");
                if (!numeric)
                    diag.error("authorization.value-type", `value "${auth.value}" is neither a number nor an enum: limits cannot apply to it`, { binding: `${authAt}/value` });
                else declared.addLimits(resourcePath, limitsOf(b), `${authAt}/value`);
            }
        }
        if (domain) declared.addCapability(auth.capability, auth.resultRequired === true);
        authorization = {
            capability: auth.capability,
            resourcePath: mergeLiterals(resourcePath),
            ...(valueArg ? { value: valueArg } : {}),
            ...(auth.resultRequired ? { resultRequired: true } : {}),
        };
    }

    if (diag.errorCount > errorsBefore) return undefined;
    const name = entry.name ?? snake(op.key);
    if (!TOOL_NAME.test(name)) diag.error("tool.invalid-name", `"${name}" is not a valid tool name (^[a-z][a-z0-9_]{0,47}$): set name in the binding`, { binding: at });
    return {
        name,
        ...((entry.title ?? op.operation.summary) ? { title: (entry.title ?? op.operation.summary) as string } : {}),
        ...(description ? { description } : {}),
        inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) },
        ...(output.schema ? { outputSchema: output.schema } : {}),
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        http: {
            method: op.method as IManifestTool["http"]["method"],
            path: mergeLiterals(path),
            ...(query.length > 0 ? { query } : {}),
            ...(headers.length > 0 ? { headers } : {}),
            ...(body ? { body } : {}),
        },
        output: output.output,
        ...(authorization ? { authorization } : {}),
        ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
    };
}

function defaultAnnotations(method: string): IManifestTool["annotations"] {
    if (method === "GET" || method === "HEAD") return { readOnlyHint: true };
    if (method === "PUT") return { idempotentHint: true };
    if (method === "DELETE") return { destructiveHint: true, idempotentHint: true };
    return {};
}

function limitsOf(b: ReturnType<typeof bounds>): IManifestLimits {
    let allowed: unknown[] | undefined;
    for (const list of b.enums) allowed = allowed ? allowed.filter((v) => list.includes(v)) : [...list];
    return {
        ...(b.min !== undefined ? { minValue: b.min } : {}),
        ...(b.max !== undefined ? { maxValue: b.max } : {}),
        ...(allowed ? { allowedValues: allowed.filter((v): v is string | number | boolean | null => v === null || ["string", "number", "boolean"].includes(typeof v)) } : {}),
    };
}

const mergeLiterals = (parts: TemplatePart[]): TemplatePart[] =>
    parts.reduce<TemplatePart[]>((acc, p) => {
        const last = acc[acc.length - 1];
        if (typeof p === "string" && typeof last === "string") acc[acc.length - 1] = last + p;
        else acc.push(p);
        return acc;
    }, []);

/** `getValveById` and `GET /valves/{id}` into `get_valve_by_id` and `get_valves_id`. */
export function snake(key: string): string {
    const s = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase()
        .slice(0, 48)
        .replace(/_+$/, "");
    return /^[a-z]/.test(s) ? s : `op_${s}`.slice(0, 48);
}

// ── Output ──────────────────────────────────────────────────────────────────

function compileOutput(op: IOperation, output: BindingOutput, at: string, spec: Spec, diag: Diagnostics): { output: ManifestOutput; schema?: JsonObject } {
    const responses = isObject(op.operation.responses) ? op.operation.responses : {};
    const codes = Object.keys(responses)
        .filter((c) => /^2(\d\d|XX)$/i.test(c))
        .sort();
    let schema: Json | undefined;
    for (const code of codes) {
        const resAt = `${op.at}/responses/${code}`;
        const res = spec.deref(responses[code], resAt, diag);
        const content = isObject(res) && isObject(res.content) ? res.content : {};
        const type = Object.keys(content).find((t) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(t));
        if (!type) continue;
        const media = content[type];
        schema = normalizeSchema(isObject(media) ? (media.schema ?? true) : true, `${resAt}/content/${token(type)}/schema`, { spec, diag, mode: "response" });
        break;
    }
    const wrap = (s: Json): JsonObject => (isObject(s) && (s.type === "object" || isObject(s.properties)) ? s : { type: "object", properties: { value: s } });

    if (output === "all") return { output: "all", ...(schema !== undefined ? { schema: wrap(schema) } : {}) };
    if (schema === undefined) {
        diag.error("output.no-schema", 'no 2xx JSON response schema: pick cannot be checked, use output "all"', { binding: `${at}/output` });
        return { output };
    }
    const rootArray = isObject(schema) && schema.type === "array";
    const root = rootArray ? (schema as JsonObject).items : schema;
    const projected: JsonObject = { type: "object", properties: {} };
    for (const path of output.pick) {
        let src: Json | undefined = root;
        let dst = projected;
        const segments = path.split(".");
        for (let i = 0; i < segments.length; i++) {
            const each = segments[i]!.endsWith("[]");
            const key = each ? segments[i]!.slice(0, -2) : segments[i]!;
            const child = propertyOf(src, key);
            if (child === undefined) {
                diag.error("output.pick-unknown", `"${path}": the response has no "${key}" here`, { binding: `${at}/output/pick` });
                break;
            }
            const last = i === segments.length - 1;
            const props = dst.properties as JsonObject;
            if (each) {
                const items = itemsOf(child);
                if (items === undefined) {
                    diag.error("output.pick-not-array", `"${path}": "${key}" is not an array`, { binding: `${at}/output/pick` });
                    break;
                }
                if (last) props[key] = child;
                else {
                    const existing = props[key];
                    const inner: JsonObject = isObject(existing) && isObject(existing.items) ? existing.items : { type: "object", properties: {} };
                    props[key] = { type: "array", items: inner };
                    dst = inner;
                    src = items;
                }
            } else if (last) props[key] = child;
            else {
                const existing = props[key];
                const inner: JsonObject = isObject(existing) && isObject(existing.properties) ? existing : { type: "object", properties: {} };
                props[key] = inner;
                dst = inner;
                src = child;
            }
        }
    }
    const result: ManifestOutput = { pick: output.pick, ...(output.maxItems ? { maxItems: output.maxItems } : {}) };
    return { output: result, schema: rootArray ? { type: "object", properties: { value: { type: "array", items: projected } } } : projected };
}

function propertyOf(schema: Json | undefined, key: string): Json | undefined {
    if (!isObject(schema)) return undefined;
    if (isObject(schema.properties) && key in schema.properties) return schema.properties[key];
    for (const group of ["allOf", "anyOf", "oneOf"] as const) {
        const list = schema[group];
        if (Array.isArray(list))
            for (const s of list) {
                const found = propertyOf(s, key);
                if (found !== undefined) return found;
            }
    }
    return undefined;
}

function itemsOf(schema: Json): Json | undefined {
    if (!isObject(schema)) return undefined;
    if (schema.items !== undefined) return schema.items;
    if (Array.isArray(schema.allOf))
        for (const s of schema.allOf) {
            const found = itemsOf(s);
            if (found !== undefined) return found;
        }
    return undefined;
}

// ── Declaration ─────────────────────────────────────────────────────────────

class DeclarationBuilder {
    private readonly _capabilities = new Set<string>();
    private readonly _results = new Set<string>();
    private readonly _resources = new Map<string, { entry: IManifestDeclaredResource; limits: string; at: string }>();

    constructor(
        private readonly _binding: IBinding,
        private readonly _diag: Diagnostics
    ) {}

    addCapability(capability: string, resultRequired: boolean): void {
        this._capabilities.add(capability);
        if (resultRequired) this._results.add(capability);
    }

    /** Limits on the resources a tool writes: a concrete entry, or a pattern when the path has arguments. */
    addLimits(resourcePath: readonly TemplatePart[], limits: IManifestLimits, at: string): void {
        if (Object.keys(limits).length === 0) return;
        const domain = this._binding.governance?.domain;
        const namespace = this._binding.governance?.namespace.replace(/\/$/, "");
        if (!domain || !namespace) return;
        let entry: IManifestDeclaredResource;
        if (resourcePath.every((p) => typeof p === "string")) {
            const path = (resourcePath as string[]).join("");
            entry = { resource: `${domain}:${namespace}/${path}`, resourcePath: path, limits };
        } else {
            let i = 0;
            const rendered = resourcePath.map((p) => (typeof p === "string" ? p : `{${SAFE_NAME.test(p.arg) ? p.arg : `p${i++}`}}`)).join("");
            const wholeSegments = rendered.split("/").every((seg) => !seg.includes("{") || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(seg));
            if (!wholeSegments) {
                this._diag.warning(
                    "authorization.limits-not-declarable",
                    `"${rendered}": an argument is part of a path segment, so its limits cannot be declared as a pattern; the input schema still applies`,
                    {
                        binding: at,
                    }
                );
                return;
            }
            entry = { resourcePattern: rendered, limits };
        }
        const key = "resourcePattern" in entry ? `pattern:${entry.resourcePattern}` : `path:${entry.resourcePath}`;
        const signature = canonicalJson(limits);
        const existing = this._resources.get(key);
        if (existing && existing.limits !== signature) {
            this._diag.error("authorization.limits-conflict", `two tools declare different limits on "${key.split(":")[1]}": the broker would intersect them for both`, {
                binding: at,
            });
            return;
        }
        this._resources.set(key, { entry, limits: signature, at });
    }

    build(): NonNullable<IManifest["declaration"]> {
        const g = this._binding.governance!;
        const resources = [...this._resources.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r.entry);
        return {
            domain: g.domain,
            namespace: g.namespace,
            capabilities: [...this._capabilities].sort(),
            ...(resources.length > 0 ? { resources } : {}),
            ...(this._results.size > 0 ? { resultsRequired: [...this._results].sort() } : {}),
        };
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeJson(text: string, diag: Diagnostics): unknown {
    try {
        return JSON.parse(text);
    } catch (error) {
        diag.error("binding.parse", `the binding is not JSON: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

function describeAjvError(e: ErrorObject): string {
    const where = e.instancePath || "/";
    if (e.keyword === "additionalProperties") return `${where}: unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    return `${where}: ${e.message ?? e.keyword}`;
}
