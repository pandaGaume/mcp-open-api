// binding-1: what a slot exposes from an OpenAPI spec, and how
export * from "./binding/binding.types";
export * from "./binding/binding.schema";

// manifest-1: the frozen plan the engine runs
export * from "./manifest/manifest.types";

// The engine: a manifest served as a broker slot, interpreted, never compiled to code
export * from "./runtime/validator";
export * from "./runtime/engine";
export * from "./runtime/behavior";
export * from "./runtime/serve";
export { HttpPool } from "./runtime/http";

// Serving a manifest from your own script, like mcp-cache or mcp-vault:
// verifyManifest, then a ManifestBehavior on a DirectTransport, then declare
// buildManifestDeclaration(manifest).
export { verifyManifest, ManifestSignatureError } from "./host/signature";
export * from "./runtime/transport";
