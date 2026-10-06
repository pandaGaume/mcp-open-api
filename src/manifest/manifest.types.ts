// The manifest-1 format: what the compiler produces, the Tier 4 operator
// approves, and the engine runs. An execution plan in MCP names, after
// renaming; it needs neither the spec nor the binding. See docs/compiler.md.

/** Version of the manifest format these types describe. */
export const MANIFEST_VERSION = 1;

/** A piece of a template: fixed text, or the value of an MCP argument. */
export type TemplatePart = string | { readonly arg: string };

/** One value placed in a request: the value of an argument, or a fixed value. Exactly one of `arg` and `value`. */
export type ManifestValue = { readonly arg: string; readonly value?: never } | { readonly value: unknown; readonly arg?: never };

/** A query parameter or a header. */
export type ManifestParam = { readonly name: string } & ManifestValue;

/** A value placed in the JSON body, at a JSON Pointer (RFC 6901). `""` is the whole body. */
export type ManifestBodyAssignment = { readonly pointer: string } & ManifestValue;

export const HTTP_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface IManifestHttp {
    readonly method: HttpMethod;
    /** Appended to `target.baseUrl`; argument values are percent-encoded. */
    readonly path: readonly TemplatePart[];
    readonly query?: readonly ManifestParam[];
    readonly headers?: readonly ManifestParam[];
    /** Absent: no body. Assignments to absent optional arguments are skipped. */
    readonly body?: readonly ManifestBodyAssignment[];
}

/** `"all"`, or the fields to keep; `[]` walks an array: `items[].id`. */
export type ManifestOutput = "all" | { readonly pick: readonly string[]; readonly maxItems?: number };

export interface IManifestAuthorization {
    readonly capability: string;
    /** Relative to `declaration.namespace`; argument values are percent-encoded. */
    readonly resourcePath: readonly TemplatePart[];
    /** The argument carrying the written value: the decision's constraints apply to it. */
    readonly value?: string;
    readonly resultRequired?: boolean;
}

export interface IManifestTool {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    /** Composed from the spec and the binding; only the keywords the engine's validator knows. */
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
    readonly http: IManifestHttp;
    readonly output: ManifestOutput;
    readonly authorization?: IManifestAuthorization;
    readonly timeoutMs?: number;
}

export type ManifestAuth =
    | { readonly kind: "bearer"; readonly secretRef: string }
    | { readonly kind: "basic"; readonly secretRef: string }
    | { readonly kind: "apiKey"; readonly secretRef: string; readonly in: "header" | "query"; readonly name: string };

export interface IManifestTarget {
    readonly baseUrl: string;
    readonly auth?: ManifestAuth;
    /** Fixed, non-secret headers. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
}

export interface IManifestLimits {
    readonly minValue?: number;
    readonly maxValue?: number;
    readonly allowedValues?: readonly (string | number | boolean | null)[];
}

/** A concrete resource declared to the broker, with its engineering limits. */
export interface IManifestConcreteResource {
    /** The qualified native id: `<domain>:<path>`. */
    readonly resource: string;
    /** Relative to the namespace. */
    readonly resourcePath: string;
    readonly limits?: IManifestLimits;
}

/**
 * Limits for every resource matching a pattern (broker 1.7.0): literal
 * segments, `*`, a final `**`, and named `{segment}`s that `where` constrains
 * with RE2, matching the whole segment.
 */
export interface IManifestResourcePattern {
    /** Relative to the namespace: `valves/{id}`. */
    readonly resourcePattern: string;
    readonly where?: Readonly<Record<string, string>>;
    readonly limits: IManifestLimits;
}

export type IManifestDeclaredResource = IManifestConcreteResource | IManifestResourcePattern;

export interface IManifestDeclaration {
    readonly domain: string;
    /** A broker resource path: `/site1/nord`. */
    readonly namespace: string;
    readonly capabilities: readonly string[];
    readonly resources?: readonly IManifestDeclaredResource[];
    readonly resultsRequired?: readonly string[];
}

export interface IManifest {
    readonly manifest: typeof MANIFEST_VERSION;
    readonly slot: string;
    readonly title?: string;
    readonly instructions?: string;
    /** Package and version of the compiler that produced it. */
    readonly compiler: string;
    readonly provenance: { readonly binding: string; readonly spec: string };
    readonly target: IManifestTarget;
    readonly declaration?: IManifestDeclaration;
    readonly tools: readonly IManifestTool[];
}
