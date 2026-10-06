// The Tier 4 page of the mcp-open-api designer. Served by the broker under
// /ui/<slot>/, it talks to the designer's slot at /<slot>/mcp on the same
// origin. It signs in the browser: the private key never leaves this page.

const $ = (id) => document.getElementById(id);
const SLOT = new URLSearchParams(location.search).get("slot") ?? location.pathname.split("/").filter(Boolean)[1] ?? "designer";
const READ_METHODS = new Set(["GET", "HEAD"]);

/** Builds an element; strings become text nodes, never HTML: spec content is untrusted. */
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else if (key === "class") node.className = value;
        else if (value === true) node.setAttribute(key, "");
        else if (key === "value") node.value = value;
        else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child instanceof Node ? child : String(child));
    return node;
}

// ── MCP over Streamable HTTP ────────────────────────────────────────────────

class McpClient {
    constructor(url, token) {
        this.url = url;
        this.token = token;
        this.session = null;
        this.id = 1;
    }

    async _post(message) {
        const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
        if (this.token) headers.authorization = `Bearer ${this.token}`;
        if (this.session) headers["mcp-session-id"] = this.session;
        const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(message) });
        if (res.status === 401 || res.status === 403)
            throw new Error(`the broker refused the call (HTTP ${res.status}): check the token, and that this origin is in allowedOrigins`);
        return res;
    }

    async _read(res, id) {
        const text = await res.text();
        if (!text) return undefined;
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
        for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const message = JSON.parse(line.slice(5));
            if (message.id === id) return message;
        }
        return undefined;
    }

    async connect() {
        const res = await this._post({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-open-api designer page", version: "1" } },
        });
        const answer = await this._read(res, 0);
        if (!res.ok || !answer || answer.error) throw new Error(answer?.error?.message ?? `initialize failed: HTTP ${res.status}`);
        this.session = res.headers.get("mcp-session-id");
        await this._post({ jsonrpc: "2.0", method: "notifications/initialized" });
        return answer.result;
    }

    async tool(name, args = {}) {
        const id = this.id++;
        const res = await this._post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
        const answer = await this._read(res, id);
        if (!answer) throw new Error(`no answer to ${name} (HTTP ${res.status})`);
        if (answer.error) throw new Error(answer.error.message);
        const result = answer.result;
        const text = result.content?.[0]?.text ?? "{}";
        if (result.isError) {
            let error;
            try {
                error = JSON.parse(text).error;
            } catch {
                error = { message: text };
            }
            throw Object.assign(new Error(error.message), { code: error.code, problems: error.problems });
        }
        return result.structuredContent ?? JSON.parse(text);
    }

    close() {
        if (!this.session) return;
        const headers = { "mcp-session-id": this.session };
        if (this.token) headers.authorization = `Bearer ${this.token}`;
        fetch(this.url, { method: "DELETE", headers, keepalive: true }).catch(() => {});
        this.session = null;
    }
}

// ── State ───────────────────────────────────────────────────────────────────

const state = {
    mcp: null,
    hosts: [],
    draft: null,
    binding: null,
    review: null,
    approvals: new Set(),
    key: null,
    timer: null,
    pending: Promise.resolve(),
};

function setStatus(text, kind) {
    const s = $("status");
    s.textContent = text;
    s.className = `status ${kind ?? ""}`;
}

function show(id, visible = true) {
    $(id).hidden = !visible;
}

function problemList(error) {
    return el(
        "div",
        { class: "notice error" },
        el("strong", {}, error.message),
        error.problems?.length
            ? el(
                  "ul",
                  {},
                  error.problems.map((p) => el("li", {}, p))
              )
            : null
    );
}

// ── 1. Connect and import ───────────────────────────────────────────────────

$("slot-label").textContent = `talks to /${SLOT}/mcp`;
$("token").value = sessionStorageGet("designer-token") ?? "";

