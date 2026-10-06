import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IBinding } from "@cyanmycelium/mcp-open-api";
import { sha256 } from "@cyanmycelium/mcp-open-api/compiler";

export const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
export const valveSpec = fixture("valve.openapi.json");

/** The vannes binding, against the OpenAPI description of the fake valve API. */
export function valveBinding(baseUrl: string, spec = valveSpec): IBinding {
    return {
        binding: 1,
        slot: "vannes",
        title: "Vannes du réseau Nord",
        spec: { path: "valve.openapi.json", sha256: sha256(spec) },
        target: { baseUrl, auth: { secretRef: "otGateway" } },
        governance: { domain: "valves", namespace: "/site/nord" },
        tools: {
            getValve: {
                name: "lire_vanne",
                description: "Lit la position (0-100 %) et l'état d'une vanne du réseau Nord.",
                args: { "path.id": { name: "vanne", pattern: "^V-\\d{3}$" }, "query.debug": { hide: true } },
                output: { pick: ["id", "position", "state", "updatedAt"] },
                authorization: { capability: "valves.read", resourcePath: "valves/{path.id}" },
            },
            listValves: {
                name: "lister_vannes",
                description: "Liste les vannes du réseau Nord et leur état.",
                output: { pick: ["items[].id", "items[].state"], maxItems: 50 },
                authorization: { capability: "valves.read", resourcePath: "valves" },
            },
            setValvePosition: {
                name: "ouvrir_vanne",
                description: "Fixe l'ouverture d'une vanne du réseau Nord, en pourcentage.",
                args: {
                    "path.id": { name: "vanne", pattern: "^V-\\d{3}$" },
                    "body.position": { name: "pourcent", minimum: 0, maximum: 100 },
                    "body.mode": { fixed: "manual" },
                },
                output: { pick: ["id", "position"] },
                annotations: { idempotentHint: true, destructiveHint: false },
                authorization: { capability: "valves.write", resourcePath: "valves/{path.id}", value: "body.position", resultRequired: true },
            },
        },
    };
}

/** Another API, served by another host: same spec, its own slot, domain and secret. */
export function pumpBinding(baseUrl: string): IBinding {
    return {
        binding: 1,
        slot: "pompes",
        spec: { path: "valve.openapi.json", sha256: sha256(valveSpec) },
        target: { baseUrl, auth: { secretRef: "pumpGateway" } },
        governance: { domain: "pumps", namespace: "/site/nord" },
        tools: {
            getValve: {
                name: "lire_pompe",
                description: "Lit l'état d'une pompe.",
                args: { "path.id": { name: "pompe", pattern: "^V-\\d{3}$" }, "query.debug": { hide: true } },
                output: { pick: ["id", "state"] },
                authorization: { capability: "pumps.read", resourcePath: "pumps/{path.id}" },
            },
        },
    };
}
