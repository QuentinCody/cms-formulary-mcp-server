import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { formularyCatalog } from "../spec/catalog";
import { createFormularyApiFetch } from "../lib/api-adapter";

/** Minimal shape needed from Env for Code Mode registration */
interface CodeModeEnv {
    FORMULARY_DATA_DO: Pick<DurableObjectNamespace, "idFromName" | "get">;
    CODE_MODE_LOADER: WorkerLoader;
}

/** Structural interface matching the .register() method on search/execute tools */
interface ToolRegistrar {
    tool: (...args: unknown[]) => void;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
) {
    const apiFetch = createFormularyApiFetch();

    const searchTool = createSearchTool({
        prefix: "formulary",
        catalog: formularyCatalog,
    });
    searchTool.register(server as unknown as ToolRegistrar);

    const executeTool = createExecuteTool({
        prefix: "formulary",
        catalog: formularyCatalog,
        apiFetch,
        doNamespace: env.FORMULARY_DATA_DO as DurableObjectNamespace,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as ToolRegistrar);
}
