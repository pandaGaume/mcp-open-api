import { parse as parseYaml } from "yaml";
import { RE2JS } from "re2js";
import { type Diagnostics, pointer, token } from "./diagnostics";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const isObject = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);

/** Reads a spec, JSON or YAML. */
export function parseSpec(text: string): unknown {
    const trimmed = text.trimStart();
    return trimmed.startsWith("{") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
}

export type OpenApiVersion = "3.0" | "3.1";

export const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

export interface IOperation {
    /** `operationId`, or `"<METHOD> <path>"`. */
    readonly key: string;
    readonly method: string;
    readonly path: string;
    readonly operation: JsonObject;
    readonly pathItem: JsonObject;
    /** JSON Pointer of the operation in the spec. */
    readonly at: string;
}

/** The spec, checked and indexed. */
export class Spec {
    readonly operations = new Map<string, IOperation>();

    private constructor(
        readonly doc: JsonObject,
        readonly version: OpenApiVersion
    ) {}

    static load(doc: unknown, diag: Diagnostics): Spec | undefined {
        if (!isObject(doc) || typeof doc.openapi !== "string") {
            diag.error("spec.not-openapi", "the spec is not an OpenAPI document (no `openapi` field)", { spec: "" });
            return undefined;
        }
        const version: OpenApiVersion | undefined = doc.openapi.startsWith("3.0") ? "3.0" : doc.openapi.startsWith("3.1") ? "3.1" : undefined;
        if (!version) {
            diag.error("spec.version", `OpenAPI ${doc.openapi} is not supported; 3.0 and 3.1 are`, { spec: "/openapi" });
            return undefined;
        }
        const spec = new Spec(doc, version);
        const paths = isObject(doc.paths) ? doc.paths : {};
        for (const [path, raw] of Object.entries(paths)) {
            const pathItem = spec.deref(raw, pointer("paths", path), diag);
            if (!isObject(pathItem)) continue;
            for (const method of HTTP_METHODS) {
                const operation = pathItem[method];
                if (!isObject(operation)) continue;
                const at = pointer("paths", path, method);
                const key = typeof operation.operationId === "string" ? operation.operationId : `${method.toUpperCase()} ${path}`;
                if (spec.operations.has(key)) diag.error("spec.duplicate-operation", `two operations have the key "${key}"`, { spec: at });
                else spec.operations.set(key, { key, method: method.toUpperCase(), path, operation, pathItem, at });
            }
        }
        return spec;
    }

    /** Follows a `$ref` to an object of this document, if the value is one. External references are refused. */
    deref(value: unknown, at: string, diag: Diagnostics, seen = new Set<string>()): Json | undefined {
        if (!isObject(value) || typeof value.$ref !== "string") return value as Json;
        const ref = value.$ref;
        if (!ref.startsWith("#/")) {
            diag.error("spec.external-ref", `external reference "${ref}": the spec must be a single file`, { spec: at });
            return undefined;
        }
        if (seen.has(ref)) {
            diag.error("spec.ref-loop", `reference "${ref}" refers to itself`, { spec: at });
            return undefined;
        }
        const target = this.resolve(ref);
        if (target === undefined) {
            diag.error("spec.unresolved-ref", `reference "${ref}" leads nowhere`, { spec: at });
            return undefined;
        }
        seen.add(ref);
        return this.deref(target, ref.slice(1), diag, seen);
    }

    resolve(ref: string): Json | undefined {
        let node: Json | undefined = this.doc;
        for (const raw of ref.slice(2).split("/")) {
            const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
            if (Array.isArray(node)) node = node[Number(key)];
            else if (isObject(node)) node = node[key];
            else return undefined;
        }
        return node;
    }
}

// ── Schemas ─────────────────────────────────────────────────────────────────

/** Keywords the engine's validator checks, and the annotations it accepts. */
const VALIDATION = new Set([
    "type",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "allOf",
    "anyOf",
    "oneOf",
]);
const KEPT_ANNOTATIONS = new Set(["title", "description", "default", "examples", "deprecated"]);
/** Annotations dropped: they do not constrain a value, and the engine does not read them. */
const DROPPED = new Set([
    "$schema",
    "$id",
    "$comment",
    "$anchor",
    "format",
    "xml",
    "externalDocs",
    "discriminator",
    "readOnly",
    "writeOnly",
    "contentMediaType",
    "contentEncoding",
]);
/** Validation keywords the engine does not check yet: dropping one would widen the schema, so it is an error. */
const UNSUPPORTED = new Set([
    "multipleOf",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "patternProperties",
    "propertyNames",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
    "if",
    "then",
    "else",
    "not",
    "prefixItems",
    "contains",
    "minContains",
    "maxContains",
    "unevaluatedProperties",
    "unevaluatedItems",
    "$dynamicRef",
    "$recursiveRef",
]);

export type SchemaMode = "request" | "response";

export interface ISchemaContext {
    readonly spec: Spec;
    readonly diag: Diagnostics;
    readonly mode: SchemaMode;
    /** Where the binding entry being compiled is, to attach diagnostics to it too. */
    readonly binding?: string;
}

