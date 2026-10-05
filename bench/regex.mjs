// What a `pattern` check costs, three engines, typical and hostile inputs:
//   v8     the built-in RegExp (backtracking)
//   re2    the native RE2 binding (linear time)
//   re2js  the pure JavaScript port of RE2 (linear time)
//
//   node bench/regex.mjs
import { createRequire } from "node:module";
import { cpus } from "node:os";
const require = createRequire(import.meta.url);
const RE2 = require("re2");
const { RE2JS } = require("re2js");

const engines = {
    v8: (p) => { const re = new RegExp(p, "u"); return (s) => re.test(s); },
    re2: (p) => { const re = new RE2(p, "u"); return (s) => re.test(s); },
    re2js: (p) => { const re = RE2JS.compile(p); return (s) => re.matcher(s).find(); },
};

function nsPerOp(fn, input, n) {
    for (let i = 0; i < Math.min(n, 10000); i++) fn(input);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn(input);
    return Number(process.hrtime.bigint() - t0) / n;
}

const typical = [
    ["^V-\\d{3}$ on V-012", "^V-\\d{3}$", "V-012"],
    ["^[A-Z]{2}-\\d{3}$ on PT-007", "^[A-Z]{2}-\\d{3}$", "PT-007"],
    ["e-mail, 30 chars", "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$", "jean.dupont@exemple-usine.fr"],
];

const fmt = (ns) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(1)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(1)} µs` : `${ns.toFixed(0)} ns`);
console.log(`node ${process.version}, ${cpus()[0].model}\n`);
console.log("typical patterns, per test".padEnd(36) + Object.keys(engines).map((e) => e.padStart(12)).join(""));
for (const [label, p, s] of typical) {
    console.log(label.padEnd(36) + Object.values(engines).map((make) => fmt(nsPerOp(make(p), s, 200000)).padStart(12)).join(""));
}

// Hostile: nested quantifier, input that almost matches. V8 backtracks exponentially.
console.log("\nhostile: ^(a+)+$ on 'a' x n + '!'".padEnd(37) + Object.keys(engines).map((e) => e.padStart(12)).join(""));
for (const n of [20, 24, 28]) {
    const s = "a".repeat(n) + "!";
    const row = Object.entries(engines).map(([name, make]) => fmt(nsPerOp(make("^(a+)+$"), s, name === "v8" ? 1 : 2000)).padStart(12));
    console.log(`n = ${n}`.padEnd(36) + row.join(""));
}

console.log("\ncompile cost, per pattern".padEnd(37) + Object.keys(engines).map((e) => e.padStart(12)).join(""));
console.log("^[A-Z]{2}-\\d{3}$".padEnd(36) + Object.values(engines).map((make) => fmt(nsPerOp(() => make("^[A-Z]{2}-\\d{3}$"), null, 20000)).padStart(12)).join(""));