function sessionStorageGet(key) {
    try {
        return sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function sessionStorageSet(key, value) {
    try {
        sessionStorage.setItem(key, value);
    } catch {
        // private mode: the operator types the token again
    }
}

/** Says what to do while the page is not connected: an empty host list is never left unexplained. */
function help(kind, ...content) {
    const box = $("connection-help");
    box.hidden = content.length === 0;
    box.className = `notice ${kind}`;
    box.replaceChildren(...content);
}

async function connect() {
    state.mcp?.close();
    const token = $("token").value.trim();
    sessionStorageSet("designer-token", token);
    state.mcp = new McpClient(new URL(`/${SLOT}/mcp`, location.origin).href, token);
    setStatus("connecting...");
    try {
        await state.mcp.connect();
        const { hosts } = await state.mcp.tool("designer_hosts");
        state.hosts = hosts;
        renderHosts();
        setStatus("connected", "on");
        help("ok");
        $("import").querySelector("button").disabled = false;
    } catch (error) {
        setStatus("not connected", "off");
        $("import").querySelector("button").disabled = true;
        const refused = /HTTP 401|HTTP 403/.test(error.message);
        help(
            "error",
            el("strong", {}, refused ? "The broker refused the page. " : `No designer answers on the slot "${SLOT}". `),
            el("span", {}, error.message),
            el(
                "ul",
                {},
                refused
                    ? [
                          el(
                              "li",
                              {},
                              "This broker authenticates its clients: paste the access token its authorization server issued you above, then Connect. A broker run without client auth (no auth section in its config, as in development) needs none."
                          ),
                          el("li", {}, `List ${location.origin} in the broker's allowedOrigins.`),
                      ]
                    : [
                          el("li", {}, "Start the designer: mcp-open-api design --config designer.json"),
                          el("li", {}, "The host list comes from the hosts of that designer.json, each the path of a host's mcp-open-api.json."),
                          el("li", {}, "To try it all on one machine: npm run build && npm run demo:designer, in the mcp-open-api repo."),
                      ]
            )
        );
    }
}

$("connect").addEventListener("submit", (event) => {
    event.preventDefault();
    void connect();
});

addEventListener("pagehide", () => state.mcp?.close());

// Connect on arrival: the page is useless until it is, and most often no token is needed or one is remembered.
if (location.protocol === "file:") {
    setStatus("not connected", "off");
    help(
        "error",
        el("strong", {}, "Open this page through the broker, not from the disk. "),
        el("span", {}, "It talks to the designer at /designer/mcp on the broker's origin: http://<broker>/ui/designer/")
    );
} else void connect();

function renderHosts() {
    $("host").replaceChildren(...state.hosts.map((h) => el("option", { value: h.name }, h.name)));
    renderSpecOrigins();
    $("hosts").replaceChildren(
        el(
            "div",
            { class: "table-wrap" },
            el(
                "table",
                {},
                el(
                    "thead",
                    {},
                    el("tr", {}, el("th", {}, "host"), el("th", {}, "allowed targets"), el("th", {}, "secrets"), el("th", {}, "trusted keys"), el("th", {}, "published slots"))
                ),
                el(
                    "tbody",
                    {},
                    state.hosts.map((h) =>
                        el(
                            "tr",
                            {},
                            el("td", {}, h.name),
                            el("td", { class: "mono" }, h.allowedTargets.join(", ")),
                            el("td", { class: "mono" }, h.secrets.join(", ") || "none"),
                            el("td", {}, String(h.trustedKeys)),
                            el("td", { class: "mono" }, h.published.map((p) => `${p.slot} (${p.sha256.slice(0, 12)})`).join(", ") || "none")
                        )
                    )
                )
            )
        )
    );
}

/** The origins the designer may fetch a spec from, for the chosen host. */
/** What the chosen host allows, and what the chosen slot name will be: the two are easy to mix up. */
function renderSpecOrigins() {
    const host = state.hosts.find((h) => h.name === $("host").value);
    $("spec-origins").textContent = host ? `The designer fetches only from: ${host.specOrigins.join(", ")}` : "";
    $("host-details").textContent = host
        ? `calls ${host.allowedTargets.join(", ") || "nothing yet"}; secrets: ${host.secrets.join(", ") || "none"}; ${host.trustedKeys} trusted key${host.trustedKeys === 1 ? "" : "s"}`
        : "";
    renderSlotDetails();
}

function renderSlotDetails() {
    const host = state.hosts.find((h) => h.name === $("host").value);
    const slot = $("slot").value.trim();
    if (!slot) {
        $("slot-details").textContent = "";
        return;
    }
    const published = host?.published.find((p) => p.slot === slot);
    $("slot-details").textContent =
        `${location.origin}/${slot}/mcp${published ? `; already published by this host (${published.sha256.slice(0, 12)}): publishing replaces it` : ""}`;
}

$("host").addEventListener("change", renderSpecOrigins);
$("slot").addEventListener("input", renderSlotDetails);

$("import").addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = $("spec-url").value.trim();
    const file = $("spec-file").files[0];
    const pasted = $("spec-text").value.trim();
    const base = { host: $("host").value, slot: $("slot").value.trim() };
    const button = $("import").querySelector("button");
    try {
        let args;
        if (url) args = { ...base, url };
        else if (file) args = { ...base, spec: await file.text() };
        else if (pasted) args = { ...base, spec: pasted };
        else throw new Error("give a URL, a file or the spec's text");
        button.disabled = true;
        button.textContent = url ? "Fetching..." : "Importing...";
        const draft = await state.mcp.tool("designer_import", args);
        $("hosts").replaceChildren(
            el(
                "p",
                { class: "muted" },
                `Imported ${draft.spec.title ?? "the spec"} ${draft.spec.version ?? ""} (OpenAPI ${draft.spec.openapi})${draft.spec.source ? ` from ${draft.spec.source}` : ""}.`
            )
        );
        state.draft = draft;
        state.binding = structuredClone(draft.binding);
        state.approvals.clear();
        for (const id of ["step-select", "step-tune", "step-try", "step-review", "step-advanced", "checks"]) show(id);
        renderOperations();
        renderSlotForm();
        renderTools();
        await update();
    } catch (error) {
        $("hosts").replaceChildren(problemList(error));
    } finally {
        button.disabled = !state.mcp?.session;
        button.textContent = "Import";
    }
});

