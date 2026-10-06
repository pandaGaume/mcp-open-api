// The host: serves signed manifests as broker slots, from its own process.
// Run one host per API: each sees only its API's secrets, and a slow or
// heavy API weighs on its own process only.
export * from "./host";
export * from "./signature";
