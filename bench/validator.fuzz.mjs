// Differential fuzzing of the engine's validator (src/runtime/validator.ts) against Ajv, the reference.
// Random schemas within the supported subset, random values, same verdict
// expected from both. Any disagreement is printed with the schema and value.
//
//   node bench/validator.fuzz.mjs [cases=100000] [seed=1]
import Ajv2020 from "ajv/dist/2020.js";
// The real validator, from the build: run `npm run build` first.
import { compileValidator } from "../dist/index.js";

const cases = Number(process.argv[2] ?? 100000);
let seed = Number(process.argv[3] ?? 1);
// Deterministic PRNG (mulberry32): a failure is replayable from its seed.
const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;

const KEYS = ["a", "b", "c"];
const STRINGS = ["", "a", "ab", "V-012", "V-1", "héllo", "😀😀", "AB-123", "abc"];
const PATTERNS = ["^V-\\d{3}$", "^[a-z]+$", "^.{2}$", "b", "^[A-Z]{2}-\\d{3}$"];

function value(depth = 0) {
    const kind = depth > 2 ? pick(["s", "n", "i", "b", "z"]) : pick(["s", "n", "i", "b", "z", "o", "a"]);
    switch (kind) {
        case "s": return pick(STRINGS);
        case "n": return pick([0, -1, 1.5, 99.9, 100, 100.5, 150, -50]);
        case "i": return int(-3, 3);
        case "b": return chance(0.5);
        case "z": return null;
        case "a": return Array.from({ length: int(0, 3) }, () => value(depth + 1));
        case "o": {
            const o = {};
            for (const k of [...KEYS].sort(() => rand() - 0.5)) if (chance(0.5)) o[k] = value(depth + 1);
            return o;
        }
    }
}

function schema(depth = 0) {
    const s = {};
    const types = ["string", "number", "integer", "boolean", "null", "array", "object"];
    if (chance(0.6)) s.type = chance(0.8) ? pick(types) : [pick(types), pick(types)].filter((t, i, a) => a.indexOf(t) === i);
    if (chance(0.15)) s.enum = Array.from({ length: int(1, 3) }, () => value(2));
    if (chance(0.05)) s.const = value(2);
    if (chance(0.2)) s.minimum = pick([-1, 0, 1, 99.9]);
    if (chance(0.2)) s.maximum = pick([0, 1, 100, 150]);
    if (chance(0.1)) s.exclusiveMinimum = pick([0, 1]);
    if (chance(0.1)) s.exclusiveMaximum = pick([100, 1]);
    if (chance(0.15)) s.minLength = int(0, 3);
    if (chance(0.15)) s.maxLength = int(0, 5);
    if (chance(0.15)) s.pattern = pick(PATTERNS);
    if (depth < 3 && chance(0.3)) {
        s.properties = {};
        for (const k of KEYS) if (chance(0.5)) s.properties[k] = schema(depth + 1);
        if (chance(0.5)) s.required = KEYS.filter(() => chance(0.4));
        if (chance(0.3)) s.additionalProperties = chance(0.6) ? false : schema(depth + 1);
    }
    if (depth < 3 && chance(0.2)) s.items = schema(depth + 1);
    if (chance(0.1)) s.minItems = int(0, 2);
    if (chance(0.1)) s.maxItems = int(0, 3);
    if (depth < 3 && chance(0.15)) s.allOf = Array.from({ length: int(1, 3) }, () => schema(depth + 1));
    if (depth < 3 && chance(0.08)) s.anyOf = Array.from({ length: int(1, 3) }, () => schema(depth + 1));
    if (depth < 3 && chance(0.08)) s.oneOf = Array.from({ length: int(1, 3) }, () => schema(depth + 1));
    return s;
}

/** A deep copy with every object's keys in a new order. */
function reorder(v) {
    if (Array.isArray(v)) return v.map(reorder);
    if (v !== null && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v).sort(() => rand() - 0.5)) out[k] = reorder(v[k]);
        return out;
    }
    return v;
}

const ajv = new Ajv2020({ strict: false, allErrors: false });
const failures = new Map();
let agreed = 0;
for (let i = 0; i < cases; i++) {
    const s = schema();
    const reference = ajv.compile(s);
    const ours = compileValidator(s);
    for (let j = 0; j < 10; j++) {
        // Random values almost never hit an enum or const member, let alone a copy with
        // its keys in another order: half the time, test exactly that.
        const members = [...(s.enum ?? []), ...("const" in s ? [s.const] : [])];
        const v = members.length && chance(0.5) ? reorder(pick(members)) : value();
        const expected = reference(v);
        const got = ours(v) === null;
        if (expected === got) {
            agreed++;
            continue;
        }
        const keywords = Object.keys(s).sort().join(",");
        if (!failures.has(keywords)) failures.set(keywords, { schema: s, value: v, ajv: expected, ours: got });
    }
}

console.log(`${cases} schemas x 10 values: ${agreed} agreements, ${cases * 10 - agreed} disagreements, ${failures.size} distinct keyword sets`);
for (const [keywords, f] of [...failures].slice(0, 8)) {
    console.log(`\n[${keywords}] ajv=${f.ajv} ours=${f.ours}\n  schema ${JSON.stringify(f.schema)}\n  value  ${JSON.stringify(f.value)}`);
}
process.exit(failures.size ? 1 : 0);
