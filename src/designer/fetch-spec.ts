import { parseSpec } from "../compiler/spec";
import { DesignerError } from "./errors";

export interface ISpecFetchOptions {
    /** Origins (`https://host:port`) the designer may fetch from; anything else, redirects included, is refused. */
    readonly allowedOrigins: readonly string[];
    readonly maxBytes: number;
    /** Per request. Default 10 s. */
    readonly timeoutMs?: number;
}

export interface IFetchedSpec {
    readonly text: string;
    /** Where the spec was found: the given URL, or the one discovery led to. */
    readonly url: string;
    /** Every URL tried, in order. */
    readonly tried: readonly string[];
}

/** Where APIs commonly publish their description, tried when a URL gives a page instead of a spec. */
const WELL_KNOWN = ["openapi.json", "openapi.yaml", "swagger.json", "v3/api-docs", "api-docs", "swagger/v1/swagger.json", "openapi/v1.json", "api/v3/openapi.json"];
const MAX_REDIRECTS = 3;

type Kind = "openapi3" | "swagger2" | "other";

/**
 * Fetches an OpenAPI description by URL. A URL that answers a page (Swagger UI,
 * ReDoc, a docs portal) is searched for the spec it loads, then the usual
 * locations of its origin are tried. Only allowed origins are ever contacted:
 * the designer must not become a way to reach any address its network can.
 */
export async function fetchSpec(url: string, options: ISpecFetchOptions): Promise<IFetchedSpec> {
    const tried: string[] = [];
    const start = allowed(url, options);
    let swagger2: string | undefined;

    const attempt = async (candidate: URL): Promise<{ kind: Kind; text: string; url: string; html: boolean } | undefined> => {
        if (tried.includes(candidate.href)) return undefined;
        tried.push(candidate.href);
        const res = await get(candidate, options);
        if (!res || res.status >= 400) return undefined;
        const kind = kindOf(res.text);
        if (kind === "swagger2") swagger2 ??= res.url;
        return { kind, text: res.text, url: res.url, html: /html/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.text) };
    };

    const first = await attempt(start);
    if (first?.kind === "openapi3") return { text: first.text, url: first.url, tried };
    // The URL is a spec, of the old kind: say so, rather than search elsewhere.
    if (first?.kind === "swagger2") throw swagger2Error(first.url);

    // A page: the spec URLs it names (Swagger UI's `url:`, ReDoc's `spec-url`), its scripts' too.
    const candidates: URL[] = [];
    if (first?.html) {
        const base = new URL(first.url);
        const scripts: string[] = [];
        for (const m of first.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) if (/initializer|config|swagger|redoc/i.test(m[1]!)) scripts.push(m[1]!);
        const sources = [first.text];
        for (const src of scripts.slice(0, 4)) {
            const script = resolve(src, base, options);
            if (!script || tried.includes(script.href)) continue;
            tried.push(script.href);
            const res = await get(script, options);
            if (res && res.status < 400) sources.push(res.text);
        }
        for (const text of sources) for (const ref of specRefs(text)) candidates.push(...[resolve(ref, base, options)].filter((u): u is URL => u !== undefined));
    }
    // Then the usual places, next to the URL and at the origin's root.
    for (const path of WELL_KNOWN) {
        for (const base of [new URL("./", start), new URL("/", start)]) candidates.push(new URL(path, base));
    }

    for (const candidate of candidates) {
        if (!options.allowedOrigins.includes(candidate.origin)) continue;
        const found = await attempt(candidate);
        if (found?.kind === "openapi3") return { text: found.text, url: found.url, tried };
    }

    if (swagger2) throw swagger2Error(swagger2);
    throw new DesignerError("spec_not_found", `no OpenAPI 3 description found from ${start.href}`, tried);
}

const swagger2Error = (url: string): DesignerError =>
    new DesignerError(
        "swagger_2",
        `${url} is a Swagger 2.0 description: only OpenAPI 3.0 and 3.1 are supported. Convert it first (swagger2openapi, or editor.swagger.io), then import the result`
    );

function allowed(url: string, options: ISpecFetchOptions): URL {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new DesignerError("invalid_url", `"${url}" is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new DesignerError("invalid_url", `only http and https URLs are fetched, not ${parsed.protocol}`);
    if (parsed.username || parsed.password) throw new DesignerError("invalid_url", "a URL with credentials is refused");
    if (!options.allowedOrigins.includes(parsed.origin))
        throw new DesignerError(
            "origin_not_allowed",
            `${parsed.origin} is not an origin this designer may fetch from; allowed: ${options.allowedOrigins.join(", ") || "none"}. Add it to the host's allowedTargets, or to specOrigins in designer.json`
        );
    return parsed;
}

function resolve(ref: string, base: URL, options: ISpecFetchOptions): URL | undefined {
    try {
        const url = new URL(ref, base);
        return (url.protocol === "http:" || url.protocol === "https:") && options.allowedOrigins.includes(url.origin) ? url : undefined;
    } catch {
        return undefined;
    }
}

/** Spec URLs a page or a script names. */
function specRefs(text: string): string[] {
    const out: string[] = [];
    const patterns = [
        /\burl\s*:\s*["'`]([^"'`]+)["'`]/g, // Swagger UI: SwaggerUIBundle({ url: "..." }), urls: [{ url: "..." }]
        /\bspec-url\s*=\s*["']([^"']+)["']/g, // ReDoc
        /\bdata-url\s*=\s*["']([^"']+)["']/g, // Scalar
        /["']([^"'\s]+\.(?:json|ya?ml))(?:\?[^"'\s]*)?["']/g, // any quoted .json / .yaml
    ];
    for (const p of patterns) for (const m of text.matchAll(p)) if (!out.includes(m[1]!)) out.push(m[1]!);
    return out.filter((r) => !/\.(?:js|css|png|svg|ico)$/i.test(r) && !/^(data|javascript):/i.test(r));
}

function kindOf(text: string): Kind {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{") && !/^(openapi|swagger)\s*:/m.test(text)) return "other";
    try {
        const doc = parseSpec(text) as Record<string, unknown> | null;
        if (doc && typeof doc === "object") {
            if (typeof doc.openapi === "string" && /^3\.[01]\./.test(doc.openapi)) return "openapi3";
            if (doc.swagger === "2.0") return "swagger2";
        }
    } catch {
        // not a spec
    }
    return "other";
}

/** One GET, size-capped, following only redirects that stay within the allowed origins. */
async function get(url: URL, options: ISpecFetchOptions): Promise<{ status: number; contentType: string; text: string; url: string } | undefined> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let res: Response;
        try {
            res = await fetch(current, {
                redirect: "manual",
                headers: { accept: "application/json, application/yaml;q=0.9, text/yaml;q=0.9, text/html;q=0.5, */*;q=0.1" },
                signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            });
        } catch {
            return undefined;
        }
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            await res.body?.cancel();
            if (!location) return undefined;
            const next = new URL(location, current);
            if (!options.allowedOrigins.includes(next.origin))
                throw new DesignerError("origin_not_allowed", `${current.href} redirects to ${next.origin}, which this designer may not fetch from`);
            current = next;
            continue;
        }
        return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await capped(res, options.maxBytes), url: current.href };
    }
    throw new DesignerError("too_many_redirects", `${url.href} redirects more than ${MAX_REDIRECTS} times`);
}

async function capped(res: Response, maxBytes: number): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
        await res.body?.cancel();
        throw new DesignerError("spec_too_large", `${res.url || "the response"} is ${declared} bytes, past the ${maxBytes} limit`);
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new DesignerError("spec_too_large", `the response passes the ${maxBytes} byte limit`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
