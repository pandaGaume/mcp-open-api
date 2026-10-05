// The binding-1 format: which operations of an OpenAPI spec become an MCP slot,
// and how each one is translated. The JSON Schema is schemas/binding-1.schema.json;
// the rules are in docs/binding.md.

/** Version of the binding format these types describe. */
export const BINDING_VERSION = 1;

/**
 * An operationId of the spec, or `"<METHOD> <path>"` when the spec gives none
 * (`"GET /valves/{id}"`). For a workflow tool, an Arazzo workflowId.
 */
export type OperationKey = string;

/**
 * Where an argument travels: `path.<name>`, `query.<name>`, `header.<name>`,
 * `body` (the whole body), `body.<dotted.path>`. In a workflow tool: `inputs.<name>`.
 */
export type ArgLocation = string;

/** A dotted field path into a JSON response; `[]` walks an array: `items[].id`. */
export type PickPath = string;

/** A document the compiler reads: a path relative to the binding, or a URL, and its SHA-256. */
export type IBindingSource = { readonly path: string; readonly url?: never; readonly sha256: string } | { readonly url: string; readonly path?: never; readonly sha256: string };

export interface IBindingAuth {
    /** An `upstreamSecrets` entry of the broker's security file. Never the secret itself. */
    readonly secretRef: string;
    /** The spec's `securityScheme` to apply, when it declares several. */
    readonly scheme?: string;
}

export interface IBindingTarget {
    /** Origin and prefix of the API. Must be listed in the broker's `slotDefinitions.allowedTargets`. */
    readonly baseUrl: string;
    readonly auth?: IBindingAuth;
    /** Fixed, non-secret headers. `Authorization`, `Cookie` and `Proxy-Authorization` are refused. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Per HTTP call. Default 10000. */
    readonly timeoutMs?: number;
    /** Past this size the read is cut and the call fails. Default 1048576. */
    readonly maxResponseBytes?: number;
}

export interface IBindingGovernance {
    readonly domain: string;
    readonly namespace: string;
}

/** How one argument is exposed. Restrictions may only narrow the spec's schema. */
export interface IBindingArg {
    /** Name of the argument on the MCP side. */
    readonly name?: string;
    readonly description?: string;
    /** Not exposed: takes its `fixed` value or the spec's `default`. */
    readonly hide?: boolean;
    /** Imposed value, never chosen by the caller. Implies `hide`. */
    readonly fixed?: unknown;
    readonly pattern?: string;
    readonly enum?: readonly unknown[];
    readonly minimum?: number;
    readonly maximum?: number;
    readonly maxLength?: number;
    readonly maxItems?: number;
}

/** `"all"`, or a selection of fields. Required: a response is never forwarded whole by default. */
export type BindingOutput = "all" | { readonly pick: readonly PickPath[]; readonly maxItems?: number };

export interface IBindingAnnotations {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
}

export interface IBindingAuthorization {
    /** Checked by `broker/authorize`. Must sit under `<governance.domain>.*`. */
    readonly capability: string;
    /** Relative to the namespace. Templates use argument locations: `valves/{path.id}`. */
    readonly resourcePath: string;
    /** The argument carrying the written value. The broker's limits for the resource are derived from its schema. */
    readonly value?: ArgLocation;
    /** The call's result must be reported to the broker (`broker/audit/result`). */
    readonly resultRequired?: boolean;
}

export const TOOL_SOURCES = ["operation", "workflow"] as const;
/** `workflow`: the key is an Arazzo workflowId. Reserved until workflows run. */
export type ToolSource = (typeof TOOL_SOURCES)[number];

/** One operation exposed as a tool. Also the content of an `x-mcp-tool` Overlay extension. */
export interface IBindingTool {
    readonly from?: ToolSource;
    /** `^[a-z][a-z0-9_]{0,47}$`. Default: the operationId in snake_case. */
    readonly name?: string;
    readonly title?: string;
    readonly description?: string;
    /** Why these choices. Shown to the Tier 4 operator, never sent to an MCP client. */
    readonly note?: string;
    readonly args?: Readonly<Record<ArgLocation, IBindingArg>>;
    readonly output: BindingOutput;
    readonly annotations?: IBindingAnnotations;
    /** Required for any method other than GET and HEAD (checked by the compiler). */
    readonly authorization?: IBindingAuthorization;
    readonly timeoutMs?: number;
}

/** One GET operation exposed as a resource. Also the content of an `x-mcp-resource` Overlay extension. */
export interface IBindingResource {
    /** A fixed URI, or a template whose placeholders are argument locations: `valve://nord/{path.id}`. */
    readonly uri: string;
    readonly name?: string;
    readonly title?: string;
    readonly description?: string;
    readonly note?: string;
    readonly args?: Readonly<Record<ArgLocation, IBindingArg>>;
    readonly output: BindingOutput;
    readonly authorization?: IBindingAuthorization;
    readonly timeoutMs?: number;
}

/** A binding document, format 1. */
export interface IBinding {
    readonly $schema?: string;
    readonly binding: typeof BINDING_VERSION;
    readonly slot: string;
    readonly title?: string;
    /** Returned to MCP clients at `initialize`. */
    readonly instructions?: string;
    readonly spec: IBindingSource;
    readonly target: IBindingTarget;
    /** Required as soon as a tool or resource has an `authorization` (checked by the compiler). */
    readonly governance?: IBindingGovernance;
    readonly tools?: Readonly<Record<OperationKey, IBindingTool>>;
    readonly resources?: Readonly<Record<OperationKey, IBindingResource>>;
    /** Arazzo document of the workflow tools. Reserved. */
    readonly arazzo?: IBindingSource;
}

/** `x-mcp-slot`, at the root of a spec through an Overlay: the binding's top-level fields except tools, resources and spec. */
export type IBindingSlotExtension = Omit<IBinding, "$schema" | "spec" | "tools" | "resources">;
