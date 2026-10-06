import { createHash } from "node:crypto";

/**
 * JSON canonical form (RFC 8785, JCS): object keys sorted by UTF-16 code
 * units, no whitespace, numbers and strings as ECMAScript serializes them.
 * Two equal documents give the same bytes, hence the same hash.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON cannot hold a non-finite number");
        if (value === undefined) throw new Error("canonical JSON cannot hold undefined");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256, lowercase hex. */
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
