import { McpAdapterBase, McpBehavior, type IMcpRequestContext, type McpTool, type McpToolResult } from "@cyanmycelium/mcp-core";

import type { ManifestEngine } from "./engine";

class ManifestAdapter extends McpAdapterBase {
    constructor(private readonly _engine: ManifestEngine) {
        super(_engine.manifest.slot);
    }

    // Resources (option 6 of the binding) are not served yet.
    async readResourceAsync(): Promise<undefined> {
        return undefined;
    }

    executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, request?: IMcpRequestContext): Promise<McpToolResult> {
        return this._engine.callToolAsync(toolName, args, request);
    }
}

/** A manifest as an mcp-core behavior: its tools, served by a {@link ManifestEngine}. */
export class ManifestBehavior extends McpBehavior {
    constructor(private readonly _engine: ManifestEngine) {
        super(new ManifestAdapter(_engine), { namespace: _engine.manifest.slot });
    }

    protected override _buildTools(): McpTool[] {
        return this._engine.tools.map((tool) => ({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
        }));
    }
}
