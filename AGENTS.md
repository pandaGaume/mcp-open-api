# AGENT.md, mcp-open-api

This guide is for an AI agent asked to modify, integrate or deploy this project without prior context. Read the referenced sources before changing their contracts. Run commands from the repository root unless stated otherwise.

The diagnostic, topology and testing practices are adapted from mcp-broker's `AGENTS.md`. For container deployments, use the mcp-broker Dockerfile: the open-api slot must ship alongside the broker in that container. This repository has its own commands and constraints.

## 0. Working rules

- Never use the U+2014 character in responses, comments, documents or commits.
- Inspect `git status` and preserve the user's changes.
- Edit sources in `src/` and `ui/`. `dist/` is generated and ignored by Git.
- Check `package.json` scripts and workflows before suggesting a command.
- Preserve signature verification, broker authorization and engine limits. Fix the cause of a refusal instead of disabling these checks.
- Keep secrets and private keys out of the repository, images and logs. The current `.gitignore` does not protect `.env` or `.pem` files.
- Distinguish a proposed procedure, an executed command and a verified result. A successful build does not prove deployment success.

## 1. What the project does

`@cyanmycelium/mcp-open-api` turns an OpenAPI specification and a binding into a canonical manifest. An operator reviews the tools and approves the manifest by signing it with an Ed25519 key. A host interprets this manifest and publishes an MCP slot through a broker.

```text
OpenAPI + binding -> compilation -> manifest -> approval and signature
                                                     |
                                                     v
MCP client -> broker -> mcp-open-api host -> REST API
```

The designer page is static: it imports a specification, lets an operator select and configure operations, performs a simulation, then exports the manifest and its signature. URL imports make requests from the browser and depend on the source's CORS configuration. A simulation does not prove that a real call will work.

The host verifies manifests, resolves secrets from its environment and executes calls under the broker's authorization, constraints and audit. It can run as a separate Node process or be embedded in the broker process through the library. The broker itself does not read manifests.

A host can publish several manifests, with one slot per manifest. When APIs require process isolation for their secrets, use separate hosts; the container deployment expected here ships them alongside the broker.

## 2. Choose the use case

| Need | Action |
| --- | --- |
| Modify the page or try the designer | Build, then run `npm run demo:designer` |
| Design without the interface | Use the `compile` CLI command, then have the manifest approved and signed |
| Run manifests with an existing broker | Use `node dist/bin.js serve --config <file>` |
| Integrate into a Node application | Verify the signature, then use the library exports |
| Run inside the broker process | Configure `@cyanmycelium/mcp-open-api/plugin` in `plugins[]`; use `serveManifest` for a manual integration |
| Publish the page | Use the GitHub Pages workflow with the `dist/ui/` artifact |
| Deploy in a container | Use the mcp-broker Dockerfile and ship the open-api slot alongside the broker, see section 7 |
| Publish an npm version | Use the release workflow triggered by a `v*` tag |

## 3. Where to make changes

| Path | Responsibility |
| --- | --- |
| `src/binding/`, `schemas/binding-1.schema.json` | Binding format and validation |
| `src/compiler/` | OpenAPI parsing, diagnostics, compilation and canonical JSON |
| `src/designer/` | Design session and specification imports |
| `ui/` | Page HTML, CSS and JavaScript |
| `src/manifest/` | Manifest contract |
| `src/runtime/` | Validation, HTTP requests, authorization, projections and transports |
| `src/host/` | Configuration, signatures and slot lifecycle |
| `src/cli.ts`, `src/bin.ts` | CLI and process startup |
| `tests/`, `scripts/serve-check.mjs` | Unit tests, integrations and verification of the compiled binary |
| `docs/binding.md`, `docs/compiler.md` | Design and detailed contracts |
| `tsup.config.ts` | Node and browser bundles, copying `ui/` into `dist/ui/` |

Some documentation sections describe planned features. Confirm functionality in the code and tests. Overlay, Arazzo, MCP resources, secrets read from mcp-vault and real trials from the page are not currently shipped features.

## 4. Local development

Use Node 22, as in CI. The package declares a minimum of 20.11 for the compiler alone; the host with provider authentication requires Node 22 or later.

```sh
npm ci
npm run build
npm run demo:designer
```

