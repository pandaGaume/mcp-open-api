// What the engine needs to reach an API, with no dependency on a runtime: a
// host uses Node's keep-alive pool (`HttpPool`), the compiler uses none, and a
// browser can use `fetch`.

export interface IHttpRequest {
    readonly method: string;
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
}

export interface IHttpResponse {
    readonly status: number;
    readonly contentType: string;
    readonly body: Uint8Array;
}

/** Why a call produced no usable response. Its message never contains a header value. */
export class HttpCallError extends Error {
    constructor(
        readonly code: "timeout" | "too_large" | "network" | "redirect",
        message: string
    ) {
        super(message);
        this.name = "HttpCallError";
    }
}

/**
 * Sends the engine's requests. An implementation must not follow redirects
 * (a 3xx is a `redirect` error) and must stop reading past `maxResponseBytes`.
 */
export interface IHttpTransport {
    send(req: IHttpRequest): Promise<IHttpResponse>;
    close(): void;
}

/** A transport that sends nothing: for loading a manifest only to check it. */
export const NO_NETWORK: IHttpTransport = {
    send: () => Promise.reject(new HttpCallError("network", "this engine has no network")),
    close: () => {},
};
