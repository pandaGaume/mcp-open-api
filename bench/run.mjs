// Drives the plumbing bench: target and broker in their own processes, load
// generated from this one. Prints one table row per scenario.
//
//   node bench/run.mjs
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const once = (child, key) => new Promise((resolve) => child.on("message", function on(m) { if (key in m) { child.off("message", on); resolve(m); } }));

const target = fork(here("./target.mjs"));
const { port } = await once(target, "port");
const broker = fork(here("./broker.mjs"), [String(port)], { silent: true });
// The broker writes one audit line per decision on stdout: drained, not shown.
let auditBytes = 0;
broker.stdout.on("data", (b) => (auditBytes += b.length));
broker.stderr.on("data", (b) => process.stderr.write(b));
const { url, declared } = await once(broker, "url");
if (declared?.error) throw new Error(`declare refused: ${JSON.stringify(declared)}`);

const auth = { authorization: "Bearer bench", "content-type": "application/json", accept: "application/json, text/event-stream" };

async function session(slot) {
    const res = await fetch(`${url}/${slot}/mcp`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" } } }),
    });
    await res.text();
    const id = res.headers.get("mcp-session-id");
    if (!id) throw new Error(`no session on ${slot}: ${res.status}`);
    return id;
}

const sessions = {};
for (const slot of ["echo", "rest", "restnoka", "restgov"]) sessions[slot] = await session(slot);

let seq = 1;
async function callTool(slot, args) {
    const res = await fetch(`${url}/${slot}/mcp`, {
        method: "POST",
        headers: { ...auth, "mcp-session-id": sessions[slot] },
        body: JSON.stringify({ jsonrpc: "2.0", id: seq++, method: "tools/call", params: { name: "getValve", arguments: args } }),
    });
    const text = await res.text();
    const json = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
    if (json.error || json.result?.isError) throw new Error(`${slot}: ${JSON.stringify(json.error ?? json.result.content)}`);
    return json;
}

async function direct(size) {
    const res = await fetch(`http://127.0.0.1:${port}/valves/V-12?size=${size}`);
    JSON.parse(await res.text());
}

const ms = (ns) => Number(ns) / 1e6;
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function measure(label, fn, { n, concurrency = 1, warmup = Math.min(200, n) }) {
    for (let i = 0; i < warmup; i++) await fn();
    const samples = [];
    let next = 0;
    const start = process.hrtime.bigint();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (next++ < n) {
                const t0 = process.hrtime.bigint();
                await fn();
                samples.push(ms(process.hrtime.bigint() - t0));
            }
        })
    );
    const total = ms(process.hrtime.bigint() - start);
    samples.sort((a, b) => a - b);
    return { label, n, concurrency, p50: pct(samples, 50), p99: pct(samples, 99), rps: (n / total) * 1000 };
}

const lagWindow = async (fn) => {
    broker.send("lag:reset");
    await once(broker, "lagReset");
    const result = await fn();
    broker.send("lag:read");
    const { lag } = await once(broker, "lag");
    return { ...result, lag };
};

const rows = [];
const add = (r) => {
    rows.push(r);
    const lag = r.lag ? `  broker loop lag p99 ${r.lag.p99.toFixed(1)} ms, max ${r.lag.max.toFixed(1)} ms` : "";
    console.log(`${r.label.padEnd(44)} n=${String(r.n).padStart(5)} c=${String(r.concurrency).padStart(3)}  p50 ${r.p50.toFixed(3).padStart(8)} ms  p99 ${r.p99.toFixed(3).padStart(8)} ms  ${r.rps.toFixed(0).padStart(6)} req/s${lag}`);
};

console.log(`node ${process.version}, ${cpus()[0].model}, ${cpus().length} threads\n`);

// 1. Sequential latency, 1 KB response.
add(await measure("direct HTTP, 1 KB", () => direct(1024), { n: 3000 }));
add(await measure("broker, no HTTP (echo)", () => callTool("echo", { id: "V-12" }), { n: 3000 }));
add(await measure("broker + runtime, 1 KB, keep-alive", () => callTool("rest", { id: "V-12" }), { n: 3000 }));
add(await measure("broker + runtime, 1 KB, no keep-alive", () => callTool("restnoka", { id: "V-12" }), { n: 3000 }));
add(await measure("broker + runtime + authorize, 1 KB", () => callTool("restgov", { id: "V-12" }), { n: 3000 }));

// 2. Response size.
add(await measure("direct HTTP, 64 KB", () => direct(65536), { n: 1000 }));
add(await lagWindow(() => measure("broker + runtime, 64 KB", () => callTool("rest", { id: "V-12", size: 65536 }), { n: 1000 })));
add(await measure("direct HTTP, 5 MB", () => direct(5 * 1024 * 1024), { n: 60, warmup: 5 }));
add(await lagWindow(() => measure("broker + runtime, 5 MB", () => callTool("rest", { id: "V-12", size: 5 * 1024 * 1024 }), { n: 60, warmup: 5 })));

// 3. Concurrency.
add(await measure("direct HTTP, 1 KB", () => direct(1024), { n: 10000, concurrency: 100 }));
add(await lagWindow(() => measure("broker + runtime, 1 KB", () => callTool("rest", { id: "V-12" }), { n: 10000, concurrency: 100 })));
add(await measure("broker + runtime + authorize, 1 KB", () => callTool("restgov", { id: "V-12" }), { n: 10000, concurrency: 100 }));

// 4. Isolation: a small slot while another slot reads 5 MB bodies in a loop.
let heavy = true;
const background = Promise.all(Array.from({ length: 4 }, async () => { while (heavy) await callTool("rest", { id: "V-12", size: 5 * 1024 * 1024 }); }));
add(await lagWindow(() => measure("echo while 4 x 5 MB run on another slot", () => callTool("echo", { id: "V-12" }), { n: 1000, warmup: 0 })));
heavy = false;
await background;

console.log(`\n${JSON.stringify(rows)}`);
target.kill();
broker.on("exit", () => process.exit(0));
broker.send("stop");
