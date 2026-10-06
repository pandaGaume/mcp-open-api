import type { ManifestBodyAssignment, ManifestParam, ManifestValue, TemplatePart } from "../manifest/manifest.types";

export type Args = Readonly<Record<string, unknown>>;

/** A template turned into a function at load: fixed text, and argument values percent-encoded. */
export function compileTemplate(parts: readonly TemplatePart[]): (args: Args) => string {
    if (parts.every((p) => typeof p === "string")) {
        const fixed = (parts as string[]).join("");
        return () => fixed;
    }
    return (args) => {
        let out = "";
        for (const part of parts) out += typeof part === "string" ? part : encodeURIComponent(scalar(args[part.arg], part.arg));
        return out;
    };
}

/** The arguments a template reads. */
export const templateArgs = (parts: readonly TemplatePart[]): string[] => parts.filter((p): p is { arg: string } => typeof p !== "string").map((p) => p.arg);

function scalar(value: unknown, name: string): string {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new Error(`argument "${name}" must be a string, a number or a boolean to be placed in a URL`);
}

/** Reads a value from the arguments or the manifest; `undefined` when an optional argument is absent. */
const read = (v: ManifestValue, args: Args): unknown => (v.arg !== undefined ? args[v.arg] : v.value);

/** Query parameters or headers, compiled at load. Absent values are skipped; arrays repeat the parameter. */
export function compileParams(params: readonly ManifestParam[] | undefined): (args: Args) => [string, string][] {
    if (!params || params.length === 0) return () => [];
    return (args) => {
        const out: [string, string][] = [];
        for (const param of params) {
            const value = read(param, args);
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) for (const item of value) out.push([param.name, scalar(item, param.name)]);
            else out.push([param.name, scalar(value, param.name)]);
        }
        return out;
    };
}

/** RFC 6901 pointer into tokens, checked at load. */
function pointerTokens(pointer: string): string[] {
    if (pointer === "") return [];
    if (!pointer.startsWith("/")) throw new Error(`body pointer "${pointer}" must be "" or start with "/"`);
    return pointer
        .slice(1)
        .split("/")
        .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * The JSON body, compiled at load from its assignments. Returns `undefined`
 * when the manifest has no body. Fixed values are deep-copied at load, so a
 * request can never alter the manifest.
 */
export function compileBody(assignments: readonly ManifestBodyAssignment[] | undefined): (args: Args) => unknown {
    if (!assignments) return () => undefined;
    const steps = assignments.map((a) => ({ tokens: pointerTokens(a.pointer), value: a as ManifestValue, fixed: a.arg === undefined ? JSON.stringify(a.value) : undefined }));
    const whole = steps.find((s) => s.tokens.length === 0);
    if (whole && steps.length > 1) throw new Error(`a body assignment to "" must be the only one`);
    return (args) => {
        if (whole) return whole.fixed !== undefined ? JSON.parse(whole.fixed) : read(whole.value, args);
        const body: Record<string, unknown> = {};
        for (const step of steps) {
            const value = step.fixed !== undefined ? JSON.parse(step.fixed) : read(step.value, args);
            if (value === undefined) continue;
            let node = body;
            for (let i = 0; i < step.tokens.length - 1; i++) {
                const key = step.tokens[i]!;
                const next = node[key];
                node = (next !== null && typeof next === "object" ? next : (node[key] = {})) as Record<string, unknown>;
            }
            node[step.tokens[step.tokens.length - 1]!] = value;
        }
        return body;
    };
}
