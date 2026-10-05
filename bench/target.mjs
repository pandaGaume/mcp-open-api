// The REST API under test: a fake valve gateway, in its own process so its
// event loop is not shared with the broker. GET /valves/<id>?size=<bytes>
// answers a JSON document of about that size.
import { createServer } from "node:http";

function body(size) {
    const items = [];
    let length = 2;
    for (let i = 0; length < size; i++) {
        const item = { id: `V-${i}`, position: i % 100, state: "open", label: `valve ${i} of the north network`, history: [1, 2, 3, 4, 5, 6, 7, 8] };
        length += JSON.stringify(item).length + 1;
        items.push(item);
    }
    return Buffer.from(JSON.stringify({ items }));
}

const bodies = new Map([1024, 65536, 5 * 1024 * 1024].map((size) => [size, body(size)]));

const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const payload = bodies.get(Number(url.searchParams.get("size") ?? 1024)) ?? bodies.get(1024);
    res.writeHead(200, { "content-type": "application/json", "content-length": payload.length });
    res.end(payload);
});
server.keepAliveTimeout = 60_000;
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
