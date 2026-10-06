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

1. **Design the manifest on the page.** The design page is published on GitHub Pages: **https://pandagaume.github.io/mcp-open-api/**. It runs entirely in your browser, and nothing is sent to any server. You import a spec (a URL, a Swagger UI or ReDoc page included, a file, or pasted text), choose and tune the operations, check them, dry-run a call, approve each write tool, and sign with your Ed25519 key, which never leaves the page. Then you save `<slot>.json`, its `<slot>.json.sig` and the sources.
2. **Declare the slot**, like an mcp-cache or an mcp-vault: **directly**, from a script of your own, or **with a process**, `mcp-open-api serve`. Either way the manifest's signature is checked, the manifest is interpreted without generating code, and every call goes through the broker's authorization, audit, limits and trace propagation. The API's credentials stay in your process. The broker knows nothing of manifests.

## Use

### Directly

```ts
import { readFileSync } from "node:fs";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { McpServerBuilder } from "@cyanmycelium/mcp-core";
import { BrokerAccessGuard } from "@cyanmycelium/mcp-uns";
import { HttpPool, ManifestBehavior, ManifestEngine, buildManifestDeclaration, verifyManifest } from "@cyanmycelium/mcp-open-api";

const manifest = verifyManifest(readFileSync("vannes.json", "utf8"), readFileSync("vannes.json.sig", "utf8"), [readFileSync("keys/ot-team.pub.pem", "utf8")]);

const transport = new DirectTransport("ws://localhost:3000/provider/vannes", { secret });
const engine = new ManifestEngine(manifest, {
    guard: new BrokerAccessGuard(transport.broker, { constraints: "return" }),
    secrets: { otGateway: process.env.OT_GATEWAY_TOKEN },
    allowedTargets: ["https://ot-gw.local"],
    pool: new HttpPool(),
});
const server = new McpServerBuilder().withName(manifest.slot).withTransport(transport).register(new ManifestBehavior(engine)).build();
await server.start();
await transport.broker.declare(buildManifestDeclaration(manifest));
```

Several manifests make several slots: one transport, engine and server each, sharing the `HttpPool`.

### With a process

```bash
npx @cyanmycelium/mcp-open-api serve --config mcp-open-api.json
```

```json
{
    "broker": { "url": "ws://localhost:3000/providers", "secretEnv": "MCP_OPEN_API_SECRET" },
    "manifests": ["vannes.json", "pompes.json"],
    "trustedKeys": ["keys/ot-team.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": { "otGateway": { "env": "OT_GATEWAY_TOKEN" } }
}
```

The host opens one slot per manifest. `manifests` is a file, a directory of them, or a list of either. Without a config file, it reads `mcp-open-api.json` in the current directory.

### On the broker

The provider is an entry of the broker's security file, with its own secret and the resources it may declare. Its slots then appear in the policy like any other:

```json
{
    "providers": [{ "id": "mcp-open-api", "secretEnv": "MCP_OPEN_API_SECRET", "subjects": ["service:mcp-open-api"], "allowedResources": ["/site/nord/**"] }],
    "auth": { "slotResources": { "vannes": "/site/nord/vannes" } }
}
```

### Without the page

The page and the CLI share the same compiler, so a binding kept in a repository compiles and signs the same way:

```bash
npx @cyanmycelium/mcp-open-api compile vannes.binding.json --out vannes.json
npx @cyanmycelium/mcp-open-api keygen --out keys/ot-team
npx @cyanmycelium/mcp-open-api sign vannes.json --key keys/ot-team.pem
```

To run the page locally, run `npm run build && npm run demo:designer`. It serves `dist/ui/` with a fake valve API, its Swagger UI-like page, a host config and a key.

## Status

- **Implemented**:
  - the binding format (`binding-1`);
  - the compiler, a pure function that also runs in the browser;
  - the engine: argument validation (RE2), the broker's decision and limits on every call, connection pooling, response cap and projection;
  - signed manifests, served directly or by `mcp-open-api serve`;
  - the design page, published on GitHub Pages.
- **Not yet**: Overlay and Arazzo inputs, MCP resources, secrets read from mcp-vault, a real (not dry) trial from the page.

Design: [docs/binding.md](docs/binding.md) and [docs/compiler.md](docs/compiler.md).

## Requirements

- Node.js 22 or later for the host (a provider secret travels in a WebSocket handshake header); 20.11 for the compiler alone.
- An mcp-broker, 1.7.0 or later: engineering limits by resource pattern, one declaration per slot.
- For the page: a browser with Ed25519 in WebCrypto (current Chrome, Edge, Firefox, Safari).

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