Open the printed URL, which defaults to `http://127.0.0.1:3790/`. The demo also starts a fake valve API on a free port and writes a temporary host configuration and key pair. It prints their locations. It does not start the broker. Stop it with Ctrl+C.

To choose the page port:

```sh
npm run demo:designer -- 3791
```

There is no `npm run dev` script or configured automatic reload. After changes, rebuild and refresh the page; restart the demo if necessary. Demo data and keys are temporary and for development only.

### Verify a change

Reproduce the issue and choose tests that cover the changed behavior. Before declaring an executable change ready, follow the CI checks:

```sh
npm run format
npm run build
npm run smoke
npm run typecheck
npm test
```

`smoke` loads the compiled exports with Node, then starts a real test broker, signs a manifest and calls a tool through the binary. Vitest alone does not verify actual ESM loading or execution with dynamic code generation disabled.

For integrations, use `startTestBroker()` from `@cyanmycelium/mcp-broker/testing`, as the existing tests do. It tests real exchanges with identities and a policy without an external OAuth server. Avoid replacing authorization checks with mocks that allow everything.

A documentation-only change does not require rerunning the entire suite. Check its commands, links and consistency with the code.

## 5. Compile, approve and serve an API

After building the project, use the local binary to test the changes in this checkout:

```sh
node dist/bin.js compile /data/vannes.binding.json --out /data/vannes.json
node dist/bin.js keygen --out /secure/operator
node dist/bin.js sign /data/vannes.json --key /secure/operator.pem
node dist/bin.js serve --config /data/mcp-open-api.json
```

These paths are examples to adapt. Create the directories before use. Generate a key only when initializing a signing identity; retain the existing key for subsequent publications. The signature represents operator approval: the AI prepares the manifest for review and signs it when that approval has been authorized.

The specification is read from `spec.path`, relative to the binding, or from `--spec <file>`. The CLI expects a local specification. The compiler works on bytes and does not fetch URLs itself.

Example host configuration:

```json
{
    "broker": {
        "url": "ws://127.0.0.1:3000/providers",
        "secretEnv": "MCP_OPEN_API_SECRET",
        "aggregate": false
    },
    "manifests": ["manifests/vannes.json"],
    "trustedKeys": ["keys/operator.pub.pem"],
    "allowedTargets": ["https://ot-gw.local"],
    "secrets": {
        "otGateway": { "env": "OT_GATEWAY_TOKEN" }
    }
}
```

- Match the origin to the manifest's actual target and the secret references to its `target.auth`.
- Resolve `manifests` and `trustedKeys` relative to the configuration file.
- Place `vannes.json.sig` next to `vannes.json`. Changing signed content requires new approval and a new signature; reformatting alone preserves the canonical signature.
- When loading a directory, put only manifests in it: the host examines its `*.json` files without recursive traversal.
- Inject the variables named by `secretEnv` and `secrets`. The host does not automatically load a `.env` file.
- Keep `allowUnsigned` disabled in production. This option is for development only.
- Keep dynamic code generation disabled at runtime. The `serve` CLI relaunches itself with `--disallow-code-generation-from-strings`; do not use `MCP_OPEN_API_ALLOW_CODE_GENERATION=1` to hide a regression.
- Restart the host after updating files: no automatic reload is implemented.

For library integration, consult the README, `verifyManifest`, `serveManifestOver`, `serveManifest` and `buildManifestDeclaration`. Verify the signature before serving a manifest through these functions. Install the runtime peer `@cyanmycelium/mcp-core` in the consuming application.

## 6. Apply mcp-broker best practices

If a broker is accessible over MCP, start with `broker_diagnose({ slot })`. Consult `broker_info`, `providers_list`, `provider_status({ name })` and `broker_guide({ topic: "deploy" })` or `broker_guide({ topic: "troubleshooting" })`. Its guide reflects its effective configuration and version.

Keep transports paired with their URL paths:

| Usage | Transport | URL |
| --- | --- | --- |
| `serve` CLI, several slots | `MultiplexTransport` | `ws://<broker>:3000/providers` |
| Dedicated integration for one slot | `DirectTransport` | `ws://<broker>:3000/provider/<slot>` |
| MCP client | Streamable HTTP | `http://<broker>:3000/<slot>/mcp` |
| Integration inside the broker | Loopback | No socket |

