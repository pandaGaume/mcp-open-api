import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { compileValidator, jsonEqual } from "@cyanmycelium/mcp-open-api";

describe("the engine's validator", () => {
    it("reports the path and keyword of the first error", () => {
        const validate = compileValidator({
            type: "object",
            required: ["vanne", "pourcent"],
            properties: { vanne: { type: "string", pattern: "^V-\\d{3}$" }, pourcent: { allOf: [{ maximum: 150 }, { maximum: 100 }] } },
        });
        expect(validate({ vanne: "V-012", pourcent: 42 })).toBeNull();
        expect(validate({ vanne: "V-012", pourcent: 120 })).toEqual({ path: "/pourcent", keyword: "maximum" });
        expect(validate({ vanne: "V-12", pourcent: 1 })).toEqual({ path: "/vanne", keyword: "pattern" });
        expect(validate({ vanne: "V-012" })).toEqual({ path: "/pourcent", keyword: "required" });
    });

    it("compares enum members as JSON: key order does not matter", () => {
        expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(compileValidator({ enum: [{ a: 1, b: [1, 2] }] })({ b: [1, 2], a: 1 })).toBeNull();
        expect(compileValidator({ enum: [{ a: 1, b: [1, 2] }] })({ a: 1, b: [2, 1] })).not.toBeNull();
    });

    it("counts code points, not UTF-16 units", () => {
        expect(compileValidator({ maxLength: 2 })("😀😀")).toBeNull();
    });

    it("refuses at load any keyword it does not know, rather than ignoring it", () => {
        expect(() => compileValidator({ type: "object", if: { required: ["a"] } })).toThrow(/unsupported keyword "if"/);
        expect(() => compileValidator({ properties: { a: { format: "email" } } })).toThrow(/unsupported keyword "format" at #\/properties\/a/);
    });

    it("refuses a pattern RE2 does not accept", () => {
        expect(() => compileValidator({ pattern: "^(?=a)a$" })).toThrow(/not accepted by RE2/);
        expect(() => compileValidator({ pattern: "(a)\\1" })).toThrow(/not accepted by RE2/);
    });

    it("evaluates a hostile pattern in linear time", () => {
        // ^(a+)+$ takes about 860 ms on V8 for 29 characters, twice as long per extra one.
        const validate = compileValidator({ type: "string", pattern: "^(a+)+$" });
        const start = performance.now();
        expect(validate("a".repeat(40) + "!")).toEqual({ path: "", keyword: "pattern" });
        expect(performance.now() - start).toBeLessThan(50);
    });
});

// ── Differential check against Ajv, the reference ───────────────────────────
// A short run on every commit; bench/validator.fuzz.mjs runs a long one.

let seed = 20261005;
const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number): boolean => rand() < p;
const KEYS = ["a", "b", "c"];

function value(depth = 0): unknown {
    switch (pick(depth > 2 ? ["s", "n", "b", "z"] : ["s", "n", "b", "z", "o", "a"])) {
        case "s":
            return pick(["", "a", "ab", "V-012", "héllo", "😀😀", "AB-123"]);
        case "n":
            return pick([0, -1, 1.5, 3, 99.9, 100, 150]);
        case "b":
            return chance(0.5);
        case "z":
            return null;
        case "a":
            return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1));
        default: {
            const o: Record<string, unknown> = {};
            for (const k of [...KEYS].sort(() => rand() - 0.5)) if (chance(0.5)) o[k] = value(depth + 1);
            return o;
        }
    }
}

const reorder = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reorder);
    if (v !== null && typeof v === "object")
        return Object.fromEntries(
            Object.keys(v)
                .sort(() => rand() - 0.5)
                .map((k) => [k, reorder((v as Record<string, unknown>)[k])])
        );
    return v;
};

function schema(depth = 0): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (chance(0.6)) s.type = pick(["string", "number", "integer", "boolean", "null", "array", "object"]);
    if (chance(0.15)) s.enum = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => value(2));
    if (chance(0.05)) s.const = value(2);
    if (chance(0.2)) s.minimum = pick([-1, 0, 1]);
    if (chance(0.2)) s.maximum = pick([1, 100, 150]);
    if (chance(0.15)) s.maxLength = Math.floor(rand() * 5);
    if (chance(0.15)) s.pattern = pick(["^V-\\d{3}$", "^[a-z]+$", "b"]);
    if (depth < 3 && chance(0.3)) {
        const properties: Record<string, unknown> = {};
        for (const k of KEYS) if (chance(0.5)) properties[k] = schema(depth + 1);
        s.properties = properties;
        if (chance(0.5)) s.required = KEYS.filter(() => chance(0.4));
        if (chance(0.3)) s.additionalProperties = chance(0.6) ? false : schema(depth + 1);
    }
    if (depth < 3 && chance(0.2)) s.items = schema(depth + 1);
    if (chance(0.1)) s.maxItems = Math.floor(rand() * 3);
    if (depth < 3 && chance(0.15)) s.allOf = [schema(depth + 1), schema(depth + 1)];
    if (depth < 3 && chance(0.08)) s.anyOf = [schema(depth + 1), schema(depth + 1)];
    if (depth < 3 && chance(0.08)) s.oneOf = [schema(depth + 1), schema(depth + 1)];
    return s;
}

describe("the validator against Ajv", () => {
    it("gives the same verdict on 3,000 random schemas x 10 values", () => {
        const ajv = new Ajv2020({ strict: false });
        const disagreements: unknown[] = [];
        for (let i = 0; i < 3000; i++) {
            const s = schema();
            const reference = ajv.compile(s);
            const ours = compileValidator(s);
            const members = [...((s.enum as unknown[]) ?? []), ...("const" in s ? [s.const] : [])];
            for (let j = 0; j < 10; j++) {
                const v = members.length && chance(0.5) ? reorder(pick(members)) : value();
                if (reference(v) !== (ours(v) === null)) disagreements.push({ schema: s, value: v, ajv: reference(v) });
            }
        }
        expect(disagreements.slice(0, 3)).toEqual([]);
        // About 3 s alone; RE2 compiles a pattern in microseconds, Ajv a schema in milliseconds.
    }, 60_000);
});
