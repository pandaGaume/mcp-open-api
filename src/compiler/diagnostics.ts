export type Severity = "error" | "warning";

/** One problem found while compiling. Codes are stable; messages are for people. */
export interface IDiagnostic {
    readonly code: string;
    readonly severity: Severity;
    readonly message: string;
    /** JSON Pointer (RFC 6901) into the binding. */
    readonly binding?: string;
    /** JSON Pointer into the spec. */
    readonly spec?: string;
}

/** Escapes one JSON Pointer token. */
export const token = (key: string | number): string => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

/** Builds a JSON Pointer from tokens. */
export const pointer = (...keys: readonly (string | number)[]): string => keys.map((k) => `/${token(k)}`).join("");

/** Collects diagnostics; the compiler never stops at the first. */
export class Diagnostics {
    readonly list: IDiagnostic[] = [];

    error(code: string, message: string, at: { binding?: string; spec?: string } = {}): void {
        this.list.push({ code, severity: "error", message, ...at });
    }

    warning(code: string, message: string, at: { binding?: string; spec?: string } = {}): void {
        this.list.push({ code, severity: "warning", message, ...at });
    }

    get hasErrors(): boolean {
        return this.list.some((d) => d.severity === "error");
    }

    /** How many errors were recorded so far: lets a step tell whether it added any. */
    get errorCount(): number {
        return this.list.filter((d) => d.severity === "error").length;
    }
}
