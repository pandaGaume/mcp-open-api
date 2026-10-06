# The compiler and execution

The compiler turns a binding and its spec into a **manifest**: a frozen execution plan, which the Tier 4 operator approves and which an **mcp-open-api host** executes as a broker slot. This document describes compilation, the manifest format, its execution by the host, and how what runs is certified.

The manifest is an mcp-open-api format: the broker does not know it. To the broker, a host is a provider like any other, which publishes slots and declares its domains.

The binding format is in [binding.md](binding.md).

**Status (2026-10-06).** Implemented: the compiler (`src/compiler/`, entry point `@cyanmycelium/mcp-open-api/compiler`), the engine (`src/runtime/`), the host and manifest signing (`src/host/`, entry point `@cyanmycelium/mcp-open-api/host`), and the CLI (`mcp-open-api compile | keygen | sign | serve`). The manifest compiled from the OpenAPI spec of the test valve API, signed, is served by a host behind a real 1.7.0 broker and behaves like the handwritten manifest (`tests/compiler.test.ts`, `tests/host.test.ts`, `scripts/serve-check.mjs`). Not yet: the Overlay, Arazzo, MCP resources, secrets read from mcp-vault, the second `.mcpb` output.

Limits of version 1 of the compiler, each reported by a diagnostic, never silently ignored:

- validation keywords the engine does not check yet: `multipleOf`, `uniqueItems`, `minProperties`, `maxProperties`, `patternProperties`, `propertyNames`, `dependentRequired`, `if` / `then` / `else`, `not`, `prefixItems`, `contains`, `unevaluated*`. Removing them would widen the schema: it is an error (`schema.unsupported-keyword`);
- parameters: default styles only (`simple` for the path and headers, exploded `form` for the query), no object in the query, no parameter described by `content`, no required cookie;
- body: JSON only; a nested value (`body.a.b`) can only be fixed;
- authentication: `bearer`, `basic`, `apiKey` in a header or in the query; not yet OAuth 2 or OpenID Connect;
- the keywords `format`, `xml`, `example`, `discriminator`, `readOnly`, `writeOnly` are removed: they are annotations. A `readOnly` property leaves the input schema, a `writeOnly` property leaves the output schema.

The canonical form sorts object keys: the properties of an `inputSchema` come out in alphabetical order, not in the order of the spec. The order of `required`, an array, is preserved.

## In one sentence

We compile data (the manifest) **at design time**, never code; an mcp-open-api host **interprets** it with fixed code, shipped and signed with the package, and publishes each manifest to the broker as a slot; the operator approves a hash that anyone can recompute.

```text
                     design time                                mcp-open-api host (one process per API)       broker
binding.json ─┐                                 ┌──────────────────────────────────────────────────────┐
spec (bytes)  ┼─> compiler ─> manifest ─> Tier 4 ─> signature ─> verification ─> closures ─> provider ──> slot
Overlay ──────┘   (pure function)  + sha256 approves             at load         (no generated code)
```

## Compilation

### A pure function

```ts
compile({ binding, spec, overlay? }): { manifest, sha256, diagnostics }
```

- `spec` is given as **bytes**, not as a URL: the compiler makes no network access. The designer or the CLI fetches the spec; the compiler sees only what it is given.
- No clock, no randomness, no state: the same input yields the same manifest, byte for byte.
- It returns **all** diagnostics, not the first one.

### The steps

1. **Load and check.** Validate the binding against `binding-1.schema.json`. Compute the `sha256` of the raw bytes of the spec and compare it to `spec.sha256`. Read the spec as JSON or YAML, OpenAPI 3.0 or 3.1.
2. **Apply the Overlay**, if there is one: JSONPath actions ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)), then only the operations carrying `x-mcp-tool` or `x-mcp-resource` are kept and reduced to a binding.
3. **Normalize the spec.**
    - resolve internal `$ref`s; external `$ref`s are refused in version 1 (single-file spec);
    - convert OpenAPI 3.0 schemas to JSON Schema 2020-12: `nullable`, boolean `exclusiveMinimum`, `example`;
    - merge the parameters declared at the path level and at the operation level;
    - index operations by key, report duplicate `operationId`s.
