[![npm](https://img.shields.io/npm/v/@cyanmycelium/mcp-open-api)](https://www.npmjs.com/package/@cyanmycelium/mcp-open-api) [![mcp-broker: 1.7.0](docs/assets/mcp-broker-badge.svg)](https://github.com/pandaGaume/mcp-broker)
[![CI](https://github.com/pandaGaume/mcp-open-api/actions/workflows/ci.yml/badge.svg)](https://github.com/pandaGaume/mcp-open-api/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

<p align="center">
  <img src="docs/assets/logo.png" alt="mcp-open-api logo: a blue pixel-art panda holding an API specification, with connected tools glowing on its chest" width="180" />
  <img src="docs/assets/mcp-broker-family.png" alt="MCP Broker Family" width="64" height="64" />
</p>

# mcp-open-api

Turns an OpenAPI spec into a slot of an [mcp-broker](https://github.com/pandaGaume/mcp-broker), **validated by a human before it is published**, then governed by the broker like any other provider.

```text
OpenAPI spec ──> mcp-open-api (slot "designer") ──> Tier 4 page ──publish──> slot definition (JSON)
                       │                               │                            │
                       └── pushes its page into the    └── operator's own token     └── run by the broker:
                           broker's static mount           + checks re-run by           authorize, audit, limits,
                                                           the broker                   traceparent, secrets kept
```

Converting OpenAPI to MCP is not new. A 300-operation spec does not make a good slot, though: operations have to be chosen, renamed, described for an LLM, narrowed with fixed parameters, and tied to a capability and a resource path. That design work is what this project is about, and what makes a REST API safe to hand to an agent.

## How it works

- **A provider, not a broker feature.** mcp-open-api registers on the broker as an ordinary provider, on the slot `designer`. Its MCP tools import a spec, propose tools, tune them, validate and try them. An agent can drive them.
- **A human publishes.** A transformation becomes a published slot only after a **Tier 4** operator validates it, on a web page that mcp-open-api pushes into the broker's static mount. The operator signs in with their own token, reviews the checks and the diff, approves each write tool one by one, and publishes. The broker re-runs every check and audits the publication under the operator's name. The provider itself holds no publishing right.
- **The page can be a slot.** While validating, the page can publish itself as a temporary slot (`preview-<slot>-<id>`) exposing the transformed tools, so they can be called for real before publication. Calls are relayed to the broker; API secrets never reach the browser.
- **The output is declarative.** A published slot is a slot definition: one readable, diffable JSON file with no secret in it. The broker runs it without generated code and without an extra process. Every call goes through the broker's declared authorization, audit, execution limits and W3C trace propagation, and the target API's credentials stay in the broker's security file.

## Status

- **Implemented**: the binding format (`binding-1`, JSON Schema and types) and the **engine**: a manifest served as a broker slot, interpreted without generating code, with argument validation (RE2 patterns), the broker's decision and engineering limits on every call, connection pooling, response size cap and projection. Tested end to end behind a real broker, and benchmarked (`bench/`).
- **Not yet**: the compiler (OpenAPI spec + binding to manifest), signed manifests, the Tier 4 validation page, the MCP path for agents.

Design: [docs/binding.md](docs/binding.md) and [docs/compiler.md](docs/compiler.md) (French).

## Requirements

- Node.js 20.11 or later.
- An mcp-broker, 1.7.0 or later: engineering limits by resource pattern, one declaration per slot. Publishing from the Tier 4 page needs broker features that are not released yet.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
