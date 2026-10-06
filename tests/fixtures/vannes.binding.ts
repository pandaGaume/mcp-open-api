import type { IBinding } from "@cyanmycelium/mcp-open-api";

/** The complete example of docs/binding.md, typed. A test checks the two stay identical. */
export const vannes: IBinding = {
    $schema: "https://raw.githubusercontent.com/pandaGaume/mcp-open-api/main/schemas/binding-1.schema.json",
    binding: 1,
    slot: "vannes",
    title: "North network valves",
    instructions: "Reads and controls the valves of the north network. Every opening is bounded to 0-100 %.",
    spec: { path: "specs/ot-gateway.yaml", sha256: "9f2c4e1b7a0d3c5f8e6b2a1d4c7f0e9b3a6d5c8f1e4b7a0d2c5f8e1b4a7d0c3f" },
    target: {
        baseUrl: "https://ot-gw.local/api/v2",
        auth: { secretRef: "otGateway" },
        timeoutMs: 10000,
        maxResponseBytes: 1048576,
    },
    governance: { domain: "valves", namespace: "/site/nord" },
    tools: {
        getValve: {
            name: "lire_vanne",
            description: "Reads the position (0-100 %) and state of a valve of the north network.",
            args: {
                "path.id": { name: "vanne", description: "Valve tag, e.g. V-012", pattern: "^V-\\d{3}$" },
                "query.debug": { hide: true },
            },
            output: { pick: ["id", "position", "state", "updatedAt"] },
            authorization: { capability: "valves.read", resourcePath: "valves/{path.id}" },
        },
        listValves: {
            name: "lister_vannes",
            description: "Lists the valves of the north network and their state.",
            output: { pick: ["items[].id", "items[].state"], maxItems: 50 },
            authorization: { capability: "valves.read", resourcePath: "valves" },
        },
        setValvePosition: {
            name: "ouvrir_vanne",
            description: "Sets the opening of a valve of the north network, in percent.",
            note: "Mode forced to manual: auto mode is reserved for supervision.",
            args: {
                "path.id": { name: "vanne", pattern: "^V-\\d{3}$" },
                "body.position": { name: "pourcent", minimum: 0, maximum: 100 },
                "body.mode": { fixed: "manual" },
            },
            output: { pick: ["id", "position"] },
            annotations: { idempotentHint: true, destructiveHint: false },
            authorization: {
                capability: "valves.write",
                resourcePath: "valves/{path.id}",
                value: "body.position",
                resultRequired: true,
            },
        },
    },
    resources: {
        getValve: {
            uri: "valve://nord/{path.id}",
            name: "vanne",
            output: { pick: ["id", "position", "state", "updatedAt"] },
            authorization: { capability: "valves.read", resourcePath: "valves/{path.id}" },
        },
    },
};
