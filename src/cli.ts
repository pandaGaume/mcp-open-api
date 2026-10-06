import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { IDiagnostic } from "./compiler/diagnostics";
import { OpenApiHost, loadHostConfig } from "./host/host";
import { generateSigningKeys, signManifest } from "./host/signature";

const NO_CODEGEN = "--disallow-code-generation-from-strings";

const USAGE = `mcp-open-api <command>

  compile <binding.json> [--spec <file>] [--out <manifest.json>]
      Compiles a binding and its OpenAPI spec into a manifest. The spec defaults
      to the binding's spec.path, relative to the binding. Exit 1 on any error.

  keygen --out <name>
      Writes an Ed25519 key pair: <name>.pem (private) and <name>.pub.pem.

  sign <manifest.json> --key <private.pem>
      Writes <manifest.json>.sig, the operator's approval of that exact manifest.

  serve [--config <mcp-open-api.json>]
      Serves every signed manifest of the configured directory as a broker slot.
      Run one host per API to keep their secrets and failures apart.
      Runs with ${NO_CODEGEN}; set MCP_OPEN_API_ALLOW_CODE_GENERATION=1 to opt out.

  design [--config <designer.json>]
      Publishes the designer on its slot (default "designer"), for the Tier 4 page
      and for agents. It writes signed manifests into the hosts it names; it never
      signs one. Prints the static mount the broker needs to serve the page.
`;

export interface ICliIo {
    readonly out: (line: string) => void;
    readonly err: (line: string) => void;
}

const consoleIo: ICliIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

/** Removes `name <value>` from args and returns the value. */
function option(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
}

const describe = (d: IDiagnostic): string =>
    `${d.severity === "error" ? "error  " : "warning"} ${d.code}${d.binding ? ` at binding ${d.binding}` : ""}${d.spec ? ` at spec ${d.spec}` : ""}: ${d.message}`;

/** Runs one command and returns its exit code; `serve` and `design` also return what they started, for the caller to stop. */
export async function run(argv: readonly string[], io: ICliIo = consoleIo): Promise<{ code: number; host?: { stop(): Promise<void> } }> {
    const args = [...argv];
    const command = args.shift();
    switch (command) {
        case "compile": {
            const specOpt = option(args, "--spec");
            const out = option(args, "--out");
            const bindingPath = args[0];
            if (!bindingPath) {
                io.err(USAGE);
                return { code: 2 };
            }
            const bindingText = readFileSync(bindingPath, "utf8");
            let specPath = specOpt;
            if (!specPath) {
                try {
                    const declared = (JSON.parse(bindingText) as { spec?: { path?: string } }).spec?.path;
                    if (declared) specPath = resolve(dirname(resolve(bindingPath)), declared);
                } catch {
                    // the compiler reports a binding that is not JSON
                }
            }
            if (!specPath) {
                io.err("the binding names no spec.path: pass --spec <file>");
                return { code: 2 };
            }
            // Loaded on demand: the compiler builds Ajv validators at import, which
            // generates code, and `serve` runs where code generation is disallowed.
            const { compile } = await import("./compiler/compile");
            const result = compile({ binding: bindingText, spec: readFileSync(specPath) });
            for (const d of result.diagnostics) (d.severity === "error" ? io.err : io.out)(describe(d));
            if (!result.manifest) {
                io.err(`${result.diagnostics.filter((d) => d.severity === "error").length} error(s): no manifest`);
                return { code: 1 };
            }
            if (out) writeFileSync(out, `${result.canonical}\n`);
            else io.out(result.canonical!);
            io.err(`manifest ${result.sha256} (${result.manifest.tools.length} tools)${out ? ` written to ${out}` : ""}`);
            return { code: 0 };
        }
        case "keygen": {
            const out = option(args, "--out");
            if (!out) {
                io.err(USAGE);
                return { code: 2 };
            }
            const keys = generateSigningKeys();
            writeFileSync(`${out}.pem`, keys.privateKeyPem, { mode: 0o600 });
            writeFileSync(`${out}.pub.pem`, keys.publicKeyPem);
            io.err(`wrote ${out}.pem (keep it private) and ${out}.pub.pem (list it in trustedKeys)`);
            return { code: 0 };
        }
        case "sign": {
            const key = option(args, "--key");
            const manifestPath = args[0];
            if (!key || !manifestPath) {
                io.err(USAGE);
                return { code: 2 };
            }
            const signature = signManifest(JSON.parse(readFileSync(manifestPath, "utf8")), readFileSync(key, "utf8"));
            writeFileSync(`${manifestPath}.sig`, `${JSON.stringify(signature, null, 2)}\n`);
            io.err(`signed manifest ${signature.manifest}: ${manifestPath}.sig`);
            return { code: 0 };
        }
        case "serve": {
            const { config, baseDir } = loadHostConfig(option(args, "--config") ?? "mcp-open-api.json");
            let codeGeneration = "allowed (set by MCP_OPEN_API_ALLOW_CODE_GENERATION, or not started by the CLI)";
            try {
                new Function("return 1")();
            } catch {
                codeGeneration = "disallowed";
            }
            io.out(`code generation: ${codeGeneration}`);
            const host = await new OpenApiHost(config, baseDir).start();
            for (const s of host.slots) io.out(`serving slot "${s.slot}" (${s.file})`);
            for (const r of host.refused) io.err(`refused ${r.file}:\n  - ${r.reasons.join("\n  - ")}`);
            if (host.slots.length === 0) io.err("no manifest served");
            return { code: host.slots.length > 0 ? 0 : 1, host };
        }
        case "design": {
            // Loaded on demand, like the compiler it uses.
            const { DESIGNER_UI_DIR, loadDesignerConfig, startDesigner } = await import("./designer/designer");
            const { config, hosts } = loadDesignerConfig(option(args, "--config") ?? "designer.json");
            const designer = await startDesigner(config, hosts, { onPublish: (event) => io.out(`published ${JSON.stringify(event)}`) });
            io.out(`designer on slot "${designer.slot}", publishing into: ${hosts.map((h) => h.name).join(", ")}`);
            io.out(`Tier 4 page: add to the broker's config.json, then open /ui/${designer.slot}/ on the broker:`);
            io.out(`  "www": { "mounts": [{ "urlPrefix": "/ui/${designer.slot}", "dir": ${JSON.stringify(DESIGNER_UI_DIR)} }] }`);
            io.out("  and list the broker's own origin in allowedOrigins.");
            return { code: 0, host: designer };
        }
        default:
            io.err(USAGE);
            return { code: command ? 2 : 0 };
    }
}

/** `serve` re-launches itself with the flag: it cannot be turned on from inside a running process. */
function relaunchWithoutCodegen(): boolean {
    if (process.argv[2] !== "serve" || process.execArgv.includes(NO_CODEGEN) || process.env.MCP_OPEN_API_ALLOW_CODE_GENERATION === "1") return false;
    const child = spawn(process.execPath, [NO_CODEGEN, ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return true;
}

export async function main(): Promise<void> {
    if (relaunchWithoutCodegen()) return;
    const { code, host } = await run(process.argv.slice(2));
    if (!host || code !== 0) {
        await host?.stop();
        process.exitCode = code;
        return;
    }
    const stop = (): void => void host.stop().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}
