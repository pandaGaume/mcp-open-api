import { RE2JS } from "re2js";

/**
 * The engine's argument validator: the schema is walked once, at load, into a
 * tree of closures. Nothing is generated from strings, so it runs under
 * `--disallow-code-generation-from-strings`, and patterns run on RE2 (linear
 * time). It knows the keywords the compiler emits and refuses any other at
 * load: a keyword ignored in silence would let everything through.
 *
 * Kept in step with Ajv by bench/validator.fuzz.mjs (docs/compiler.md).
 */

export interface IValidationError {
    /** JSON Pointer of the faulty value: `/pourcent`. `""` for the root. */
    readonly path: string;
    readonly keyword: string;
}

export type Validator = (value: unknown) => IValidationError | null;

type Check = (value: unknown, path: string) => IValidationError | null;

const SUPPORTED = new Set([
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
    // Annotations: no effect on validity.
    "$schema",
    "title",
    "description",
    "default",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
]);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const TYPES: Readonly<Record<string, (v: unknown) => boolean>> = {
    string: (v) => typeof v === "string",
    number: (v) => typeof v === "number" && Number.isFinite(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === "boolean",
    null: (v) => v === null,
    array: (v) => Array.isArray(v),
    object: isObject,
};

/** JSON equality: key order does not matter, array order does. */
export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        const other = b as unknown[];
        return a.length === other.length && a.every((x, i) => jsonEqual(x, other[i]));
    }
    const ka = Object.keys(a);
    const ob = b as Record<string, unknown>;
    return ka.length === Object.keys(ob).length && ka.every((k) => Object.hasOwn(ob, k) && jsonEqual((a as Record<string, unknown>)[k], ob[k]));
}

/** JSON Schema counts code points, not UTF-16 units. */
const codePoints = (s: string): number => (/[\uD800-\uDFFF]/.test(s) ? [...s].length : s.length);

const fail = (path: string, keyword: string): IValidationError => ({ path, keyword });
const escape = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Compiles a schema into a validator. Throws on a keyword it does not know, or a pattern RE2 does not accept. */
export function compileValidator(schema: unknown): Validator {
    const check = compile(schema, "#");
    return (value) => check(value, "");
}