`/providers/<slot>` is not a valid provider URL. Use `wss` and `https` when required by TLS termination.

The provider must have its own identity in the broker's security file, with a secret, `subjects` if needed and `allowedResources` covering its declarations. Declaring a domain describes capabilities and limits; broker roles and assignments grant client permissions. A different identity cannot take over an already owned domain during the broker's lifetime.

Use broker 1.7.0 or later for per-slot declarations and pattern-based limits, and 1.10.0 or later for loading through `plugins[]`. Development tests use the 1.10.0 or later reference in `package.json`. Do not weaken limits returned by the broker. Preserve caller references, audit results and `traceparent` throughout execution.

Aggregation into `_all` is explicit: configure `broker.aggregate: true` when needed and verify `tools/list` on `_all`. Use the tool names returned by the broker without reconstructing their prefixes. For a stdio bridge, follow the broker's configuration using `_all` and verify client identity when authorization is enabled. Protected slots remain subject to broker restrictions.

An open socket proves neither acceptance of a declaration nor a successful call. Verify the slot, MCP initialization, `tools/list` and an authorized read call. Stop hosts and close test sessions when finished.

## 7. Deploy the slot with the mcp-broker container

The reference Dockerfile is `node/packages/broker/Dockerfile` in the mcp-broker repository. The expected deployment ships the broker and open-api slot in that same container. Changes to the image and its startup must fit this shared deployment.

### Generic plugin contract

The central broker remains independent of slot implementations. Do not add mcp-open-api to the broker's dependencies, optional dependencies or implementation-specific code branches. Its generic `plugins[]` configuration names modules supplied by the deployment.

The loader is available in mcp-broker starting with version 1.10.0. The adapter lives in `src/plugin/index.ts`, exported as `@cyanmycelium/mcp-open-api/plugin`. Use a version of mcp-open-api containing this export, or its local build.

The API v1 contract consists of `apiVersion: 1` and `start(context, config)`, which returns a `stop()` handle. The context exposes `baseDir`, `registerSlot`, `onCleanup` and `log`. Provider identities come from the broker's security file; configuration selects the identity and aggregation, and the plugin does not receive its provider secret. The broker retains authorization decisions and slot protection. Plugins are trusted code in the same process, without privilege isolation.

The open-api plugin verifies all signatures and duplicate slot names before publishing the batch. It uses a shared HTTP pool, secrets referenced through environment variables and loopback integration. On a later failure, it stops slots already started. The loader cleans up partial resources and stops plugins in reverse order before the tunnel. A required plugin failure aborts startup; an explicitly optional plugin produces a diagnostic. Cleanup failures remain fatal.

Follow `docs/plugin.md` for the full configuration and deployment commands. The `plugins[].config` section receives `manifests`, `trustedKeys`, `allowedTargets` and `secrets`. It does not use `broker.url`: the plugin publishes inside the existing process. Manifest and key paths are relative to the broker configuration. The plugin requires signatures and does not accept `allowUnsigned`.

Do not configure `mcp-open-api serve` as a `stdioUpstreams` entry: this command talks to the broker over WebSocket, not stdin/stdout. This project's JSON manifests are not `.mcpb` bundles. The standalone CLI remains useful for development or process isolation.

### Prepare the shared image

The broker Dockerfile uses Node 22 and a multi-stage build. Build from its `node/` directory with `docker build -f packages/broker/Dockerfile -t broker-with-plugins .`. The build uses the workspace lockfile and compiles the provider codec first, then the broker.

The plugin layer reads `node/packages/broker/plugins/package.json` and its lockfile, which are empty by default. The deployment installs the selected versions there, or a tarball produced by `npm pack`; the Dockerfile then runs `npm ci --omit=dev` and copies this composition into `/opt/mcp-broker-plugins`. Adding a slot does not change the broker package. The loader downloads nothing at startup. `MCP_BROKER_PLUGINS_DIR` selects the directory of installed packages, while relative local modules resolve from the broker configuration directory.

