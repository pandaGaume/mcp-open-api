// Prototype of the runtime's argument validator: the schema is walked ONCE, at
// load, into a tree of closures. No code is generated from strings, so it runs
// under --disallow-code-generation-from-strings. It covers the keywords the
// compiler emits into a manifest's inputSchema, and refuses any other keyword
// at load rather than ignoring it.
//
// A validator returns null when the value is valid, or the path and keyword of
// the first error.

const SUPPORTED = new Set([
    "type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "pattern", "properties", "required", "additionalProperties",
    "items", "minItems", "maxItems", "allOf", "anyOf", "oneOf", "description", "title", "default", "examples",
]);

const typeChecks = {
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number" && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
    null: (v) => v === null,
    array: (v) => Array.isArray(v),
    object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
};

// JSON equality: key order does not matter, array order does, 1 and 1.0 are equal.
function same(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}
// JSON Schema counts code points, not UTF-16 units.
const length = (s) => (/[\uD800-\uDFFF]/.test(s) ? [...s].length : s.length);
const fail = (path, keyword) => ({ path, keyword });

export function compileValidator(schema, path = "") {
    if (schema === true) return () => null;
    if (schema === false) return (_v, p) => fail(p, "false");
    for (const key of Object.keys(schema)) {
        if (!SUPPORTED.has(key)) throw new Error(`unsupported keyword "${key}" at ${path || "/"}`);
    }
    const checks = [];

    if (schema.type !== undefined) {
        const types = [].concat(schema.type).map((t) => typeChecks[t]);
        checks.push(types.length === 1 ? (v, p) => (types[0](v) ? null : fail(p, "type")) : (v, p) => (types.some((t) => t(v)) ? null : fail(p, "type")));
    }
    if (schema.enum) {
        const values = schema.enum;
        const primitives = values.every((x) => x === null || typeof x !== "object") ? new Set(values) : null;
        checks.push(primitives ? (v, p) => (primitives.has(v) ? null : fail(p, "enum")) : (v, p) => (values.some((x) => same(x, v)) ? null : fail(p, "enum")));
    }
    if ("const" in schema) {
        const c = schema.const;
        checks.push((v, p) => (same(c, v) ? null : fail(p, "const")));
    }
    const num = (key, ok) => {
        if (schema[key] === undefined) return;
        const bound = schema[key];
        checks.push((v, p) => (typeof v !== "number" || ok(v, bound) ? null : fail(p, key)));
    };
    num("minimum", (v, b) => v >= b);
    num("maximum", (v, b) => v <= b);
    num("exclusiveMinimum", (v, b) => v > b);
    num("exclusiveMaximum", (v, b) => v < b);
    if (schema.minLength !== undefined) {
        const n = schema.minLength;
        checks.push((v, p) => (typeof v !== "string" || length(v) >= n ? null : fail(p, "minLength")));
    }
    if (schema.maxLength !== undefined) {
        const n = schema.maxLength;
        checks.push((v, p) => (typeof v !== "string" || length(v) <= n ? null : fail(p, "maxLength")));
    }
    if (schema.pattern !== undefined) {
        const re = new RegExp(schema.pattern, "u");
        checks.push((v, p) => (typeof v !== "string" || re.test(v) ? null : fail(p, "pattern")));
    }
    if (schema.properties || schema.required || schema.additionalProperties !== undefined) {
        const props = Object.entries(schema.properties ?? {}).map(([k, s]) => [k, compileValidator(s, `${path}/${k}`)]);
        const known = new Set(props.map(([k]) => k));
        const required = schema.required ?? [];
        const extra = schema.additionalProperties === undefined ? null : compileValidator(schema.additionalProperties, `${path}/*`);
        checks.push((v, p) => {
            if (!typeChecks.object(v)) return null;
            for (const k of required) if (!(k in v)) return fail(`${p}/${k}`, "required");
            for (const [k, check] of props) {
                if (v[k] !== undefined) {
                    const e = check(v[k], `${p}/${k}`);
                    if (e) return e;
                }
            }
            if (extra) {
                for (const k in v) {
                    if (!known.has(k)) {
                        const e = extra(v[k], `${p}/${k}`);
                        if (e) return e;
                    }
                }
            }
            return null;
        });
    }
    if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
        const item = schema.items === undefined ? null : compileValidator(schema.items, `${path}/[]`);
        const min = schema.minItems ?? 0;
        const max = schema.maxItems ?? Infinity;
        checks.push((v, p) => {
            if (!Array.isArray(v)) return null;
            if (v.length < min) return fail(p, "minItems");
            if (v.length > max) return fail(p, "maxItems");
            if (item) {
                for (let i = 0; i < v.length; i++) {
                    const e = item(v[i], `${p}/${i}`);
                    if (e) return e;
                }
            }
            return null;
        });
    }
    if (schema.allOf) {
        const all = schema.allOf.map((s, i) => compileValidator(s, `${path}/allOf/${i}`));
        checks.push((v, p) => {
            for (const check of all) {
                const e = check(v, p);
                if (e) return e;
            }
            return null;
        });
    }
    if (schema.anyOf) {
        const any = schema.anyOf.map((s, i) => compileValidator(s, `${path}/anyOf/${i}`));
        checks.push((v, p) => (any.some((check) => check(v, p) === null) ? null : fail(p, "anyOf")));
    }
    if (schema.oneOf) {
        const one = schema.oneOf.map((s, i) => compileValidator(s, `${path}/oneOf/${i}`));
        checks.push((v, p) => (one.filter((check) => check(v, p) === null).length === 1 ? null : fail(p, "oneOf")));
    }

    if (checks.length === 0) return () => null;
    if (checks.length === 1) return (v, p = "") => checks[0](v, p);
    return (v, p = "") => {
        for (const check of checks) {
            const e = check(v, p);
            if (e) return e;
        }
        return null;
    };
}
