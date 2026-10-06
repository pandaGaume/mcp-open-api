# The binding: the `binding-1` format

The binding says which operations of an OpenAPI spec become an MCP slot, and how each one is translated. It is the only file you write. The mcp-open-api compiler combines it with the spec to produce the **manifest**: the frozen artifact that the Tier 4 operator validates, that the broker hashes and that it executes.

```text
OpenAPI spec (JSON or YAML) ──┐
binding (JSON)            ────┼──> compiler ──> manifest (JSON, frozen) ──> Tier 4 ──> broker
Overlay x-mcp-* (optional)────┤
Arazzo (reserved)         ────┘
```

Status: version 1 of the format. The schema (`schemas/binding-1.schema.json`), the types and the compiler are implemented; the Overlay, Arazzo and resources are refused by the compiler as long as they are not, with a diagnostic that says so.

## Principles

1. **Deny by default.** An operation absent from `tools` and from `resources` does not exist in the slot. There is no selection by pattern (`*`, tag, path prefix): adding an operation means writing its key.
2. **Key = the operation, not the tool.** An entry is indexed by the spec's `operationId`, or by `"<METHOD> <path>"` when the spec does not provide one (`"GET /valves/{id}"`). Renaming a tool breaks nothing, and an operation that disappears from the spec is reported by its key.
3. **Each argument is addressed by its HTTP location**: `path.id`, `query.limit`, `header.X-Site`, `body.position`, `body.config.mode`. The same addressing is used everywhere: `args`, `resourcePath`, `authorization.value`.
4. **Restrict, never widen, by construction.** The binding's restrictions (`pattern`, `enum`, `minimum`, `maximum`, `maxLength`, `maxItems`) do not replace the spec's schema: the compiler **composes** them with it (`allOf`). A value must satisfy both, so a `maximum: 200` where the spec says 100 stays bounded to 100. The compiler only reports contradictions (no possible value left) and `enum` values that are invalid for the spec. See [compiler.md](compiler.md).
5. **Nothing hidden without a value.** An argument required by the spec and hidden (`hide`) must receive a `fixed` value, or have a `default` in the spec.
6. **Explicit output.** Each tool declares its output: a selection of fields (`pick`), or `"all"` spelled out. Responses are the primary cost on the agent side and the primary risk of leakage.
7. **No code.** Locations, fixed values, restrictions, field selections. The only expressions allowed are Arazzo's, and only in workflows.
8. **No secrets.** `secretRef` is a name; the mcp-open-api host that serves the slot resolves it in its own config (`secrets`), never in the binding or the manifest.
9. **Deterministic compilation.** The same spec, the same binding and the same compiler version give the same manifest, byte for byte.
10. **Unknown fields refused.** A typo (`"hidde": true`) is an error, not an ignored setting.

## Structure

```json
{
    "$schema": "https://raw.githubusercontent.com/pandaGaume/mcp-open-api/main/schemas/binding-1.schema.json",
    "binding": 1,
    "slot": "vannes",
    "title": "North network valves",
    "instructions": "Reads and controls the valves of the north network. Every opening is bounded to 0-100 %.",
    "spec": { "path": "specs/ot-gateway.yaml", "sha256": "9f2c…" },
    "target": { "baseUrl": "https://ot-gw.local/api/v2", "auth": { "secretRef": "otGateway" }, "timeoutMs": 10000, "maxResponseBytes": 1048576 },
    "governance": { "domain": "valves", "namespace": "/site/nord" },
    "tools": { "…": {} },
    "resources": { "…": {} },
    "arazzo": { "path": "workflows/vannes.arazzo.yaml", "sha256": "41ab…" }
}
```

| field | required | role |
| --- | --- | --- |
| `$schema` | no | completion and validation in the editor |
| `binding` | yes | format version, `1` |
| `slot` | yes | name of the published slot |
| `title` | no | title of the MCP server (`serverInfo.title`) |
| `instructions` | no | instructions of the MCP server, returned at `initialize` |
| `spec` | yes | the source spec: `path` (relative to the binding) or `url`, and its `sha256` |
| `target` | yes | where and how to call the API |
| `governance` | if a tool has an `authorization` | `domain` and `namespace` declared to the broker. The domain is **the slot's own**: the resources it governs are qualified names `<domain>:<path>`, and `valves:/site/nord/**` is not `scada:/site/nord/**`. A domain has only one owner: a slot never declares another provider's domain |
| `tools` | no | the operations exposed as tools, by operation key |
| `resources` | no | the `GET` operations exposed as resources, by operation key |
| `arazzo` | no | Arazzo document of the workflows (reserved, see below) |

A binding covers **one** spec and **one** slot.

### `target`