4. **Translate each entry** of `tools` and `resources`:
    - **arguments**: list the locations (parameters, flattened JSON body), apply `args`, check `fixed` values against the spec's schema, duplicate names, hidden required arguments without a value;
    - **HTTP plan**: method, path split into fixed pieces and argument references, query, headers, body template mixing references and fixed values. OpenAPI serialization styles other than the defaults (`deepObject`, `pipeDelimited`...) are refused in version 1;
    - **output**: first 2xx JSON response, check of the `pick` paths, reduced `outputSchema`;
    - **authorization**: capability under the domain, `resourcePath` template that targets existing arguments, `value` on a numeric or enumerated argument, derived limits.
5. **Assemble the slot**: complete declaration for the broker (capabilities, resources and their limits, `resultsRequired`), uniqueness of names, length of names once prefixed for `_all`, tool cap.
6. **Emit** the manifest as canonical JSON ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): sorted keys, normalized numbers), tools sorted by name, without a timestamp. Its `sha256` is its identity.

### Restricting by composition, without proof

The binding can only restrict the spec's schema (principle 4 of binding.md). Proving that a restriction is narrower is easy for `minimum` or `enum`, impossible in general for `pattern`. So the compiler proves nothing: it **composes**.

```json
{ "allOf": [{ "type": "number", "minimum": 0, "maximum": 150 }, { "minimum": 0, "maximum": 100 }] }
```

The first schema comes from the spec, the second from the binding. A value must satisfy both: the binding restricts by construction. The compiler keeps only two checks: an obvious contradiction (`minimum` above `maximum`, no possible value left) is an error, and so is an `enum` value that is invalid for the spec.

### Diagnostics

```json
{ "code": "args.required-hidden", "severity": "error", "message": "body.mode is required by the spec and hidden without a fixed value", "binding": "/tools/setValvePosition/args/body.mode", "spec": "/paths/~1valves~1{id}~1position/put/requestBody" }
```

Each diagnostic carries a stable code, the severity, a message, and a JSON pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)) into the binding and, where applicable, into the spec. The Tier 4 page uses it to highlight the field at fault. The codes follow the list of errors and warnings in binding.md.

## The manifest: `manifest-1` format

The manifest speaks in MCP names, after renaming: it is an execution plan, not an editing document. It contains everything needed to execute without the spec or the binding, and only their hashes to know where it comes from.

```json
{
    "manifest": 1,
    "slot": "vannes",
    "compiler": "@cyanmycelium/mcp-open-api@0.2.0",
    "provenance": { "binding": "c41e…", "spec": "9f2c…" },
    "instructions": "Reads and controls the valves of the north network. Every opening is bounded to 0-100 %.",
    "target": { "baseUrl": "https://ot-gw.local/api/v2", "auth": { "secretRef": "otGateway", "kind": "bearer" }, "timeoutMs": 10000, "maxResponseBytes": 1048576 },
    "declaration": {
        "domain": "valves",
        "namespace": "/site/nord",
        "capabilities": ["valves.read", "valves.write"],
        "resources": [{ "resource": "valves:/site/nord/valves/V-012", "resourcePath": "valves/V-012", "limits": { "minValue": 0, "maxValue": 40 } }],
        "resultsRequired": ["valves.write"]
    },
    "tools": [
        {
            "name": "ouvrir_vanne",
            "description": "Sets the opening of a valve of the north network, in percent.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["vanne", "pourcent"],
                "properties": {
                    "vanne": { "allOf": [{ "type": "string" }, { "pattern": "^V-\\d{3}$" }] },
                    "pourcent": { "allOf": [{ "type": "number", "minimum": 0, "maximum": 150 }, { "minimum": 0, "maximum": 100 }] }
                }
            },
            "outputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "position": { "type": "number" } } },
            "annotations": { "idempotentHint": true, "destructiveHint": false },
            "http": {
                "method": "PUT",
                "path": ["/valves/", { "arg": "vanne" }, "/position"],
                "body": [
                    { "pointer": "/position", "arg": "pourcent" },
                    { "pointer": "/mode", "value": "manual" }
                ]
            },
            "output": { "pick": ["id", "position"] },
            "authorization": { "capability": "valves.write", "resourcePath": ["valves/", { "arg": "vanne" }], "value": "pourcent", "resultRequired": true }
        }
    ]
}
```