// ── 2. Selection ────────────────────────────────────────────────────────────

$("filter").addEventListener("input", renderOperations);

function renderOperations() {
    const filter = $("filter").value.trim().toLowerCase();
    const groups = new Map();
    for (const op of state.draft.operations) {
        const text = `${op.key} ${op.method} ${op.path} ${op.summary ?? ""} ${op.tags.join(" ")}`.toLowerCase();
        if (filter && !text.includes(filter)) continue;
        const tag = op.tags[0] ?? "untagged";
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag).push(op);
    }
    const tools = state.binding.tools ?? {};
    $("operations").replaceChildren(
        ...[...groups.entries()].flatMap(([tag, ops]) => [
            el("div", { class: "tag" }, tag),
            ...ops.map((op) =>
                el(
                    "label",
                    { class: "op" },
                    el("input", { type: "checkbox", checked: op.key in tools, onchange: (e) => toggleOperation(op, e.target.checked) }),
                    el("span", { class: `badge ${op.write ? "write" : ""}` }, op.method),
                    el("span", { class: "path" }, op.path),
                    el("span", {}, op.deprecated ? el("span", { class: "badge" }, "deprecated") : null, op.write ? el("span", { class: "badge write" }, "write") : null),
                    op.summary ? el("span", { class: "summary" }, op.summary) : null
                )
            ),
        ])
    );
}

function toggleOperation(op, on) {
    const tools = { ...(state.binding.tools ?? {}) };
    if (on) tools[op.key] = tools[op.key] ?? { output: "all" };
    else delete tools[op.key];
    state.binding.tools = tools;
    renderTools();
    schedule();
}

// ── 3. Tuning ───────────────────────────────────────────────────────────────

function field(label, value, onInput, attrs = {}) {
    return el(
        "label",
        { class: attrs.wide ? "wide" : undefined },
        label,
        el(attrs.multiline ? "textarea" : "input", { value: value ?? "", rows: attrs.rows, placeholder: attrs.placeholder, oninput: (e) => onInput(e.target.value) })
    );
}

