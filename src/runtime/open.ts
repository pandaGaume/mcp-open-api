import type { IMessageTransport } from "@cyanmycelium/mcp-core";

/** `start()` resolving is not a connection guarantee: wait for the transport to report itself open. */
export function opened(transport: IMessageTransport, timeoutMs: number): Promise<void> {
    if (transport.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (transport.isOpen) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error(`the provider socket did not open within ${timeoutMs} ms`));
            }
        }, 10);
    });
}