| field | role |
| --- | --- |
| `manifest` | format version; the runtime refuses a version it does not know |
| `compiler` | package and version of the compiler: with `provenance`, what is needed to recompile |
| `provenance` | `sha256` of the compiled binding and spec |
| `target` | as in the binding, with the authentication type resolved from the spec |
| `declaration` | what the runtime declares to the broker (`broker/authorization/declare`); `namespace` is an absolute resource path, the `resources` are concrete resources or patterns (see below) |
| `tools[].inputSchema` | schema composed from spec and binding, in MCP names; only the keywords that the runtime's validator knows appear in it |
| `tools[].http.path` | a list of fixed pieces and `{ "arg": name }`; argument values are encoded (`encodeURIComponent`), so an argument can neither add a segment nor change the origin |
| `tools[].http.query`, `headers` | lists of `{ name, arg }` or `{ name, value }`; an absent argument is omitted, an array repeats the parameter |
| `tools[].http.body` | a list of assignments `{ pointer, arg }` or `{ pointer, value }`, by JSON pointer (RFC 6901); `""` designates the whole body. A flat list rather than a tree: no ambiguity between a fixed value and an argument reference, and each line can be reread on its own |
| `tools[].output` | the projection, applied before responding |
| `tools[].authorization` | what the runtime asks `broker/authorize` on each call; the native identifier sent is the qualified name `<domain>:<resource path>`: a resource belongs to its domain, not to the slot, and `valves:/site/nord/**` is not `scada:/site/nord/**` |

This format replaces the "slot definition" format of the design document. It is implemented in `src/manifest/manifest.types.ts`, and the engine that executes it in `src/runtime/`.

### Engineering limits: concrete and by pattern (broker 1.7.0)

Broker 1.6 found limits only by the **exact** native identifier of a resource: a limit was declared for `V-012`, never for `valves/{id}`. The engine bench showed it. Broker 1.7.0 also accepts patterns in a declaration, and limits set by the operator in the security file; it intersects all those that apply. So the manifest declares both forms:

```json
"resources": [
    { "resource": "valves:/site/nord/valves/V-012", "resourcePath": "valves/V-012", "limits": { "maxValue": 40 } },
    { "resourcePattern": "valves/{id}", "where": { "id": "V-1\d{2}" }, "limits": { "maxValue": 60 } }
]
```

The paths are relative to the namespace; the engine makes them absolute at declaration time. The compiler will derive the pattern from the `resourcePath` template and its limits from the schema of the `value` argument.

### One declaration per slot, one domain per slot (broker 1.7.0)

A governed resource is a qualified name `<domain>:<path>`, and a domain has only one owner. So each slot declares **its own** domain, never that of another provider. Broker 1.7.0 indexes declarations by (identity, slot): the same host can serve several slots, each with its domain, without one declaration overwriting the other. If the broker refuses a declaration, `serveManifest` stops the slot and throws `ManifestDeclarationError` with all the reasons: a slot whose every call would be refused is not served.

The engine applies the constraints the broker returns (`allow-with-constraints`) to the argument designated by `authorization.value`. A limit bounds a **written** value: a `GET` or `HEAD` tool without `value` writes none, it passes. A tool that writes without designating its value is refused: it must never bypass a limit. The HTTP method decides, not the `readOnlyHint` annotation, which MCP presents as a mere hint.

## Where the compiler runs

The same code, in four places: the `designer` provider, the Tier 4 page in the browser (recompilation on each change, live diagnostics), a CLI (`npx @cyanmycelium/mcp-open-api compile binding.json`, for the CI of the team that maintains the API), and the tests.

**The host never compiles.** It receives an approved and signed manifest, verifies it and executes it. The compiler thus stays outside the trusted base: a buggy or compromised compiler gets nothing through, since the operator approves the manifest itself, not the binding. The binary also loads the compiler on demand, for the `compile` command only: the `serve` process never imports Ajv.

## Execution: the mcp-open-api host

### One provider, one or more processes

The host (`mcp-open-api serve`, or `OpenApiHost` in code) reads the manifests of a folder, verifies their signatures, resolves their secrets, and publishes each manifest to the broker as a slot, over **a single socket** (`MultiplexTransport`), under **its own** provider identity. Broker 1.7.0 keeps one declaration per slot: a host serves several slots, each in its domain, without them overwriting each other.