| field | required | default | role |
| --- | --- | --- | --- |
| `baseUrl` | yes | | origin and prefix of the API; its origin must appear in the `allowedTargets` of the host that serves the slot. The spec's `servers[]` is never used as is |
| `auth.secretRef` | no | | name of the secret, resolved by the host in its config (`secrets`) |
| `auth.scheme` | no | the spec's only `securityScheme` | name of the `securityScheme` to apply when the spec declares several |
| `headers` | no | | fixed, non-secret headers (`"Accept-Language": "fr"`) |
| `timeoutMs` | no | 10000 | timeout per HTTP call |
| `maxResponseBytes` | no | 1048576 | beyond this, reading is cut off and the call fails |

## Tools: `tools`

```json
"setValvePosition": {
    "name": "ouvrir_vanne",
    "description": "Sets the opening of a valve of the north network, in percent.",
    "note": "Mode forced to manual: auto mode is reserved for supervision.",
    "args": {
        "path.id": { "name": "vanne", "pattern": "^V-\\d{3}$" },
        "body.position": { "name": "pourcent", "minimum": 0, "maximum": 100 },
        "body.mode": { "fixed": "manual" },
        "query.debug": { "hide": true }
    },
    "output": { "pick": ["id", "position"] },
    "annotations": { "idempotentHint": true, "destructiveHint": false },
    "authorization": {
        "capability": "valves.write",
        "resourcePath": "valves/{path.id}",
        "value": "body.position",
        "resultRequired": true
    }
}
```

| field | default | role |
| --- | --- | --- |
| `name` | `operationId` in snake_case | name of the tool: `^[a-z][a-z0-9_]{0,47}$`, 48 characters to leave room for the `_all` prefix |
| `title` | the spec's `summary` | displayed title |
| `description` | `summary`, then the spec's `description` | text read by the LLM; 2,000 characters at most |
| `note` | | why these choices were made; shown to Tier 4, never sent to the MCP client |
| `args` | all the spec's parameters, under their names | see below |
| `output` | **none: required** | see below |
| `annotations` | deduced from the method | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| `authorization` | none | see below; required for any method other than `GET` and `HEAD` |
| `timeoutMs` | the one from `target` | timeout specific to this tool |

### `args`

Each key is a location: `path.<name>`, `query.<name>`, `header.<name>`, `body` (entire body), `body.<path>` (body property, dotted path). A location absent from `args` is exposed as the spec describes it.

| field | role |
| --- | --- |
| `name` | name of the argument on the MCP side |
| `description` | replaces the spec's description |
| `hide` | the argument is not exposed; it takes its `fixed` value or its `default` |
| `fixed` | imposed value, never chosen by the caller; implies `hide` |
| `pattern`, `enum`, `minimum`, `maximum`, `maxLength`, `maxItems` | restrictions, composed with the spec's schema (`allOf`): they can only tighten |

Default naming rules:

- a `path`, `query` or `header` parameter keeps its name;
- a JSON object body is flattened at the first level: `body.position` becomes the argument `position`;
- a body that is not an object becomes a single argument, `body`;
- two locations that would give the same name (`path.id` and `query.id`) are an **error**: the binding must rename one of them;
- the `Authorization` and `Cookie` headers, and those set by `target.auth`, are never exposed.

Bodies accepted in version 1: `application/json` only. An operation whose body is `multipart/form-data` or `application/octet-stream` is refused by the compiler.

### `output`

| form | effect |
| --- | --- |
| `"all"` | the entire JSON response, as `structuredContent` and as text |
| `{ "pick": [...] }` | only these fields, dotted paths; `[]` walks an array: `"items[].id"` |
| `{ "pick": [...], "maxItems": 20 }` | in addition, arrays are cut to 20 elements, and the total count is indicated |

The compiler derives the MCP `outputSchema` from the spec's first 2xx response, reduced to `pick`. A `pick` path absent from the response schema is an error.

A 4xx or 5xx response gives `isError: true` with the HTTP status. If the body is a *problem details* ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)), its `title` and its `detail` are passed through. Otherwise, the body is not returned: an error page can contain anything.

### Default `annotations`

| method | annotations |
| --- | --- |
| `GET`, `HEAD` | `readOnlyHint: true` |
| `PUT` | `idempotentHint: true` |
| `DELETE` | `destructiveHint: true`, `idempotentHint: true` |
| `POST`, `PATCH` | none; the compiler warns as long as the binding does not set any |

### `authorization`

