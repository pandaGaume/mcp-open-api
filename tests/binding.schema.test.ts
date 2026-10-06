import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { BINDING_SCHEMA, BINDING_SCHEMA_ID, type IBinding, type IBindingTool } from "@cyanmycelium/mcp-open-api";
import { vannes } from "./fixtures/vannes.binding";

// strictRequired would reject `source`'s `oneOf: [{ required: ["path"] }, { required: ["url"] }]`,
// whose properties are declared one level up; every other strict check stays on.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
ajv.addSchema(BINDING_SCHEMA);
const validateBinding = ajv.getSchema(BINDING_SCHEMA_ID)!;
const validateTool = ajv.getSchema(`${BINDING_SCHEMA_ID}#/$defs/tool`)!;
const validateSlotExtension = ajv.getSchema(`${BINDING_SCHEMA_ID}#/$defs/slotExtension`)!;

const valid = (doc: unknown) => validateBinding(doc) || ajv.errorsText(validateBinding.errors);

/** A copy of the example with one change, for the refusal cases. */
const variant = (change: (doc: Record<string, any>) => void): unknown => {
    const doc = structuredClone(vannes) as Record<string, any>;
    change(doc);
    return doc;
};

const doc = readFileSync(fileURLToPath(new URL("../docs/binding.md", import.meta.url)), "utf8");
const jsonBlockAfter = (heading: string): unknown => {
    const section = doc.slice(doc.indexOf(heading));
    const block = /```json\n([\s\S]*?)```/.exec(section);
    return JSON.parse(block![1]);
};

describe("binding-1 schema", () => {
    it("is a valid draft 2020-12 schema whose $id matches the documented $schema", () => {
        expect(BINDING_SCHEMA_ID).toBe(vannes.$schema);
    });

    it("accepts the complete example of docs/binding.md, identical to the typed fixture", () => {
        const example = jsonBlockAfter("## Complete example");
        expect(example).toEqual(vannes);
        expect(valid(example)).toBe(true);
    });

    it("validates the Overlay extensions with the same definitions", () => {
        const overlay = jsonBlockAfter("## Overlay") as { actions: { update: { "x-mcp-tool": IBindingTool } }[] };
        expect(validateTool(overlay.actions[0].update["x-mcp-tool"])).toBe(true);

        const { $schema: _schema, spec: _spec, tools: _tools, resources: _resources, ...slot } = vannes;
        expect(validateSlotExtension(slot)).toBe(true);
    });

    it("accepts the smallest binding: nothing exposed", () => {
        const smallest: IBinding = {
            binding: 1,
            slot: "empty",
            spec: { url: "https://example.com/openapi.json", sha256: "0".repeat(64) },
            target: { baseUrl: "https://example.com" },
        };
        expect(valid(smallest)).toBe(true);
    });

    it("accepts a workflow tool in the shape the format reserves", () => {
        const doc = variant((d) => {
            d.arazzo = { path: "workflows/vannes.arazzo.yaml", sha256: "1".repeat(64) };
            d.tools.ouvertureSecurisee = {
                from: "workflow",
                name: "ouvrir_vanne_securisee",
                output: { pick: ["id", "position"] },
                authorization: { capability: "scada.valve.write", resourcePath: "valves/{inputs.vanne}" },
            };
        });
        expect(valid(doc)).toBe(true);
    });

    it.each<[string, (d: Record<string, any>) => void]>([
        ["an unknown field (principle 10)", (d) => (d.tools.getValve.args["query.debug"] = { hidde: true })],
        ["a tool without output (principle 6)", (d) => delete d.tools.listValves.output],
        ['an output other than "all" or a pick', (d) => (d.tools.listValves.output = "everything")],
        ["an empty pick", (d) => (d.tools.listValves.output = { pick: [] })],
        ["a malformed pick path", (d) => (d.tools.listValves.output = { pick: ["items[0].id"] })],
        ["a fixed value that is not hidden", (d) => (d.tools.setValvePosition.args["body.mode"] = { fixed: "manual", hide: false })],
        ["an argument location outside path, query, header, body", (d) => (d.tools.getValve.args["cookie.session"] = { hide: true })],
        ["a tool name with capitals", (d) => (d.tools.getValve.name = "LireVanne")],
        ["a tool name over 48 characters", (d) => (d.tools.getValve.name = "a".repeat(49))],
        ["a slot name reserved by the broker", (d) => (d.slot = "_all")],
        ["a spec without hash", (d) => delete d.spec.sha256],
        ["a spec with both path and url", (d) => (d.spec.url = "https://example.com/openapi.json")],
        ["a short hash", (d) => (d.spec.sha256 = "9f2c")],
        ["a secret header in target.headers", (d) => (d.target.headers = { Authorization: "Bearer x" })],
        ["a secret value instead of a reference", (d) => (d.target.auth = { secretRef: "otGateway", token: "x" })],
        ["a base URL that is not HTTP", (d) => (d.target.baseUrl = "ftp://ot-gw.local")],
        ["a capability without a domain", (d) => (d.tools.getValve.authorization.capability = "read")],
        ["an authorization without resourcePath", (d) => delete d.tools.getValve.authorization.resourcePath],
        ["a resource without uri", (d) => delete d.resources.getValve.uri],
        ["a binding version other than 1", (d) => (d.binding = 2)],
        ["an unknown tool source", (d) => (d.tools.getValve.from = "script")],
    ])("refuses %s", (_label, change) => {
        expect(validateBinding(variant(change))).toBe(false);
    });
});
