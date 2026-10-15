# Broker plugin deployment

The export `@cyanmycelium/mcp-open-api/plugin` implements the broker's plugin API version 1. The broker does not depend on this package. A deployment installs the plugin and chooses it in the broker configuration. No separate host process or provider WebSocket is needed for this integration.

Use mcp-broker 1.10.0 or later, which includes the generic `plugins[]` loader. Earlier broker releases do not load these entries. This adapter must be published or built locally before deployment.

## Install in the deployment

The broker Dockerfile uses a separate `node/packages/broker/plugins/package.json` and lockfile. Add the chosen published version to that deployment manifest, leaving the broker package unchanged:

```sh
# In the mcp-broker repository
cd node/packages/broker/plugins
npm install --save-exact @cyanmycelium/mcp-open-api@<published-version>
cd ../../..
docker build -f packages/broker/Dockerfile -t broker-with-open-api .
```

For an unpublished version, build this project and run `npm pack`. Copy the tarball to the broker deployment's `plugins/` directory and install it there instead of a registry version. The plugin's own dependencies, including its mcp-core peer, must be installed in that directory. A mounted deployment directory with installed dependencies is another option.

## Broker configuration

Example `/config/config.json`:

```json
{
    "host": "0.0.0.0",
    "port": 3000,
    "securityFile": "security.json",
    "pluginsDirectory": "/opt/mcp-broker-plugins",
    "plugins": [
        {
            "id": "plant-api",
            "module": "@cyanmycelium/mcp-open-api/plugin",
            "provider": "plant-provider",
            "aggregate": false,
            "required": true,
            "config": {
                "manifests": ["manifests/vannes.json"],
                "trustedKeys": ["keys/operator.pub.pem"],
                "allowedTargets": ["https://ot-gw.local"],
                "secrets": {
                    "otGateway": { "env": "OT_GATEWAY_TOKEN" }
                }
            }
        }
    ]
}
```

The `provider` references an identity in the broker security file, for example this entry in its `providers` array:

```json
{
    "id": "plant-provider",
    "secretEnv": "PLANT_PROVIDER_SECRET",
    "allowedResources": ["/site/nord/**"]
}
```

Supply `PLANT_PROVIDER_SECRET` to satisfy the existing broker security-file contract. The loader passes the provider's identity and resource restrictions to the loopback registration, without passing its credential to the plugin. Client roles and assignments in the security file must separately grant the MCP operations and declared API capabilities. A declaration grants no client permission.

`MCP_BROKER_PLUGINS_DIR` overrides `pluginsDirectory`; the Dockerfile sets it to `/opt/mcp-broker-plugins`. Relative module paths resolve against the broker configuration directory, while bare package exports resolve from the deployment plugin directory.

Mount `/config` read-only, set `MCP_BROKER_CONFIG=/config/config.json`, and inject the provider secret and API token at runtime. Keep the manifest, its adjacent `vannes.json.sig` and the trusted public key under the referenced paths. Keep the private signing key outside the container. Adapt the target URL and allowlist to the API's address as seen from this container before signing the manifest.

## Loading and lifecycle

- `manifests` accepts a file, a directory of `*.json` manifests, or an array of these. Directory scanning is not recursive. Do not mix configuration or binding JSON files into a manifest directory.
- File paths are relative to the broker configuration directory. Each manifest requires its adjacent `.sig` and a configured Ed25519 trusted public key. Unsigned operation is unsupported by this plugin.
- All signatures and duplicate slot names are checked before the batch is published. A target or missing secret is rejected by the engine. If a later slot cannot start, slots already started by this instance are stopped.
- API credentials are read from the environment variables named in `config.secrets`. Plugins in the same process share its privileges and environment; they are trusted code, not isolated tenants.
- One plugin instance can publish multiple slots. The loader controls their provider identity and optional `_all` aggregation. Set `aggregate: true` only when those slots should participate. The broker still excludes protected slots.
- Required plugin startup failures roll back the loaded plugins and stop the broker CLI. Optional failures are logged. A domain declaration accepted before a later failure retains its owner for the broker lifetime, as with other providers; keep this plugin required when partial startup must fail closed.
- Slots stop before the tunnel. Replacing manifests requires a restart; there is no hot reload.

The designer page can independently be served from a public static mount containing `dist/ui/`. Loading the runtime plugin does not mount that page or expose its configuration files.

## Verification

Run the normal project checks. To test the compiled adapter against a local broker checkout with plugin support:

```sh
# Build mcp-open-api and the broker first
node scripts/plugin-check.mjs ../mcp-broker/node/packages/broker
```

This check starts the actual broker CLI with a generated configuration and signed manifest. It verifies the plugin package export, direct and aggregated calls, the API credential and an unauthorized caller refusal. It does not build a Docker image. On Windows, child process termination does not prove Unix signal handling; the lifecycle unit tests exercise ordered cleanup directly.

To check an image built with this plugin installed:

```sh
node scripts/plugin-check.mjs --docker broker-with-open-api
```

This starts a temporary container with read-only configuration, publishes its port on host loopback only, checks the same calls and verifies plugin cleanup on SIGTERM. The test enables private-network access for its development tokens because Docker forwards the connection through a private gateway. The container and its temporary configuration are removed afterward.

For a deployed image, verify each expected slot through broker diagnostics, `tools/list`, an authorized read and an expected denial. The broker's TCP healthcheck alone does not prove plugin readiness.