function select(label, value, options, onChange) {
    return el(
        "label",
        {},
        label,
        el(
            "select",
            { onchange: (e) => onChange(e.target.value) },
            options.map(([v, text]) => el("option", { value: v, selected: v === (value ?? "") }, text))
        )
    );
}

/** Sets or removes a key: an empty value leaves the field out of the binding. */
function put(target, key, value) {
    if (value === "" || value === undefined || value === null) delete target[key];
    else target[key] = value;
}

function renderSlotForm() {
    const b = state.binding;
    const host = state.hosts.find((h) => h.name === state.draft.host);
    const secrets = host?.secrets ?? [];
    $("slot-form").replaceChildren(
        field("Title", b.title, (v) => (put(b, "title", v), schedule())),
        field("Base URL", b.target.baseUrl, (v) => ((b.target.baseUrl = v), schedule()), { placeholder: host?.allowedTargets[0] }),
        select("Credential", b.target.auth?.secretRef ?? "", [["", "none"], ...secrets.map((s) => [s, s])], (v) => {
            if (v) b.target.auth = { ...(b.target.auth ?? {}), secretRef: v };
            else delete b.target.auth;
            schedule();
        }),
        field("Domain", b.governance?.domain, (v) => (setGovernance("domain", v), schedule()), { placeholder: "valves" }),
        field("Namespace", b.governance?.namespace, (v) => (setGovernance("namespace", v), schedule()), { placeholder: "/site/nord" }),
        field("Instructions for agents", b.instructions, (v) => (put(b, "instructions", v), schedule()), { wide: true, multiline: true, rows: 2 })
    );
}

function setGovernance(key, value) {
    const g = { ...(state.binding.governance ?? { domain: "", namespace: "" }), [key]: value };
    if (!g.domain && !g.namespace) delete state.binding.governance;
    else state.binding.governance = g;
}

function renderTools() {
    const ops = new Map(state.draft.operations.map((op) => [op.key, op]));
    const entries = Object.entries(state.binding.tools ?? {});
    $("tools").replaceChildren(
        entries.length === 0 ? el("p", { class: "muted" }, "Select operations in step 2.") : null,
        ...entries.map(([key, tool]) => toolCard(ops.get(key), key, tool))
    );
}

function toolCard(op, key, tool) {
    const locations = op?.locations ?? [];
    const auth = tool.authorization ?? {};
    const setAuth = (k, v) => {
        const next = { ...(tool.authorization ?? {}) };
        put(next, k, v);
        if (Object.keys(next).length === 0) delete tool.authorization;
        else tool.authorization = next;
        schedule();
    };
    const pickText = tool.output === "all" ? "" : (tool.output?.pick ?? []).join("\n");
    return el(
        "div",
        { class: `tool ${op?.write ? "write" : ""}` },
        el(
            "h3",
            {},
            el("span", { class: `badge ${op?.write ? "write" : ""}` }, op?.method ?? "?"),
            " ",
            el("span", { class: "mono" }, op?.path ?? key),
            " ",
            el("span", { class: "muted" }, key)
        ),
        el(
            "div",
            { class: "grid" },
            field("Tool name", tool.name, (v) => (put(tool, "name", v), schedule()), { placeholder: "default: the operationId in snake_case" }),
            field("Description for agents", tool.description, (v) => (put(tool, "description", v), schedule()), { wide: true, multiline: true, rows: 2 }),
            select(
                "Output",
                tool.output === "all" ? "all" : "pick",
                [
                    ["all", "the whole response"],
                    ["pick", "selected fields"],
                ],
                (v) => {
                    tool.output = v === "all" ? "all" : { pick: [] };
                    renderTools();
                    schedule();
                }
            ),
            tool.output === "all"
                ? null
                : field(
                      "Fields (one per line: id, items[].state)",
                      pickText,
                      (v) => {
                          tool.output = {
                              ...tool.output,
                              pick: v
                                  .split(/[\n,]/)
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                          };
                          schedule();
                      },
                      { multiline: true, rows: 3 }
                  ),
            field("Capability", auth.capability, (v) => setAuth("capability", v), { placeholder: op?.write ? "required: <domain>.write" : "<domain>.read" }),
            field("Resource path", auth.resourcePath, (v) => setAuth("resourcePath", v), { placeholder: "valves/{path.id}" }),
            select("Written value (limits)", auth.value ?? "", [["", "none"], ...locations.map((l) => [l, l])], (v) => setAuth("value", v)),
            el(
                "label",
                { class: "check" },
                el("input", { type: "checkbox", checked: auth.resultRequired === true, onchange: (e) => setAuth("resultRequired", e.target.checked || undefined) }),
                " report the result to the broker"
            ),
            field("Note for the reviewer", tool.note, (v) => (put(tool, "note", v), schedule()), { wide: true })
        ),
        locations.length > 0 ? argsTable(locations, tool) : null
    );
}