```json
{
    "broker": { "url": "ws://broker.local:3000/providers", "secretEnv": "VANNES_PROVIDER_SECRET" },
    "manifests": "manifests/vannes",
    "trustedKeys": ["keys/operateurs-ot.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": { "otGateway": { "env": "OT_GATEWAY_TOKEN" } }
}
```

**Recommendation: one host per API.** Each process has its config, its folder, its provider identity (a `providers` entry in the broker's security file, with its `allowedResources`) and its secrets.

- **Least privilege**: the valve API process sees only the OT gateway token; a compromised host does not expose the secrets of the other APIs.
- **Isolation**: a slow API, or one that returns large responses, weighs only on its own process, neither on the broker nor on the other APIs. It was the worst result of the bench when the engine ran inside the broker.
- **Independent life cycles**: you restart the host of one API without touching the others (`tests/host.test.ts` checks it with two hosts).
- **Never the same slot in two hosts**: the broker would apply its slot takeover rule (`providerTakeover`). Separate manifest folders are enough.

An application that embeds the broker can also serve a manifest in its own process, without a socket (`serveManifest`, in loopback). That is the case for tests and benches; a deployment uses the host.

### Interpret, generate nothing

The manifest is interpreted by fixed code, shipped with the package. At load, this code walks the manifest **once** and builds **closures**: functions that keep their parameters in memory.

```ts
// ["/valves/", { arg: "vanne" }, "/position"] becomes, at load:
const parts = tool.http.path;
const buildPath = (args) => parts.map((p) => (typeof p === "string" ? p : encodeURIComponent(args[p.arg]))).join("");
```

Each closure is package code, written and reviewed in advance; the manifest only parameterizes it. It has no way to express "execute this". Everything is prepared at load (templates, body plans, projections, validators), which the [plumbing bench](../bench/run.mjs) showed to be necessary for the translation to stay around 0.3 ms per call.

### The host without code generation

Node can forbid generating code from text: `--disallow-code-generation-from-strings`. Measured on 2026-10-05 and 2026-10-06:

- broker 1.6.1, then the mcp-open-api host (engine, `mcp-core`, `mcp-uns`, the provider package, `re2js`) work normally with this option;
- Ajv fails immediately (`EvalError`), because it generates one JavaScript function per schema.

**Decision: the host runs with `--disallow-code-generation-from-strings` by default.** `mcp-open-api serve` relaunches itself with the option if it does not have it, and announces `code generation: disallowed` at startup; `MCP_OPEN_API_ALLOW_CODE_GENERATION=1` disables it. `scripts/serve-check.mjs` checks it on the built binary, in CI. So the engine cannot use Ajv.

What the option guarantees, and what it does not, also measured:

- it blocks `eval`, `new Function` and strings passed to `setTimeout`, in the main context: that is the path taken by libraries that generate code, such as Ajv;
- it **does not block `node:vm`**: `vm.Script` and `vm.runInNewContext` still compile text, with or without the option;
- it **cannot be turned on after startup**: `v8.setFlagsFromString()` leaves `eval` and `new Function` allowed. It must be on the Node command line, or in `NODE_OPTIONS`.

So the option is not a sandbox. It prevents a library from generating code by accident; the real guarantee remains the design of the interpreter, where no manifest data reaches a code generation path. Two checks complement it:

- **in CI**: neither the engine nor any dependency of the host imports `node:vm` or obtains it through `process.getBuiltinModule()` (checked: none);
- **at startup**: the host tries `new Function("")` and announces the result.

How the option is enabled by default:

- **the CLI** checks `process.execArgv`; if it does not find the option there, it relaunches itself with it, forwarding arguments, input/output, signals and exit code. The relaunch costs one more Node process at startup, nothing afterwards. `MCP_BROKER_ALLOW_CODE_GENERATION=1` disables it, and `broker_diagnose` reports it;
- **the embedded broker** (`WsTunnelBuilder` in an application) cannot impose the option on its host. It loads the manifests anyway, and `broker_diagnose` reports `code-generation-allowed`.

### Argument validation: a precompiled validator

Three ways to validate the arguments of a call, measured by [bench/validate.mjs](../bench/validate.mjs) (Node 22.20, Intel Core Ultra 7 255H, median of 5 series of 100,000 validations):

| case | Ajv (generates code) | `@cfworker/json-schema` (interpreted) | precompiled validator (closures) |
| --- | --- | --- | --- |
| `ouvrir_vanne`, 2 arguments, valid | 23 ns | 2,700 ns | 145 ns |
| `ouvrir_vanne`, 120 % refused | 33 ns | 2,740 ns | 136 ns |
| 12 arguments and 20 points, valid | 424 ns | 43,300 ns | 3,450 ns |
| 12 arguments and 20 points, last point wrong | 458 ns | 41,800 ns | 3,330 ns |
| loading the large schema, once per tool | 6,300 µs | 12 µs | 17 µs |
| under `--disallow-code-generation-from-strings` | **fails** | works | works |

The precompiled validator walks the schema once, at load, and builds a tree of closures; at call time, it only executes these functions. The interpreted validator rereads the schema on each call.

**Decision: the runtime validates with an in-house precompiled validator**, limited to the keywords the compiler emits (`type`, `enum`, `const`, numeric bounds, lengths, `pattern`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `allOf`, `anyOf`, `oneOf`). An unknown keyword is refused at load, never ignored.

Why this is acceptable:

- it is 6 to 8 times slower than Ajv, but 145 ns represents 0.05 % of the 0.3 ms of measured plumbing, and 3.4 µs for a large tool about 1 %;
- it is 12 to 19 times faster than a generic interpreted validator;
- it loads 370 times faster than Ajv: 40 tools load in less than a millisecond, versus a quarter of a second with Ajv;
- it generates no code, so it is compatible with the Node option.

Ajv remains the design time tool: compiler, CLI, CI, tests, and the `.mcpb` bundle (below), where it is generated in advance in *standalone* mode.

### How to be sure of a validator written for the occasion

The compiler is outside the trusted base: what it produces is reviewed and can be recompiled. The validator, however, runs in the host and is authoritative. It is not proven by rereading it, but by **comparing it to a reference**: Ajv, the reference JSON Schema validator in JavaScript. Four defenses, each covering a blind spot of the previous one.

1. **A closed subset.** It knows only about fifteen keywords and refuses all others at load. A silently ignored keyword is the most dangerous bug of a validator: it lets everything through without saying anything.
2. **The official test suite** ([JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite), draft 2020-12), for each covered keyword: the edge cases the community has already encountered.
3. **Random comparison with Ajv** ([bench/validator.fuzz.mjs](../bench/validator.fuzz.mjs)): schemas drawn at random from the subset, values drawn at random, the same verdict required from both. The generator is deterministic: a disagreement can be replayed from its seed.
4. **Bug injection**, to prove that the comparison can find something. A bench that never sees anything proves nothing.

Results on the prototype, on 2026-10-05:

| check | result |
| --- | --- |
| injected bugs: strict `maximum`, `maxLength` off by 1, `integer` that accepts 1.5, `required` ignored, `oneOf` treated as `anyOf`, `pattern` without the `u` flag | **6 out of 6 detected**, in 3,000 schemas |
| initial prototype, 20,000 schemas and 200,000 random values | no disagreement |
| an object in an `enum` with its keys in another order (`{"b":2,"a":1}` versus `[{"a":1,"b":2}]`) | **real bug**: refused by the prototype, accepted by Ajv, rightly. The random comparison **had not found it** |
| completed generator (half of the values of an `enum` or `const` are reordered copies of its members), old prototype | bug caught 257 times |
| fixed prototype, 100,000 schemas and 1,000,000 values | **no disagreement** |

The lesson of the `enum` bug: randomness alone is not enough. A randomly drawn value almost never lands on a member of an `enum`, let alone on a reordered copy. Hence the official suite, and generators directed toward structural equalities and bounds.

These checks go into CI: the official suite and a short random comparison on each commit, a long comparison before each release. In addition, each manifest produced by the compiler tests is validated by both validators on values generated from its own schema.

Nor is the validator the only barrier: the resource limits are checked again by `broker/authorize` (`allow-with-constraints`), and the target API validates its own inputs.

**The compiler** is tested differently, since it is not in the trusted base:

- a corpus of real specs (Petstore, GitHub, Stripe, and the APIs.guru directory) that must compile without crashing, with a generated binding that exposes everything read-only;
- reference files: for each test binding, the expected manifest, compared byte for byte;
- invariants: compiling twice yields the same hash; every manifest produced is valid for `manifest-1` and loads in the runtime; a binding, Overlay, binding round trip is lossless; adding a restriction never makes one more value accepted.

### Regular expressions

A `pattern` is executed on each received argument. The V8 engine uses backtracking: an expression like `^(a+)+$` can block the broker's event loop for seconds on a crafted input (ReDoS), with the same effect as the large responses measured in the bench. All slots wait.

Measured by [bench/regex.mjs](../bench/regex.mjs) (Node 22.20, Intel Core Ultra 7 255H) with `re2js` 2.8 (JavaScript port of RE2). The column for the native `re2` 1.24 module was measured once, on 2026-10-05, before it was ruled out; the bench no longer includes it.

| case | V8 | native `re2` | `re2js` |
| --- | --- | --- | --- |
| `^V-\d{3}$` on `V-012` | 10 ns | 36 ns | 125 ns |
| `^[A-Z]{2}-\d{3}$` on `PT-007` | 11 ns | 35 ns | 113 ns |
| 30-character email address | 22 ns | 76 ns | 604 ns |
| `^(a+)+$` on 20 `a` and `!` | 3.1 ms | 64 ns | 1.0 µs |
| `^(a+)+$` on 24 `a` and `!` | 52.7 ms | 67 ns | 0.9 µs |
| `^(a+)+$` on 28 `a` and `!` | **860 ms** | **71 ns** | **1.0 µs** |
| compiling a pattern, at load | 94 ns | 6.5 µs | 4.7 µs |

On an ordinary pattern, RE2 is slower than V8, by a few tens to a few hundreds of nanoseconds: nothing compared to the 0.3 ms of plumbing. On a crafted pattern, V8 explodes (860 ms for 29 characters, and double for each additional character) while RE2 stays around a microsecond. The gain of RE2 is not average speed, it is **the bounded worst case**, and it is the worst case that blocks the broker.

**Decision: the runtime evaluates `pattern`s with `re2js`, and only with it.**

The native `re2` module is faster, but it was ruled out because of what it costs at installation and in operation (observed on `re2` 1.24.1):

| | native `re2` | `re2js` |
| --- | --- | --- |
| Node versions | 22 and later only, whereas the broker supports Node 20 | all |
| installation | downloads a binary from GitHub during `npm install`, otherwise compiles it with `node-gyp` (Python and a C++ compiler, Visual Studio Build Tools on Windows) | pure JavaScript |
| offline, behind a proxy, or `--ignore-scripts` | no binary, or compilation failure | nothing special |
| integrity | the downloaded binary escapes the lockfile hash, and `re2` 1.24.1 publishes no hash: nothing verifies it, apart from TLS | covered by the lockfile hash, like any package |
| size and dependencies | 17 MB, plus `node-gyp`, `nan`, `install-artifact-from-github` | 872 KB, no dependencies |
| native code in the host | yes | no |

For the runtime:

- `re2js` works with `--disallow-code-generation-from-strings` (checked);
- the V8 engine is never used for a `pattern` that comes from a manifest;
- RE2 knows neither backreferences (`\1`) nor lookahead or lookbehind assertions (`(?=`, `(?<=`): a pattern that RE2 does not compile is a **compilation error** of the binding, which rules out most dangerous patterns from the start;
- the length of the argument is still checked **before** its `pattern`, and the compiler requires a `maxLength` on every argument that carries a `pattern`: RE2 is linear, not free.

### The real engine, measured

The `src/runtime/` engine was measured on 2026-10-05 with [bench/run.mjs](../bench/run.mjs), in a 1.6.1 broker launched with `--disallow-code-generation-from-strings` (confirmed: `new Function` throws `EvalError` there). The plumbing bench prototype runs in the same pass, for comparison.

| scenario | p50 | p99 | throughput |
| --- | --- | --- | --- |
| direct HTTP, 1 KB | 0.32 ms | 0.80 ms | 2,879 req/s |
| broker + prototype, 1 KB | 0.74 ms | 1.46 ms | 1,303 req/s |
| broker + **engine**, 1 KB | 0.81 ms | 2.71 ms | 1,087 req/s |
| broker + **engine** + `authorize`, 1 KB | 0.80 ms | 1.58 ms | 1,213 req/s |
| broker + **engine**, 64 KB | 1.21 ms | 2.11 ms | 805 req/s |
| direct HTTP, 1 KB, 100 concurrent | 12.8 ms | 38.5 ms | 6,910 req/s |
| broker + prototype, 100 concurrent | 27.5 ms | 55.4 ms | 3,458 req/s |
| broker + **engine**, 100 concurrent | 29.3 ms | 46.9 ms | 3,340 req/s |
| broker + **engine** + `authorize`, 100 concurrent | 39.3 ms | 60.7 ms | 2,449 req/s |
| neighboring slot during 4 responses of 5 MB | 45.6 ms | 104 ms | |

- The engine costs barely more than the prototype: 0.07 ms at p50, 3 % of throughput at saturation. The mcp-core and RE2 layers are therefore negligible.
- The overhead compared to direct HTTP is about 0.5 ms at p50 that day, on a machine more loaded than during the first bench (direct throughput is 30 % lower there): only comparisons within the same pass are meaningful.
- `authorize` costs 27 % of throughput at saturation, versus 17 % in the first bench. The audit line written on each decision weighs on it: an asynchronous audit sink remains to be measured on the broker side.
- Large responses remain the real risk: with 5 MB responses allowed (the bench raises `maxResponseBytes` to 8 MB), a neighboring slot goes to 46 ms at p50 and 104 ms at p99. Hence the 1 MB default limit, and the host outside the broker: this bench measured the engine in the broker's process; served by a host, it only delays the slots of that same host.

The real validator (`bench/validate.mjs`) costs 442 ns on `ouvrir_vanne` and 10 µs on the large tool, versus 145 ns and 3.4 µs for the prototype: that is the price of RE2 on `pattern`s, which the prototype evaluated with V8. It loads in 87 µs for the large schema, because of the compilation of the RE2 patterns. Compared to Ajv on 100,000 schemas and 1,000,000 values (`bench/validator.fuzz.mjs`), it gives no disagreement.

### Loading, in order

For each file in the folder, the host:

1. reads the manifest and its signature (`<file>.sig`), recomputes the canonical hash, compares it to the signed one, and verifies the signature against its trusted keys (`trustedKeys`);
2. refuses an unknown format version, then checks `baseUrl` against its `allowedTargets` and each `secretRef` against its `secrets`;
3. builds the closures;
4. publishes the slot to the broker and declares its authorization; the broker checks the domain owner and the identity's `allowedResources`.

A manifest refused at any step is not served, with its reasons; the others are. The caps (number of tools, size of schemas) remain to be added.

## Certification

Three things are certified, each by its own means.

| what | how | what is authoritative |
| --- | --- | --- |
| **the code**: the host and its interpreter | npm package published with provenance (sigstore), lockfile integrity; version in the manifest's `compiler` field | the publishing chain |
| **the manifest** | canonical JSON, hence a unique `sha256` hash | the hash |
| **the Tier 4 approval** | a signature over that hash | the signing key |

### The signature

Detached Ed25519 signature (`src/host/signature.ts`), in a `<manifest>.sig` file:

```json
{ "alg": "Ed25519", "manifest": "<sha256 of the canonical manifest>", "signature": "<base64>" }
```

It covers the **canonical form** of the manifest: a reformatted file still verifies, a modified file never does. The host accepts only the keys of **its own** config (`trustedKeys`, Ed25519 PEMs). With one host per API, each API has its signers: the OT team's key, listed in the valve host, is not authoritative for the historian host. `allowUnsigned` exists for development, false by default.

Two ways to publish, a single verification:

- **through the Tier 4 page** (coming): the operator approves, and the manifest is signed with the operator's key or the designer's key, to be decided;
- **through a Git repository**: `mcp-open-api compile`, then `mcp-open-api sign --key`, in CI or on a lead's workstation; the manifest and its signature are dropped into the host's folder.

A manifest whose signature does not verify is refused at startup, with its reason. A file modified by hand on disk is never loaded. To change keys, add the new one to `trustedKeys`, re-sign, then remove the old one: the host accepts any key in the list.

### Reproducible compilation

The compiler is deterministic: anyone can recompile binding and spec with the same version and get the same hash. A CI can attest that this manifest is exactly `compile(binding@c41e…, spec@9f2c…, compiler@0.2.0)`. The operator does not have to trust the designer: they approve a manifest whose origin can be verified.

### The worst case

A malicious manifest, signed by a stolen key, can only call origins listed in `allowedTargets`, use secrets designated by reference that it never sees, and expose tools subject to `authorize`, to auditing and to execution limits. It can neither execute code, nor read a file, nor open an arbitrary connection: the interpreter does not know how to do it. `--disallow-code-generation-from-strings` additionally prevents a host library from generating code by accident, without being a sandbox (`node:vm` escapes it, hence the CI check). A stolen key compromises only the hosts that list it, and a compromised host only its API: it holds only its own secrets, and the broker bounds what it can declare to its `allowedResources`.

## The second output: a `.mcpb` bundle (later lot)

Generating code at design time has its place, but not in the host that interprets manifests. Loading generated code there would make all security rest on a signature: a compromised signer or generator would execute anything in the process that holds the API's secrets. The gain, a few microseconds, does not justify it, especially since the host already runs outside the broker.

The compiler can, on the other hand, optionally produce a `.mcpb` bundle that contains:

- the manifest approved by the Tier 4;
- the code generated from that manifest: *standalone* Ajv validators, path functions, projections;
- a reproducible build attestation: this code is exactly `generate(manifest@<hash>, generator@<version>)`.

The broker already knows how to verify a `.mcpb` and run it **in a separate process**, which can be restricted with the Node permission model (`--permission`). The mcp-open-api host itself can also be shipped this way.

| output | execution | when |
| --- | --- | --- |
| **manifest** (default) | interpreted by an mcp-open-api host, without code generation | the common case |
| **`.mcpb` bundle** (option) | generated code, separate process, signed like other bundles | very high throughput, later computed transformations and Arazzo workflows |

In both cases, the operator approves the same thing: the manifest.

## Dependencies

| dependency | where | why |
| --- | --- | --- |
| `yaml` | compiler | YAML specs |
| Ajv | compiler, CLI, tests, `.mcpb` bundle | validation of the binding and manifests at design time, *standalone* generation |
| precompiled validator (in-house) | runtime | argument validation in the host, without code generation |
| `@cyanmycelium/mcp-broker-provider` | host | publishing slots over a shared socket, `broker/authorize` |
| `re2js` | runtime, compiler | linear-time `pattern`, pure JavaScript; the compiler checks that RE2 accepts each pattern |
| internal `$ref`s, canonical JSON (in-house) | compiler | little code, no dependency |
| JSONPath RFC 9535 | compiler, with the Overlay | applying the actions |

## Decisions

| question | decision |
| --- | --- |
| what is compiled | data (the manifest), never code |
| who compiles | the designer, the page, the CLI, the CI; never the host |
| who executes | an mcp-open-api host, a broker provider; one process per API recommended. The broker does not know the manifest |
| schema restriction | by `allOf` composition of spec and binding, without proof |
| code generation in the host | `--disallow-code-generation-from-strings` by default: `serve` relaunches itself with it and announces it; checked in CI on the binary |
| argument validation | in-house precompiled validator; Ajv at design time only |
| regular expressions | `re2js` only, never the V8 engine nor the native `re2` module; a pattern that RE2 refuses is a compilation error |
| certification | detached Ed25519 signature over the canonical manifest |
| authoritative keys | the `trustedKeys` of the host config |
| target API secrets | read by the host, from its environment (mcp-vault later), never in the manifest |
| allowed targets | the `allowedTargets` of the host config |
| generated code | only in a `.mcpb` bundle, separate process, later lot |

## Open questions

- **Signing from the Tier 4 page**: with the operator's key, or with a designer key that attests the operator's approval?
- **Secrets in mcp-vault**: the host would read the API tokens from the broker's `vault` slot, sealed for its key and authorized by policy (audience per API), instead of environment variables.
- **Reloading**: the host loads its manifests at startup; should it watch the folder, or a signal, to publish a new manifest without restarting?
