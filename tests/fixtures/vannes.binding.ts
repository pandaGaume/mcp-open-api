import type { IBinding } from "@cyanmycelium/mcp-open-api";

/** The complete example of docs/binding.md, typed. A test checks the two stay identical. */
export const vannes: IBinding = {
    $schema: "https://raw.githubusercontent.com/pandaGaume/mcp-open-api/main/schemas/binding-1.schema.json",
    binding: 1,
    slot: "vannes",
    title: "Vannes du réseau Nord",
    instructions: "Lecture et commande des vannes du réseau Nord. Toute ouverture est bornée à 0-100 %.",
    spec: { path: "specs/ot-gateway.yaml", sha256: "9f2c4e1b7a0d3c5f8e6b2a1d4c7f0e9b3a6d5c8f1e4b7a0d2c5f8e1b4a7d0c3f" },
    target: {
        baseUrl: "https://ot-gw.local/api/v2",
        auth: { secretRef: "otGateway" },
        timeoutMs: 10000,
        maxResponseBytes: 1048576,
    },
    governance: { domain: "scada", namespace: "nord" },
    tools: {
        getValve: {
            name: "lire_vanne",
            description: "Lit la position (0-100 %) et l'état d'une vanne du réseau Nord.",
            args: {
                "path.id": { name: "vanne", description: "Repère de la vanne, ex. V-012", pattern: "^V-\\d{3}$" },
                "query.debug": { hide: true },
            },
            output: { pick: ["id", "position", "state", "updatedAt"] },
            authorization: { capability: "scada.valve.read", resourcePath: "valves/{path.id}" },
        },
        listValves: {
            name: "lister_vannes",
            description: "Liste les vannes du réseau Nord et leur état.",
            output: { pick: ["items[].id", "items[].state"], maxItems: 50 },
            authorization: { capability: "scada.valve.read", resourcePath: "valves" },
        },
        setValvePosition: {
            name: "ouvrir_vanne",
            description: "Fixe l'ouverture d'une vanne du réseau Nord, en pourcentage.",
            note: "Mode forcé à manual : le mode auto est réservé à la supervision.",
            args: {
                "path.id": { name: "vanne", pattern: "^V-\\d{3}$" },
                "body.position": { name: "pourcent", minimum: 0, maximum: 100 },
                "body.mode": { fixed: "manual" },
            },
            output: { pick: ["id", "position"] },
            annotations: { idempotentHint: true, destructiveHint: false },
            authorization: {
                capability: "scada.valve.write",
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
            authorization: { capability: "scada.valve.read", resourcePath: "valves/{path.id}" },
        },
    },
};
