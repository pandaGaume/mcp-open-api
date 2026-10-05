import schema from "../../schemas/binding-1.schema.json" with { type: "json" };

/**
 * The JSON Schema (draft 2020-12) of the binding-1 format. Its `$defs` also
 * validate the Overlay extensions: `tool` for `x-mcp-tool`, `resource` for
 * `x-mcp-resource`, `slotExtension` for `x-mcp-slot`.
 *
 * It checks the shape only. Whatever needs the spec (narrowing, unknown
 * operations, name collisions, authorization on write methods) is the
 * compiler's job.
 */
export const BINDING_SCHEMA: Readonly<Record<string, unknown>> = schema;

/** `$id` of {@link BINDING_SCHEMA}, also the `$schema` a binding document may carry. */
export const BINDING_SCHEMA_ID = schema.$id;
