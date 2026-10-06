/** A minimal Streamable HTTP client: one session per caller, as an agent would hold one. */
export class McpHttpClient {
    private _session: string | null = null;
    private _id = 1;

    constructor(
        private readonly _url: string,
        private readonly _headers: Readonly<Record<string, string>>
    ) {}

    async request(method: string, params: Record<string, unknown> = {}): Promise<{ result?: any; error?: { code: number; message: string } }> {
        if (!this._session) {
            const res = await this._post({
                jsonrpc: "2.0",
                id: 0,
                method: "initialize",
                params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tests", version: "0" } },
            });
            this._session = res.headers.get("mcp-session-id");
            await res.text();
            if (!this._session) throw new Error(`no session: HTTP ${res.status}`);
        }
        const res = await this._post({ jsonrpc: "2.0", id: this._id++, method, params });
        const text = await res.text();
        const data =
            text.startsWith("event:") || text.startsWith("data:")
                ? text
                      .split("\n")
                      .find((l) => l.startsWith("data:"))!
                      .slice(5)
                : text;
        return JSON.parse(data);
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: any; content: { type: string; text: string }[] }> {
        const answer = await this.request("tools/call", { name, arguments: args });
        if (answer.error) throw new Error(`tools/call ${name}: ${answer.error.message}`);
        return answer.result;
    }

    private _post(body: unknown): Promise<Response> {
        return fetch(this._url, {
            method: "POST",
            headers: {
                ...this._headers,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(this._session ? { "mcp-session-id": this._session } : {}),
            },
            body: JSON.stringify(body),
        });
    }
}

/** The `{ error }` a failed tool result carries. */
export const errorOf = (result: { content: { text: string }[] }): { code: string; message: string; detail?: any } => JSON.parse(result.content[0]!.text).error;