/**
 * A schema of the spec, in the JSON Schema 2020-12 subset the engine checks:
 * references resolved, OpenAPI 3.0 forms converted, annotations it does not
 * read dropped. A recursive schema is cut at its second occurrence.
 * `readOnly` properties leave request schemas, `writeOnly` ones response schemas.
 */
export function normalizeSchema(schema: unknown, at: string, ctx: ISchemaContext, stack: readonly string[] = []): Json {
    if (typeof schema === "boolean") return schema;
    if (!isObject(schema)) {
        ctx.diag.error("schema.invalid", "a schema must be an object or a boolean", { spec: at, ...(ctx.binding ? { binding: ctx.binding } : {}) });
        return true;
    }
    if (typeof schema.$ref === "string") {
        const ref = schema.$ref;
        if (stack.includes(ref)) {
            ctx.diag.warning("schema.recursive", `"${ref}" is recursive; it is cut to { "type": "object" } at its second occurrence`, { spec: at });
            return { type: "object" };
        }
        const target = ctx.spec.deref({ $ref: ref }, at, ctx.diag);
        if (target === undefined) return true;
        const resolved = normalizeSchema(target, ref.slice(1), ctx, [...stack, ref]);
        // OpenAPI 3.1 allows keywords next to $ref; 3.0 ignores them.
        const siblings = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$ref"));
        if (ctx.spec.version === "3.1" && Object.keys(siblings).length > 0) return { allOf: [resolved, normalizeSchema(siblings, at, ctx, stack)] };
        return resolved;
    }

    const out: JsonObject = {};
    const nullable = ctx.spec.version === "3.0" && schema.nullable === true;
    for (const [key, value] of Object.entries(schema)) {
        const here = `${at}/${token(key)}`;
        if (key === "nullable" || key === "example" || key.startsWith("x-") || DROPPED.has(key)) continue;
        if (UNSUPPORTED.has(key)) {
            ctx.diag.error("schema.unsupported-keyword", `"${key}" is not checked by the engine yet; dropping it would widen the schema`, {
                spec: here,
                ...(ctx.binding ? { binding: ctx.binding } : {}),
            });
            continue;
        }
        if (KEPT_ANNOTATIONS.has(key)) {
            out[key] = value;
            continue;
        }
        if (!VALIDATION.has(key)) continue; // unknown keyword: no validation meaning
        switch (key) {
            case "properties": {
                const props: JsonObject = {};
                for (const [name, sub] of Object.entries(isObject(value) ? value : {})) {
                    const resolved = isObject(sub) && typeof sub.$ref !== "string" ? sub : (ctx.spec.deref(sub, `${here}/${token(name)}`, ctx.diag) ?? {});
                    if (isObject(resolved) && ((ctx.mode === "request" && resolved.readOnly === true) || (ctx.mode === "response" && resolved.writeOnly === true))) continue;
                    props[name] = normalizeSchema(sub, `${here}/${token(name)}`, ctx, stack);
                }
                out.properties = props;
                break;
            }
            case "additionalProperties":
            case "items":
                out[key] = normalizeSchema(value, here, ctx, stack);
                break;
            case "allOf":
            case "anyOf":
            case "oneOf":
                out[key] = Array.isArray(value) ? value.map((s, i) => normalizeSchema(s, `${here}/${i}`, ctx, stack)) : [];
                break;
            case "pattern":
                if (typeof value === "string" && !re2Accepts(value)) {
                    ctx.diag.error("schema.pattern-not-re2", `pattern "${value}" is not accepted by RE2 (lookaround, backreference?)`, {
                        spec: here,
                        ...(ctx.binding ? { binding: ctx.binding } : {}),
                    });
                }
                out[key] = value;
                break;
            default:
                out[key] = value;
        }
    }
    // Required properties that left (readOnly in a request, writeOnly in a response) leave `required` too.
    if (Array.isArray(out.required) && isObject(out.properties)) {
        const props = out.properties;
        const req = out.required.filter((r) => typeof r === "string" && (r in props || !(isObject(schema.properties) && r in schema.properties)));
        if (req.length > 0) out.required = req;
        else delete out.required;
    }
    // OpenAPI 3.0: boolean exclusive bounds.
    if (ctx.spec.version === "3.0") {
        for (const [ex, bound] of [
            ["exclusiveMinimum", "minimum"],
            ["exclusiveMaximum", "maximum"],
        ] as const) {
            if (typeof out[ex] === "boolean") {
                if (out[ex] === true && typeof out[bound] === "number") {
                    out[ex] = out[bound];
                    delete out[bound];
                } else delete out[ex];
            }
        }
    }
    if (nullable) {
        if (typeof out.type === "string") out.type = [out.type, "null"];
        else if (Array.isArray(out.type) && !out.type.includes("null")) out.type = [...out.type, "null"];
        if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    }
    return out;
}

export function re2Accepts(pattern: string): boolean {
    try {
        RE2JS.compile(pattern);
        return true;
    } catch {
        return false;
    }
}