function argsTable(locations, tool) {
    const arg = (loc) => (tool.args ?? {})[loc] ?? {};
    const setArg = (loc, k, v) => {
        const args = { ...(tool.args ?? {}) };
        const next = { ...(args[loc] ?? {}) };
        put(next, k, v);
        if (Object.keys(next).length === 0) delete args[loc];
        else args[loc] = next;
        if (Object.keys(args).length === 0) delete tool.args;
        else tool.args = args;
        schedule();
    };
    const num = (v) => (v.trim() === "" ? undefined : Number(v));
    const json = (v) => {
        if (v.trim() === "") return undefined;
        try {
            return JSON.parse(v);
        } catch {
            return v;
        }
    };
    const cell = (loc, k, parse = (v) => v, placeholder) =>
        el(
            "td",
            {},
            el("input", {
                value: arg(loc)[k] === undefined ? "" : typeof arg(loc)[k] === "string" ? arg(loc)[k] : JSON.stringify(arg(loc)[k]),
                placeholder,
                oninput: (e) => setArg(loc, k, parse(e.target.value)),
            })
        );
    return el(
        "div",
        { class: "table-wrap" },
        el(
            "table",
            {},
            el(
                "thead",
                {},
                el(
                    "tr",
                    {},
                    ["argument", "name", "hide", "fixed (JSON)", "pattern", "min", "max"].map((h) => el("th", {}, h))
                )
            ),
            el(
                "tbody",
                {},
                locations.map((loc) =>
                    el(
                        "tr",
                        {},
                        el("td", { class: "mono" }, loc),
                        cell(loc, "name"),
                        el("td", {}, el("input", { type: "checkbox", checked: arg(loc).hide === true, onchange: (e) => setArg(loc, "hide", e.target.checked || undefined) })),
                        cell(loc, "fixed", json),
                        cell(loc, "pattern", (v) => v, "^V-\\d{3}$"),
                        cell(loc, "minimum", num),
                        cell(loc, "maximum", num)
                    )
                )
            )
        )
    );
}

// ── 4. Checks: the draft is compiled on every change ────────────────────────

function schedule() {
    $("binding-json").value = JSON.stringify(state.binding, null, 4);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void update(), 400);
}

async function update() {
    // One update at a time, in order: a slow answer never overwrites a newer one.
    state.pending = state.pending.then(async () => {
        try {
            state.review = await state.mcp.tool("designer_update", { draftId: state.draft.draftId, binding: state.binding });
        } catch (error) {
            state.review = { ok: false, diagnostics: [{ severity: "error", code: error.code ?? "designer", message: error.message }], writeTools: [] };
        }
        $("binding-json").value = JSON.stringify(state.binding, null, 4);
        renderChecks();
        await renderReview();
    });
    return state.pending;
}

function renderChecks() {
    const list = state.review.diagnostics ?? [];
    const errors = list.filter((d) => d.severity === "error").length;
    const warnings = list.length - errors;
    $("checks-summary").replaceChildren(
        errors > 0
            ? el("p", { class: "summary-error" }, `${errors} error${errors > 1 ? "s" : ""}, ${warnings} warning${warnings === 1 ? "" : "s"}: nothing can be published`)
            : el("p", { class: "summary-ok" }, `no error${warnings > 0 ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}`)
    );
    $("diagnostics").replaceChildren(
        ...list.map((d) =>
            el(
                "li",
                { class: d.severity },
                el("div", { class: "code-id" }, d.code),
                el("div", {}, d.message),
                d.binding ? el("div", { class: "muted mono" }, `binding ${d.binding}`) : null,
                d.spec ? el("div", { class: "muted mono" }, `spec ${d.spec}`) : null
            )
        )
    );
}