| field | role |
| --- | --- |
| `capability` | capability checked by `broker/authorize`; must be under `<governance.domain>.*` |
| `resourcePath` | resource path, relative to the `namespace`; templates use the `args` addressing: `valves/{path.id}` |
| `value` | the argument that carries the written value. An `allow-with-constraints` decision applies to this argument. The limits declared to the broker for the `resourcePath` template are **deduced from its schema** (`minimum` and `maximum` give `minValue` and `maxValue`, `enum` gives `allowedValues`) and declared by pattern (broker 1.7.0 or later), see compiler.md |
| `resultRequired` | the result of the call must be reported to the broker (`broker/audit/result`) |

The compiler produces the slot's declaration from all the entries: one capability per distinct capability, one resource per `resourcePath` template, with its limits.

## Resources: `resources`

A `GET` operation without a body can be exposed as an MCP resource rather than as a tool.

```json
"getValve": {
    "uri": "valve://nord/{path.id}",
    "name": "vanne",
    "description": "State of a valve of the north network.",
    "output": { "pick": ["id", "position", "state", "updatedAt"] },
    "authorization": { "capability": "valves.read", "resourcePath": "valves/{path.id}" }
}
```

A templated `uri` becomes a *resource template*; without a template, a fixed resource. The template's arguments must cover all of the operation's required parameters. Subscriptions (`resources/subscribe`) go through the broker as for any provider; in version 1, mcp-open-api does not poll the API to feed them.

The same operation can appear in both `tools` and `resources`.

## Overlay: the same thing, in the spec

