// What argument validation costs per call, three ways:
//   ajv       schema compiled into generated JavaScript (new Function)
//   cfworker  @cfworker/json-schema, interpreted: walks the schema on every call
//   closures  bench/closure.validator.mjs: schema walked once, at load, into closures
//
//   node bench/validate.mjs
//   node --disallow-code-generation-from-strings bench/validate.mjs   (ajv is then skipped)
import { cpus } from "node:os";
import { Validator } from "@cfworker/json-schema";
import { compileValidator } from "./closure.validator.mjs";

// The inputSchema the compiler emits for ouvrir_vanne: spec schema AND binding restriction.
const small = {
    type: "object",
    additionalProperties: false,
    required: ["vanne", "pourcent"],
    properties: {
        vanne: { allOf: [{ type: "string" }, { pattern: "^V-\\d{3}$", maxLength: 5 }] },
        pourcent: { allOf: [{ type: "number", minimum: 0, maximum: 150 }, { minimum: 0, maximum: 100 }] },
    },
};

// A heavier tool: 12 arguments, a nested object, an array of 20 objects.
const point = { type: "object", additionalProperties: false, required: ["tag", "value"], properties: { tag: { type: "string", pattern: "^[A-Z]{2}-\\d{3}$" }, value: { type: "number" }, quality: { enum: ["good", "bad", "uncertain"] } } };
const large = {
    type: "object",
    additionalProperties: false,
    required: ["site", "line", "points", "mode"],
    properties: {
        site: { type: "string", maxLength: 32 },
        line: { type: "integer", minimum: 1, maximum: 64 },
        mode: { enum: ["auto", "manual", "maintenance"] },
        operator: { type: "string", maxLength: 64 },
        reason: { type: "string", maxLength: 256 },
        dryRun: { type: "boolean" },
        priority: { type: "integer", minimum: 0, maximum: 9 },
        window: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" } } },
        tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 16 } },
        setpoint: { allOf: [{ type: "number" }, { minimum: -50, maximum: 150 }] },
        ticket: { type: ["string", "null"] },
        points: { type: "array", minItems: 1, maxItems: 50, items: point },
    },
};
const largeInput = {
    site: "nord",
    line: 3,
    mode: "manual",
    operator: "j.dupont",
    reason: "calibration after maintenance",
    dryRun: false,
    priority: 2,
    window: { from: "2026-10-05T08:00:00Z", to: "2026-10-05T10:00:00Z" },
    tags: ["calib", "q4"],
    setpoint: 72.5,
    ticket: null,
    points: Array.from({ length: 20 }, (_, i) => ({ tag: `PT-${String(i).padStart(3, "0")}`, value: i * 1.5, quality: "good" })),
};

const cases = [
    { label: "ouvrir_vanne, valid", schema: small, input: { vanne: "V-012", pourcent: 42 }, valid: true },
    { label: "ouvrir_vanne, 120 %", schema: small, input: { vanne: "V-012", pourcent: 120 }, valid: false },
    { label: "12 args + 20 points, valid", schema: large, input: largeInput, valid: true },
    { label: "12 args + 20 points, last point bad", schema: large, input: { ...largeInput, points: [...largeInput.points.slice(0, 19), { tag: "bad", value: 1 }] }, valid: false },
];

let ajvAvailable = true;
let Ajv2020;
try {
    ({ default: Ajv2020 } = await import("ajv/dist/2020.js"));
    new Ajv2020().compile({ type: "number" });
} catch {
    ajvAvailable = false;
}

function validators(schema) {
    const out = [];
    if (ajvAvailable) {
        const fn = new Ajv2020({ allErrors: false, strict: false }).compile(schema);
        out.push(["ajv", (v) => fn(v)]);
    }
    const cf = new Validator(schema, "2020-12", true);
    out.push(["cfworker", (v) => cf.validate(v).valid]);
    const closures = compileValidator(schema);
    out.push(["closures", (v) => closures(v) === null]);
    return out;
}

function nsPerOp(fn, input) {
    for (let i = 0; i < 20000; i++) fn(input);
    const runs = [];
    for (let r = 0; r < 5; r++) {
        const n = 100000;
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < n; i++) fn(input);
        runs.push(Number(process.hrtime.bigint() - t0) / n);
    }
    runs.sort((a, b) => a - b);
    return runs[2];
}

console.log(`node ${process.version}, ${cpus()[0].model}, ajv ${ajvAvailable ? "available" : "skipped (code generation disallowed)"}\n`);
const header = ["case", ...validators(small).map(([name]) => name)];
console.log(header.map((h, i) => (i === 0 ? h.padEnd(40) : h.padStart(12))).join(""));
for (const c of cases) {
    const row = [c.label.padEnd(40)];
    for (const [name, fn] of validators(c.schema)) {
        if (fn(c.input) !== c.valid) throw new Error(`${name} disagrees on "${c.label}"`);
        row.push(`${nsPerOp(fn, c.input).toFixed(0)} ns`.padStart(12));
    }
    console.log(row.join(""));
}

// Load cost: compiling the large schema once.
const load = (fn) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) fn();
    return Number(process.hrtime.bigint() - t0) / 200 / 1000;
};
console.log("\nload, large schema (once per tool, at publication):");
if (ajvAvailable) console.log(`  ajv       ${load(() => new Ajv2020({ strict: false }).compile(large)).toFixed(0)} µs`);
console.log(`  cfworker  ${load(() => new Validator(large, "2020-12", true)).toFixed(0)} µs`);
console.log(`  closures  ${load(() => compileValidator(large)).toFixed(0)} µs`);