function compile(schema: unknown, at: string): Check {
    if (schema === true) return () => null;
    if (schema === false) return (_v, p) => fail(p, "false");
    if (!isObject(schema)) throw new Error(`schema at ${at} must be an object or a boolean`);
    for (const key of Object.keys(schema)) {
        if (!SUPPORTED.has(key)) throw new Error(`unsupported keyword "${key}" at ${at}`);
    }
    const checks: Check[] = [];

    if (schema.type !== undefined) {
        const names = ([] as unknown[]).concat(schema.type);
        const tests = names.map((t) => {
            const test = typeof t === "string" ? TYPES[t] : undefined;
            if (!test) throw new Error(`unknown type ${JSON.stringify(t)} at ${at}`);
            return test;
        });
        checks.push(tests.length === 1 ? (v, p) => (tests[0]!(v) ? null : fail(p, "type")) : (v, p) => (tests.some((t) => t(v)) ? null : fail(p, "type")));
    }
    if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum)) throw new Error(`enum at ${at} must be an array`);
        const values = schema.enum as unknown[];
        const scalars = values.every((x) => x === null || typeof x !== "object") ? new Set(values) : null;
        checks.push(scalars ? (v, p) => (scalars.has(v) ? null : fail(p, "enum")) : (v, p) => (values.some((x) => jsonEqual(x, v)) ? null : fail(p, "enum")));
    }
    if ("const" in schema) {
        const c = schema.const;
        checks.push((v, p) => (jsonEqual(c, v) ? null : fail(p, "const")));
    }
    const bound = (key: string, ok: (v: number, b: number) => boolean): void => {
        const b = schema[key];
        if (b === undefined) return;
        if (typeof b !== "number") throw new Error(`${key} at ${at} must be a number`);
        checks.push((v, p) => (typeof v !== "number" || ok(v, b) ? null : fail(p, key)));
    };
    bound("minimum", (v, b) => v >= b);
    bound("maximum", (v, b) => v <= b);
    bound("exclusiveMinimum", (v, b) => v > b);
    bound("exclusiveMaximum", (v, b) => v < b);

    const count = (key: string): number | undefined => {
        const n = schema[key];
        if (n === undefined) return undefined;
        if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`${key} at ${at} must be a non-negative integer`);
        return n as number;
    };
    const minLength = count("minLength");
    const maxLength = count("maxLength");
    if (minLength !== undefined) checks.push((v, p) => (typeof v !== "string" || codePoints(v) >= minLength ? null : fail(p, "minLength")));
    // maxLength before pattern: RE2 is linear, not free.
    if (maxLength !== undefined) checks.push((v, p) => (typeof v !== "string" || codePoints(v) <= maxLength ? null : fail(p, "maxLength")));
    if (schema.pattern !== undefined) {
        if (typeof schema.pattern !== "string") throw new Error(`pattern at ${at} must be a string`);
        let re: RE2JS;
        try {
            re = RE2JS.compile(schema.pattern);
        } catch (error) {
            throw new Error(`pattern at ${at} is not accepted by RE2: ${error instanceof Error ? error.message : String(error)}`);
        }
        checks.push((v, p) => (typeof v !== "string" || re.matcher(v).find() ? null : fail(p, "pattern")));
    }

    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
        const properties = isObject(schema.properties) ? schema.properties : {};
        const props = Object.entries(properties).map(([k, s]) => [k, compile(s, `${at}/properties/${escape(k)}`)] as const);
        const known = new Set(Object.keys(properties));
        const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
        const extra = schema.additionalProperties === undefined ? null : compile(schema.additionalProperties, `${at}/additionalProperties`);
        checks.push((v, p) => {
            if (!isObject(v)) return null;
            for (const k of required) if (!Object.hasOwn(v, k)) return fail(`${p}/${escape(k)}`, "required");
            for (const [k, check] of props) {
                if (Object.hasOwn(v, k)) {
                    const e = check(v[k], `${p}/${escape(k)}`);
                    if (e) return e;
                }
            }
            if (extra) {
                for (const k of Object.keys(v)) {
                    if (known.has(k)) continue;
                    const e = extra(v[k], `${p}/${escape(k)}`);
                    if (e) return e;
                }
            }
            return null;
        });
    }

    const minItems = count("minItems") ?? 0;
    const maxItems = count("maxItems") ?? Infinity;
    if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
        const item = schema.items === undefined ? null : compile(schema.items, `${at}/items`);
        checks.push((v, p) => {
            if (!Array.isArray(v)) return null;
            if (v.length < minItems) return fail(p, "minItems");
            if (v.length > maxItems) return fail(p, "maxItems");
            if (item) {
                for (let i = 0; i < v.length; i++) {
                    const e = item(v[i], `${p}/${i}`);
                    if (e) return e;
                }
            }
            return null;
        });
    }

    const list = (key: string): Check[] | null => {
        const xs = schema[key];
        if (xs === undefined) return null;
        if (!Array.isArray(xs) || xs.length === 0) throw new Error(`${key} at ${at} must be a non-empty array`);
        return xs.map((s, i) => compile(s, `${at}/${key}/${i}`));
    };
    const allOf = list("allOf");
    if (allOf) {
        checks.push((v, p) => {
            for (const check of allOf) {
                const e = check(v, p);
                if (e) return e;
            }
            return null;
        });
    }
    const anyOf = list("anyOf");
    if (anyOf) checks.push((v, p) => (anyOf.some((check) => check(v, p) === null) ? null : fail(p, "anyOf")));
    const oneOf = list("oneOf");
    if (oneOf) checks.push((v, p) => (oneOf.filter((check) => check(v, p) === null).length === 1 ? null : fail(p, "oneOf")));

    if (checks.length === 0) return () => null;
    if (checks.length === 1) return checks[0]!;
    return (v, p) => {
        for (const check of checks) {
            const e = check(v, p);
            if (e) return e;
        }
        return null;
    };
}