An [Overlay 1.0](https://spec.openapis.org/overlay/v1.0.0.html) can carry the binding in the form of extensions. The content is **exactly the same object**:

| extension | where | content |
| --- | --- | --- |
| `x-mcp-slot` | root of the spec | the binding's top-level fields, except `tools`, `resources` and `spec` |
| `x-mcp-tool` | an operation | an entry of `tools` |
| `x-mcp-resource` | an operation | an entry of `resources` |

```json
{
    "overlay": "1.0.0",
    "info": { "title": "Valves binding", "version": "1" },
    "extends": "specs/ot-gateway.yaml",
    "actions": [
        {
            "target": "$.paths['/valves/{id}'].get",
            "update": {
                "x-mcp-tool": {
                    "name": "lire_vanne",
                    "args": { "path.id": { "name": "vanne", "pattern": "^V-\\d{3}$" } },
                    "output": { "pick": ["id", "position", "state"] },
                    "authorization": { "capability": "valves.read", "resourcePath": "valves/{path.id}" }
                }
            }
        }
    ]
}
```

The compiler applies the Overlay, then reduces the result to a binding: it keeps **only** the operations that carry `x-mcp-tool` or `x-mcp-resource`, which preserves deny by default. It then compares the spec before and after the Overlay, and refuses any schema widened by an `update` action.

The designer can also produce an Overlay from a binding, for the team that maintains the spec. The round trip is lossless.

## Arazzo: workflows (reserved)

From version 1, the format reserves the place for multi-call tools. Their execution will come with the "multi-step tools" work package.

```json
"arazzo": { "path": "workflows/vannes.arazzo.yaml", "sha256": "41ab…" },
"tools": {
    "ouvertureSecurisee": {
        "from": "workflow",
        "name": "ouvrir_vanne_securisee",
        "description": "Checks that the valve is not locked, then sets its opening.",
        "output": { "pick": ["id", "position"] },
        "authorization": { "capability": "valves.write", "resourcePath": "valves/{inputs.vanne}" }
    }
}
```

The key is the `workflowId`. The workflow's inputs give the tool's input schema, its outputs the `structuredContent`. Templates address the inputs by `inputs.<name>`.

Rules:

- each step calls an operation that the binding also declares in `tools`, with its restrictions: a workflow reaches nothing that the binding does not expose;
- all authorizations (the workflow's and each step's) are checked **before** the first step;
- the runtime bounds the number of steps executed (20 by default) and the `retry`s, because `goto` allows loops;
- there is no transaction: a workflow that writes is flagged "non-atomic" on the Tier 4 page;
- Arazzo expressions (`$inputs`, `$steps`, `$response`) are allowed here, and nowhere else in the binding.

As long as execution does not exist, the compiler refuses `from: "workflow"` with a message that says so.

## Compilation

The compiler reads the spec, applies the Overlay if any, checks the spec's `sha256`, then produces the manifest and its fingerprint. It returns **all** errors, not just the first one.

Errors:

- the spec's `sha256` differs from the binding's;
- operation key not found in the spec;
- `args` location not found in the operation;
- restriction that contradicts the spec (no possible value left), or `enum` value invalid for the spec;
- required argument hidden without `fixed` or `default`;
- two arguments with the same name, or an invalid or duplicate tool name;
- `output` missing, or `pick` path absent from the response schema;
- method other than `GET` or `HEAD` without `authorization`;
- capability outside `<domain>.*`, `resourcePath` template that targets a nonexistent argument;
- `value` that does not target a numeric or enumerated argument;
- body of a type other than `application/json`;
- unknown field;
- `from: "workflow"` as long as execution does not exist.

Warnings:

- `POST` or `PATCH` without annotations;
- empty description, or one taken from the spec without any edit;
- more than 40 tools (cap configurable on the broker side);
- `output: "all"` on a response whose schema exceeds 20 properties or contains an array without `maxItems`.

The manifest contains everything needed to execute without the spec or the binding: resolved input and output schemas, explicit HTTP calls (method, path template, placement of each argument, fixed values), output selections, annotations, authorization declaration, and the compiler version. This is the document that the Tier 4 page shows and that the broker publishes.

## Complete example

```json
{
    "$schema": "https://raw.githubusercontent.com/pandaGaume/mcp-open-api/main/schemas/binding-1.schema.json",
    "binding": 1,
    "slot": "vannes",
    "title": "North network valves",
    "instructions": "Reads and controls the valves of the north network. Every opening is bounded to 0-100 %.",
    "spec": { "path": "specs/ot-gateway.yaml", "sha256": "9f2c4e1b7a0d3c5f8e6b2a1d4c7f0e9b3a6d5c8f1e4b7a0d2c5f8e1b4a7d0c3f" },
    "target": {
        "baseUrl": "https://ot-gw.local/api/v2",
        "auth": { "secretRef": "otGateway" },
        "timeoutMs": 10000,
        "maxResponseBytes": 1048576
    },
    "governance": { "domain": "valves", "namespace": "/site/nord" },
    "tools": {
        "getValve": {
            "name": "lire_vanne",
            "description": "Reads the position (0-100 %) and state of a valve of the north network.",
            "args": {
                "path.id": { "name": "vanne", "description": "Valve tag, e.g. V-012", "pattern": "^V-\\d{3}$" },
                "query.debug": { "hide": true }
            },
            "output": { "pick": ["id", "position", "state", "updatedAt"] },
            "authorization": { "capability": "valves.read", "resourcePath": "valves/{path.id}" }
        },
        "listValves": {
            "name": "lister_vannes",
            "description": "Lists the valves of the north network and their state.",
            "output": { "pick": ["items[].id", "items[].state"], "maxItems": 50 },
            "authorization": { "capability": "valves.read", "resourcePath": "valves" }
        },
        "setValvePosition": {
            "name": "ouvrir_vanne",
            "description": "Sets the opening of a valve of the north network, in percent.",
            "note": "Mode forced to manual: auto mode is reserved for supervision.",
            "args": {
                "path.id": { "name": "vanne", "pattern": "^V-\\d{3}$" },
                "body.position": { "name": "pourcent", "minimum": 0, "maximum": 100 },
                "body.mode": { "fixed": "manual" }
            },
            "output": { "pick": ["id", "position"] },
            "annotations": { "idempotentHint": true, "destructiveHint": false },
            "authorization": {
                "capability": "valves.write",
                "resourcePath": "valves/{path.id}",
                "value": "body.position",
                "resultRequired": true
            }
        }
    },
    "resources": {
        "getValve": {
            "uri": "valve://nord/{path.id}",
            "name": "vanne",
            "output": { "pick": ["id", "position", "state", "updatedAt"] },
            "authorization": { "capability": "valves.read", "resourcePath": "valves/{path.id}" }
        }
    }
}
```

## Decisions

| question | decision |
| --- | --- |
| binding format | JSON, with `$schema`; `note` replaces comments and is part of the review |
| spec and Overlay format | JSON or YAML: these are not our formats |
| `resourcePath` templates | addressing by location (`{path.id}`), independent of renamings |
| default output | none: `output` is required, `"all"` is written explicitly |
| governance limits | deduced from the schema of the argument designated by `authorization.value`, declared by pattern (broker 1.7.0 or later) |
| domain | specific to the slot, never another provider's: a governed resource is a qualified name `<domain>:<path>` |
| several specs per binding | no: one spec, one binding, one slot |
| Overlay | as input and as output, exact equivalence with `x-mcp-tool` and `x-mcp-resource` |
| Arazzo | reserved in the format from version 1, executed in the "multi-step tools" work package |

## Open questions

- **Pagination.** Should there be a field that describes an operation's pagination (cursor, page, `Link`), so that the runtime follows pages up to `maxItems`? In version 1, the cursor is an ordinary argument.
- **Several 2xx responses.** An operation that responds 200 or 202 with different schemas: do we take the first one, or require the binding to choose?
- **Collisions with `_all`.** The `_all` prefix is added by the broker. Should the compiler check the final length `<slot>-<name>` rather than the name alone?
