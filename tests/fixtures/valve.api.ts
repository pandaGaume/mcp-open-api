import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface IReceived {
    readonly method: string;
    readonly url: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
}

/**
 * A fake valve gateway, the REST API under test. It records every request it
 * receives, so a test can check what reached it, and what did not.
 */
export class ValveApi {
    readonly received: IReceived[] = [];
    private _server: Server | null = null;

    get baseUrl(): string {
        return `http://127.0.0.1:${(this._server!.address() as AddressInfo).port}/api/v2`;
    }

    async start(): Promise<void> {
        this._server = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                this.received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
                this._answer(req.method ?? "", new URL(req.url ?? "/", "http://x"), body, res);
            });
        });
        await new Promise<void>((resolve) => this._server!.listen(0, "127.0.0.1", resolve));
    }

    async stop(): Promise<void> {
        this._server?.closeAllConnections();
        await new Promise<void>((resolve) => this._server!.close(() => resolve()));
    }

    private _answer(method: string, url: URL, body: string, res: import("node:http").ServerResponse): void {
        const json = (status: number, value: unknown, type = "application/json") => {
            const text = JSON.stringify(value);
            res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
            res.end(text);
        };
        const path = url.pathname.replace(/^\/api\/v2/, "");
        let m: RegExpExecArray | null;
        if (method === "GET" && path === "/valves") {
            return json(200, { items: Array.from({ length: 120 }, (_, i) => ({ id: `V-${String(i).padStart(3, "0")}`, state: "open", position: i % 100, internal: "x" })) });
        }
        if (method === "GET" && (m = /^\/valves\/([^/]+)$/.exec(path))) {
            return json(200, { id: decodeURIComponent(m[1]!), position: 42, state: "open", updatedAt: "2026-10-05T10:00:00Z", internalNote: "not for agents" });
        }
        if (method === "PUT" && (m = /^\/valves\/([^/]+)\/position$/.exec(path))) {
            const sent = JSON.parse(body) as { position: number; mode: string };
            return json(200, { id: decodeURIComponent(m[1]!), position: sent.position, mode: sent.mode });
        }
        if (path === "/big") return json(200, { blob: "x".repeat(2 * 1024 * 1024) });
        if (path === "/slow") return; // never answers
        if (path === "/moved") {
            res.writeHead(302, { location: "http://evil.example/" });
            res.end();
            return;
        }
        if (path === "/broken") return json(503, { title: "Gateway in maintenance", detail: "Back at 12:00", status: 503 }, "application/problem+json");
        return json(404, { error: "not found" });
    }
}
