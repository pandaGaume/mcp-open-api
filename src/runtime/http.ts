import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { HttpCallError, type IHttpRequest, type IHttpResponse, type IHttpTransport } from "./transport";

export { HttpCallError, type IHttpRequest, type IHttpResponse, type IHttpTransport } from "./transport";

/**
 * One keep-alive pool per target origin. Without connection reuse, every call
 * pays the TCP and TLS handshakes (bench/run.mjs: 0.2 ms and 27 % of the
 * throughput on loopback alone, one to three round trips over a real network).
 */
export class HttpPool implements IHttpTransport {
    private readonly _http: HttpAgent;
    private readonly _https: HttpsAgent;

    constructor(maxSockets = 64) {
        this._http = new HttpAgent({ keepAlive: true, maxSockets });
        this._https = new HttpsAgent({ keepAlive: true, maxSockets });
    }

    /**
     * Sends one request. Redirects are not followed: a 3xx is an error, so a
     * target can never send the engine to an origin nobody allowed. The body
     * is read under `maxResponseBytes`, measured as it streams in: a response
     * is never buffered whole before it is measured.
     */
    send(req: IHttpRequest): Promise<IHttpResponse> {
        const secure = req.url.protocol === "https:";
        const send = secure ? httpsRequest : httpRequest;
        return new Promise((resolve, reject) => {
            const outgoing = send(req.url, { method: req.method, headers: req.headers, agent: secure ? this._https : this._http }, (res: IncomingMessage) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                    res.resume();
                    reject(new HttpCallError("redirect", `the target answered ${status}; redirects are not followed`));
                    return;
                }
                const declared = Number(res.headers["content-length"]);
                if (Number.isFinite(declared) && declared > req.maxResponseBytes) {
                    outgoing.destroy();
                    reject(new HttpCallError("too_large", `the response announces ${declared} bytes, over the ${req.maxResponseBytes} allowed`));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > req.maxResponseBytes) {
                        outgoing.destroy();
                        reject(new HttpCallError("too_large", `the response exceeds the ${req.maxResponseBytes} bytes allowed`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => resolve({ status, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
                res.on("error", (error) => reject(new HttpCallError("network", error.message)));
            });
            outgoing.setTimeout(req.timeoutMs, () => outgoing.destroy(new HttpCallError("timeout", `no response within ${req.timeoutMs} ms`)));
            outgoing.on("error", (error) => reject(error instanceof HttpCallError ? error : new HttpCallError("network", error.message)));
            outgoing.end(req.body);
        });
    }

    close(): void {
        this._http.destroy();
        this._https.destroy();
    }
}
