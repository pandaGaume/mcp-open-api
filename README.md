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
binding + OpenAPI spec ──compile──> manifest (JSON, canonical) ──approve, sign──> mcp-open-api host ──provider──> broker slot
                                                                                   │                              │
                                                                                   └── one process per API:       └── authorize, audit,
                                                                                       its secrets, its targets       limits, traceparent
```

Converting OpenAPI to MCP is not new. A 300-operation spec does not make a good slot, though: operations have to be chosen, renamed, described for an LLM, narrowed with fixed parameters, and tied to a capability and a resource path. That design work is what this project is about, and what makes a REST API safe to hand to an agent.

## How it works

- **A provider, not a broker feature.** mcp-open-api registers on the broker as an ordinary provider, on the slot `designer`. Its MCP tools import a spec, propose tools, tune them, validate and try them. An agent can drive them.
- **A human publishes.** A transformation becomes a published slot only after a **Tier 4** operator validates it, on a web page that mcp-open-api pushes into the broker's static mount. The operator signs in with their own token, reviews the checks and the diff, approves each write tool one by one, and the approved manifest is signed. A host serves only manifests signed by a key it trusts.
- **The page can be a slot.** While validating, the page can publish itself as a temporary slot (`preview-<slot>-<id>`) exposing the transformed tools, so they can be called for real before publication. Calls are relayed to the broker; API secrets never reach the browser.
- **The output is declarative.** A published slot is a manifest: one readable, diffable JSON file with no secret in it, signed once approved. An **mcp-open-api host** serves it: it verifies the signature, interprets the manifest without generating code, and publishes it to the broker as an ordinary provider. The broker knows nothing of manifests. Every call goes through the broker's declared authorization, audit, execution limits and W3C trace propagation; the target API's credentials stay in the host.
- **One host per API.** Each host process has its own configuration, provider identity, secrets and allowed targets: an API only ever sees its own credentials, and a slow or heavy API only weighs on its own process.

## Status

- **Implemented**: the binding format (`binding-1`, JSON Schema and types) and the **engine**: a manifest served as a broker slot, interpreted without generating code, with argument validation (RE2 patterns), the broker's decision and engineering limits on every call, connection pooling, response size cap and projection. Tested end to end behind a real broker, and benchmarked (`bench/`).
- **Implemented**: the **compiler** (`@cyanmycelium/mcp-open-api/compiler`): OpenAPI 3.0 or 3.1 (JSON or YAML) plus a binding, into a canonical manifest and its SHA-256, with every diagnostic at once. A pure function; the manifest compiled from a spec behaves like a hand-written one behind the broker.
- **Implemented**: the **host** and the **CLI**: signed manifests (Ed25519, on the canonical form), served from their own process over one provider socket, with code generation disallowed.
- **Implemented**: the **designer** (`@cyanmycelium/mcp-open-api/designer`, `mcp-open-api design`): a provider on the `designer` slot whose tools import a spec, tune a draft binding, compile and check it against the target host, dry-run a call, and publish a signed manifest into the host's folder. Its **Tier 4 page** (`ui/`) walks an operator through the same steps and signs in the browser with the operator's own Ed25519 key; the designer holds no key a host trusts.
- **Not yet**: Overlay and Arazzo inputs, MCP resources, secrets read from mcp-vault, a real (not dry) trial of read-only tools, the page pushed by the provider into the broker (it is served by a config mount until the broker supports that), the scoping of the MCP path for agents.

```bash
npx @cyanmycelium/mcp-open-api compile vannes.binding.json --out manifests/vannes.json
npx @cyanmycelium/mcp-open-api keygen --out keys/ot-team
npx @cyanmycelium/mcp-open-api sign manifests/vannes.json --key keys/ot-team.pem
npx @cyanmycelium/mcp-open-api serve --config mcp-open-api.json
```

`mcp-open-api.json`, one per host:

```json
{
    "broker": { "url": "ws://broker.local:3000/providers", "secretEnv": "VANNES_PROVIDER_SECRET" },
    "manifests": "manifests",
    "trustedKeys": ["keys/ot-team.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": { "otGateway": { "env": "OT_GATEWAY_TOKEN" } }
}
```

The host's provider identity (`VANNES_PROVIDER_SECRET`) is an entry of the broker's security file, with its `allowedResources`.

### The designer

```bash
npx @cyanmycelium/mcp-open-api design --config designer.json
```

`designer.json` names the broker and the hosts it publishes into, by the path of each host's own config:

```json
{
    "broker": { "url": "ws://broker.local:3000/providers", "secretEnv": "DESIGNER_PROVIDER_SECRET" },
    "hosts": { "vannes": "../vannes/mcp-open-api.json" },
    "specOrigins": ["https://docs.example.com"]
}
```

The command prints the static mount to add to the broker's `config.json` (`www.mounts`, under `/ui/designer`); the broker's own origin must be in `allowedOrigins`. Open `/ui/designer/` on the broker, connect with your token, and go: source, selection, tuning, checks, dry run, review.

A spec can come from a file, pasted text, or a URL. The URL may be the spec itself or a documentation page (Swagger UI, ReDoc, Scalar): the designer looks for the spec the page loads, then at the usual places (`/openapi.json`, `/v3/api-docs`, `/swagger.json`, ...). It fetches only from the host's `allowedTargets` and from `specOrigins`, redirects included, so it cannot be turned into a way to reach any address its network can. Swagger 2.0 is recognized and refused with a pointer to a converter. Publishing writes `<slot>.json`, its `.sig` and the sources (`sources/<slot>.binding.json`, the spec) into the host's folder; restart that host to serve it.

The page signs in the browser, with an Ed25519 PKCS#8 key from `mcp-open-api keygen`; its public half must be in the host's `trustedKeys`. Every design tool is also reachable over MCP; `designer_publish` refuses anything without that signature.

`npm run build && npm run demo:designer` runs it all on one machine: a broker serving the page, a fake valve API, the designer and a demo key.

Design: [docs/binding.md](docs/binding.md) and [docs/compiler.md](docs/compiler.md).

## Requirements

- Node.js 22 or later for the host (a provider secret travels in a WebSocket handshake header); 20.11 for the compiler alone.
- An mcp-broker, 1.7.0 or later: engineering limits by resource pattern, one declaration per slot. Publishing from the Tier 4 page needs broker features that are not released yet.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