// ── 5. Trial ────────────────────────────────────────────────────────────────

$("dry-run").addEventListener("submit", async (event) => {
    event.preventDefault();
    const out = $("try-result");
    out.hidden = false;
    try {
        const args = JSON.parse($("try-args").value || "{}");
        const plan = await state.mcp.tool("designer_dry_run", { draftId: state.draft.draftId, tool: $("try-tool").value, arguments: args });
        const lines = [`${plan.method} ${plan.url}`, ...Object.entries(plan.headers).map(([k, v]) => `${k}: ${v}`)];
        if (plan.body !== undefined) lines.push("", JSON.stringify(plan.body, null, 2));
        if (plan.resourcePath) lines.push("", `broker resource: ${plan.resourcePath}`);
        out.textContent = lines.join("\n");
    } catch (error) {
        out.textContent = `${error.message}${error.problems ? `\n- ${error.problems.join("\n- ")}` : ""}`;
    }
});

// ── 6. Review, from the exact text that is signed ───────────────────────────

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const template = (parts) => (parts ?? []).map((p) => (typeof p === "string" ? p : `{${p.arg}}`)).join("");

async function renderReview() {
    const review = state.review;
    const publishButton = $("publish").querySelector("button");
    if (!review?.canonical) {
        $("review").replaceChildren(el("p", { class: "muted" }, "Nothing to review until the checks pass."));
        $("try-tool").replaceChildren();
        publishButton.disabled = true;
        return;
    }
    // The page hashes what it will sign, and shows what it parsed from it, not what it was told.
    const digest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(review.canonical)));
    const manifest = JSON.parse(review.canonical);
    const writes = manifest.tools.filter((t) => !READ_METHODS.has(t.http.method)).map((t) => t.name);
    for (const name of [...state.approvals]) if (!writes.includes(name)) state.approvals.delete(name);

    const tryTool = $("try-tool");
    const selected = tryTool.value;
    tryTool.replaceChildren(...manifest.tools.map((t) => el("option", { value: t.name, selected: t.name === selected }, t.name)));

    const d = review.diff ?? { added: [], removed: [], changed: [], slot: [] };
    $("review").replaceChildren(
        el(
            "p",
            {},
            "Manifest ",
            el("code", {}, digest),
            digest === review.sha256 ? null : el("strong", { class: "summary-error" }, " differs from the designer's hash: do not sign")
        ),
        el(
            "p",
            { class: "muted" },
            `Slot ${manifest.slot} on ${manifest.target.baseUrl}`,
            manifest.declaration ? `, domain ${manifest.declaration.domain} under ${manifest.declaration.namespace}` : ", no governance",
            review.published ? `. Replaces ${review.published.sha256.slice(0, 12)}.` : ". First publication."
        ),
        el(
            "p",
            {},
            [
                d.added.length ? `added: ${d.added.join(", ")}` : null,
                d.removed.length ? `removed: ${d.removed.join(", ")}` : null,
                ...d.changed.map((c) => `${c.tool} changed (${c.fields.join(", ")})`),
                d.slot.length ? `slot changed: ${d.slot.join(", ")}` : null,
            ]
                .filter(Boolean)
                .join("; ") || "no change"
        ),
        el(
            "div",
            { class: "table-wrap" },
            el(
                "table",
                {},
                el(
                    "thead",
                    {},
                    el(
                        "tr",
                        {},
                        ["approve", "tool", "request", "authorization", "description"].map((h) => el("th", {}, h))
                    )
                ),
                el(
                    "tbody",
                    {},
                    manifest.tools.map((t) => {
                        const write = writes.includes(t.name);
                        return el(
                            "tr",
                            {},
                            el(
                                "td",
                                {},
                                write
                                    ? el("input", {
                                          type: "checkbox",
                                          checked: state.approvals.has(t.name),
                                          "aria-label": `approve ${t.name}`,
                                          onchange: (e) => {
                                              if (e.target.checked) state.approvals.add(t.name);
                                              else state.approvals.delete(t.name);
                                              refreshPublishButton();
                                          },
                                      })
                                    : el("span", { class: "muted" }, "read")
                            ),
                            el("td", { class: "mono" }, t.name),
                            el("td", { class: "mono" }, `${t.http.method} ${template(t.http.path)}`),
                            el(
                                "td",
                                { class: "mono" },
                                t.authorization
                                    ? `${t.authorization.capability} on ${template(t.authorization.resourcePath)}${t.authorization.value ? `, value ${t.authorization.value}` : ""}`
                                    : "none"
                            ),
                            el("td", {}, t.description ?? "")
                        );
                    })
                )
            )
        ),
        manifest.declaration?.resources?.length
            ? el(
                  "p",
                  { class: "muted" },
                  "Declared limits: ",
                  manifest.declaration.resources.map((r) => `${r.resourcePattern ?? r.resourcePath} ${JSON.stringify(r.limits)}`).join("; ")
              )
            : null,
        el("details", {}, el("summary", {}, "The canonical manifest you sign"), el("pre", { class: "code" }, JSON.stringify(manifest, null, 2)))
    );
    state.reviewDigest = digest;
    state.writes = writes;
    refreshPublishButton();
}

