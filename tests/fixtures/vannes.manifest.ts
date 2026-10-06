import type { IManifest, IManifestTool } from "@cyanmycelium/mcp-open-api";

const vanne = { allOf: [{ type: "string" }, { pattern: "^V-\\d{3}$", maxLength: 5 }] };

/** Tools that exercise the engine's failure paths, against the fake API. */
const probe = (name: string, path: string, extra: Partial<IManifestTool> = {}): IManifestTool => ({
    name,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    http: { method: "GET", path: [path] },
    output: "all",
    ...extra,
});

/** A hand-written manifest-1 for the fake valve API: what the compiler will produce from the vannes binding. */
export function vannesManifest(baseUrl: string): IManifest {
    return {
        manifest: 1,
        slot: "vannes",
        title: "Vannes du réseau Nord",
        compiler: "hand-written",
        provenance: { binding: "c41e0000", spec: "9f2c0000" },
        target: { baseUrl, auth: { kind: "bearer", secretRef: "otGateway" }, timeoutMs: 2000, maxResponseBytes: 1048576 },
        declaration: {
            domain: "valves",
            namespace: "/site/nord",
            capabilities: ["valves.read", "valves.write"],
            resources: [
                { resource: "valves:/site/nord/valves/V-012", resourcePath: "valves/V-012", limits: { minValue: 0, maxValue: 40 } },
                // Broker 1.7.0: the V-1xx series is capped at 60 %, whatever its number.
                { resourcePattern: "valves/{id}", where: { id: "V-1\\d{2}" }, limits: { maxValue: 60 } },
            ],
            resultsRequired: ["valves.write"],
        },
        tools: [
            {
                name: "lire_vanne",
                description: "Lit la position (0-100 %) et l'état d'une vanne du réseau Nord.",
                inputSchema: { type: "object", additionalProperties: false, required: ["vanne"], properties: { vanne } },
                outputSchema: { type: "object", properties: { id: { type: "string" }, position: { type: "number" }, state: { type: "string" } } },
                annotations: { readOnlyHint: true },
                http: { method: "GET", path: ["/valves/", { arg: "vanne" }] },
                output: { pick: ["id", "position", "state"] },
                authorization: { capability: "valves.read", resourcePath: ["valves/", { arg: "vanne" }] },
            },
            {
                name: "lister_vannes",
                inputSchema: { type: "object", additionalProperties: false, properties: {} },
                http: { method: "GET", path: ["/valves"] },
                output: { pick: ["items[].id", "items[].state"], maxItems: 50 },
                authorization: { capability: "valves.read", resourcePath: ["valves"] },
            },
            {
                name: "ouvrir_vanne",
                description: "Fixe l'ouverture d'une vanne du réseau Nord, en pourcentage.",
                inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["vanne", "pourcent"],
                    properties: {
                        vanne,
                        pourcent: {
                            allOf: [
                                { type: "number", minimum: 0, maximum: 150 },
                                { minimum: 0, maximum: 100 },
                            ],
                        },
                    },
                },
                annotations: { idempotentHint: true, destructiveHint: false },
                http: {
                    method: "PUT",
                    path: ["/valves/", { arg: "vanne" }, "/position"],
                    body: [
                        { pointer: "/position", arg: "pourcent" },
                        { pointer: "/mode", value: "manual" },
                    ],
                },
                output: { pick: ["id", "position"] },
                authorization: { capability: "valves.write", resourcePath: ["valves/", { arg: "vanne" }], value: "pourcent", resultRequired: true },
            },
            probe("grosse_reponse", "/big"),
            probe("lente", "/slow", { timeoutMs: 200 }),
            probe("redirigee", "/moved"),
            probe("en_panne", "/broken"),
        ],
    };
}

/** The same API under another slot and its own domain, served by the same identity. */
export function pompesManifest(baseUrl: string): IManifest {
    const vannes = vannesManifest(baseUrl);
    return {
        ...vannes,
        slot: "pompes",
        declaration: { domain: "pumps", namespace: "/site/nord", capabilities: ["pumps.read"] },
        tools: [{ ...vannes.tools[0]!, name: "lire_pompe", authorization: { capability: "pumps.read", resourcePath: ["pumps/", { arg: "vanne" }] } }],
    };
}