Mount the broker configuration and security file, manifests with their `.sig` files and public keys read-only. Inject secrets at runtime and keep private keys outside the image. Verify that the mcp-core runtime peer is present in the plugin composition. Run as the image's unprivileged user and keep private files outside public mounts.

### Network, page and verification

The broker provides the public port, defaulting to 3000, and listens on `0.0.0.0` inside the container. The loopback plugin opens no additional port. The REST API must be accessible from this container; choose that URL before compilation and signing, then match `allowedTargets` to its exact origin.

To host the designer page too, mount only `dist/ui/` with `www.mounts`, for example under `/open-api/`. This static mount does not start the slot. MCP requests from a page remain subject to the broker's allowed-origin configuration.

After building both projects, `node scripts/plugin-check.mjs ../mcp-broker/node/packages/broker` verifies loading from the CLI configuration, a direct call, an aggregated call, the API secret and an authorization refusal. `node scripts/plugin-check.mjs --docker <image>` performs the same check in an image with the plugin installed and also verifies plugin shutdown on SIGTERM.

Keep the broker's TCP healthcheck and verify every expected slot through diagnostics, MCP initialization and `tools/list`. The port may listen while plugins are still starting, and an optional plugin may be absent while the broker remains active. Manifest changes require a restart; there is no automatic reload.

## 8. Publish the page on GitHub Pages

The `.github/workflows/pages.yml` workflow builds the project, configures Pages and publishes `dist/ui/`. It is triggered by selected changes on `main` and manually through `workflow_dispatch`. A documentation-only change does not trigger this workflow.

GitHub repository prerequisite: **Settings > Pages > Build and deployment > Source > GitHub Actions**. The workflow assumes Pages is already enabled. If `actions/configure-pages@v5` returns `Get Pages site failed` and `Not Found`, check this setting, then rerun all jobs. Adding `enablement` without checking permissions and the token does not guarantee activation.

Keep `contents: read` and `pages: read` for setup, and `pages: write` and `id-token: write` for the deployment job. The deployment depends on the build and uses the `github-pages` environment.

After a successful deployment, open `https://pandagaume.github.io/mcp-open-api/` and verify the HTML, CSS, JavaScript and a specification import. Keep asset paths compatible with the `/mcp-open-api/` subpath. GitHub Pages hosts the designer page; manifest execution requires the host and broker.

## 9. Publish to npm

The `.github/workflows/release.yml` workflow responds to `v*` tags, runs checks, publishes the public package with OIDC provenance, then creates a GitHub release. The npm trusted publisher must match the repository and workflow.

When a release is requested, check the version in `package.json` and the lockfile, run the checks, then follow the authorized versioning and tagging procedure. Push the intended tag explicitly: do not assume `--follow-tags` publishes a lightweight tag. Check the publication result before announcing that the version is available.

## 10. Diagnose by symptom

| Symptom | Check and action |
| --- | --- |
| Local page does not start | Build, check `dist/ui/designer-core.js`, then check the demo port |
| URL import fails in the page | Inspect browser network requests and the source's CORS configuration; try a local specification file |
| No manifest is compiled | Read all diagnostics; check the specification hash, operations, schemas and required arguments |
| Signature refused | Check the `.sig` file, signed content and trusted public key; obtain new approval for any content change |
| Missing secret variable | Check the process's actual environment and the names in `secretEnv` and `secrets` without displaying values |
| Target refused | Compare the exact origin of `target.baseUrl` with `allowedTargets` |
| Missing slot or initialization hangs | Run broker diagnostics; check the transport/URL pairing and connectivity |
| Declaration refused | Read all reasons; check provider identity, domain owner, namespace and `allowedResources` |
| Slot is directly accessible but absent from `_all` | Check `broker.aggregate` and broker policy |
| Call is refused or constrained | Check client identity, capabilities, assignments and the intersection of limits; preserve the checks |
| Works locally but not in the container | Check DNS, URLs using `localhost`, networking, mount permissions, the runtime peer and injected variables |
| Host is active but some tools are missing | Read the `refused` lines and compare expected manifests with actually served slots |
| GitHub Pages returns 404 | Check the GitHub Actions source setting, workflow, `dist/ui/` artifact and deployment job result |

End each intervention with the changed files, verification performed and remaining limitations. State explicitly if the actual deployment or an end-to-end call has not been verified.