function refreshPublishButton() {
    const review = state.review;
    const ready = review?.ok && state.key && state.reviewDigest === review.sha256 && state.writes.every((w) => state.approvals.has(w));
    $("publish").querySelector("button").disabled = !ready;
}

$("key-file").addEventListener("change", async () => {
    const file = $("key-file").files[0];
    state.key = null;
    $("publish-result").replaceChildren();
    if (file) {
        try {
            const pem = await file.text();
            const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
            state.key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
        } catch (error) {
            $("publish-result").replaceChildren(
                problemList(new Error(`this key cannot sign here: ${error.message}. It must be an Ed25519 PKCS#8 PEM, in a browser with Ed25519 in WebCrypto.`))
            );
        }
    }
    refreshPublishButton();
});

$("publish").addEventListener("submit", async (event) => {
    event.preventDefault();
    const review = state.review;
    try {
        const bytes = new TextEncoder().encode(review.canonical);
        const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
        if (digest !== review.sha256) throw new Error("the manifest's hash does not match the review: nothing was signed");
        const signature = { alg: "Ed25519", manifest: digest, signature: base64(await crypto.subtle.sign("Ed25519", state.key, bytes)) };
        const result = await state.mcp.tool("designer_publish", {
            draftId: state.draft.draftId,
            sha256: digest,
            signature,
            approvedWriteTools: [...state.approvals],
        });
        $("publish-result").replaceChildren(
            el(
                "div",
                { class: "notice ok" },
                el("strong", {}, `Published ${result.slot} (${result.sha256.slice(0, 12)}) into host ${result.host}.`),
                el("div", {}, `Next: ${result.next}.`),
                el(
                    "ul",
                    {},
                    result.files.map((f) => el("li", { class: "mono" }, f))
                )
            )
        );
        await update();
    } catch (error) {
        $("publish-result").replaceChildren(problemList(error));
    }
});

// ── Binding, raw ────────────────────────────────────────────────────────────

$("binding-apply").addEventListener("click", () => {
    try {
        state.binding = JSON.parse($("binding-json").value);
        renderSlotForm();
        renderTools();
        renderOperations();
        void update();
    } catch (error) {
        $("publish-result").replaceChildren(problemList(new Error(`the binding is not JSON: ${error.message}`)));
    }
});

$("binding-download").addEventListener("click", () => {
    const blob = new Blob([`${JSON.stringify(state.binding, null, 4)}\n`], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${state.binding.slot}.binding.json` });
    a.click();
    URL.revokeObjectURL(a.href);
});
