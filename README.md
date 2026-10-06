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

Two steps, apart.

- **Design, on a page.** The Tier 4 page (`dist/ui/`) is static: host it anywhere, a broker static mount included, or open it locally. Everything runs in the browser: it imports a spec (a URL, a file, pasted text), lets a person choose and tune the operations, compiles and checks them on every change, dry-runs a call, and shows the result for review. The operator approves each write tool, signs with their own Ed25519 key (it never leaves the page), and saves the manifest, its signature and its sources. Nothing is sent to any server.
- **Run, next to the broker.** An **mcp-open-api host** takes one or several manifests and opens one broker slot per manifest. It verifies each signature, interprets the manifest without generating code, and publishes it as an ordinary provider: every call goes through the broker's declared authorization, audit, execution limits and W3C trace propagation, and the API's credentials stay in the host. The broker knows nothing of manifests.
- **One host per API, recommended.** Each host process has its own configuration, provider identity, secrets and allowed targets: an API only ever sees its own credentials, and a slow or heavy API only weighs on its own process. One host can still serve several slots.

## Status

- **Implemented**: the binding format (`binding-1`, JSON Schema and types) and the **engine**: a manifest served as a broker slot, interpreted without generating code, with argument validation (RE2 patterns), the broker's decision and engineering limits on every call, connection pooling, response size cap and projection. Tested end to end behind a real broker, and benchmarked (`bench/`).
- **Implemented**: the **compiler** (`@cyanmycelium/mcp-open-api/compiler`): OpenAPI 3.0 or 3.1 (JSON or YAML) plus a binding, into a canonical manifest and its SHA-256, with every diagnostic at once. A pure function; the manifest compiled from a spec behaves like a hand-written one behind the broker.
- **Implemented**: the **host** and the **CLI**: signed manifests (Ed25519, on the canonical form), served from their own process over one provider socket, with code generation disallowed.
- **Implemented**: the **Tier 4 page** (`dist/ui/`) and the **designer** behind it (`@cyanmycelium/mcp-open-api/designer`, pure, browser and Node): import by URL, file or text, a Swagger UI or ReDoc page included; tuning; checks against the target host when its config is loaded; dry run; review and diff; signature in the browser; the files to hand to a host.
- **Not yet**: Overlay and Arazzo inputs, MCP resources, secrets read from mcp-vault, a real (not dry) trial, the page deploying the slots it designed when a broker hosts it.

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
    "manifests": ["manifests/vannes.json", "manifests/vannes-maintenance.json"],
    "trustedKeys": ["keys/ot-team.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": { "otGateway": { "env": "OT_GATEWAY_TOKEN" } }
}
```

`manifests` is a manifest file, a directory of them, or a list of either: one slot per manifest, each with its `.sig`. The host's provider identity (`VANNES_PROVIDER_SECRET`) is an entry of the broker's security file, with its `allowedResources`.

### The Tier 4 page

`npm run build` writes it to `dist/ui/`: four static files to serve from anywhere (any web server, a broker `www.mounts` entry, a CDN). Open it, then:

1. **Target host**, optional: load the host's `mcp-open-api.json` to check the base URL and the credential against it. Only its allowed targets and secret names are read.
2. **Source**: a URL (the spec, or a documentation page such as Swagger UI or ReDoc, whose spec it finds, else at `/openapi.json`, `/v3/api-docs`, ...), a file, or pasted text. A URL is read by the browser, so the site must allow cross-origin requests; otherwise download the spec and use the file. Swagger 2.0 is refused with a pointer to a converter.
3. **Selection, tuning, checks, dry run**, then **review**: approve each write tool, load your key (`mcp-open-api keygen`; its public half goes in the host's `trustedKeys`), sign, and save `<slot>.json`, `<slot>.json.sig` and the sources.
4. List the manifest in the host's `manifests` and start or restart the host.

`npm run build && npm run demo:designer` serves the page with a fake valve API, its Swagger UI-like page, a host config and a key to try it all.

Design: [docs/binding.md](docs/binding.md) and [docs/compiler.md](docs/compiler.md).

## Requirements

- Node.js 22 or later for the host (a provider secret travels in a WebSocket handshake header); 20.11 for the compiler alone.
- An mcp-broker, 1.7.0 or later: engineering limits by resource pattern, one declaration per slot.
- For the page: a browser with Ed25519 in WebCrypto (current Chrome, Edge, Firefox, Safari), on https or localhost to sign.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
