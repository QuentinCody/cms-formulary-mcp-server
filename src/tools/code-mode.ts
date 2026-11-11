import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { formularyCatalog } from "../spec/catalog";
import { createFormularyApiFetch } from "../lib/api-adapter";
import { formularyResponse } from "../lib/tool-result";

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
): void {
    const apiFetch = createFormularyApiFetch(env.FORMULARY_DATA_DO);
    const registrar: ToolRegistrar = { tool: (...args: unknown[]) => {
        const [name, ...rest] = args;
        const handler = rest.pop() as (input: unknown, extra: unknown) => ReturnType<typeof formularyResponse>;
        const respond = (input: unknown, extra: unknown) => formularyResponse(() => handler(input, extra), env, String(name), extra, input);
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        register(name, ...rest, respond); register(`mcp_${String(name)}`, ...rest, respond);
    } };

    const searchTool = createSearchTool({
        prefix: "formulary",
        catalog: formularyCatalog,
    });
    searchTool.register(registrar);

    const executeTool = createExecuteTool({
        prefix: "formulary",
        // Verifiable provenance: formulary_execute results carry a _meta.citation.
        source: { id: "formulary", name: "CMS Part D Formulary", url: "https://data.cms.gov", license: "U.S. Public Domain" },
        catalog: formularyCatalog,
        apiFetch,
        preserveApiErrors: true,
        maxInlineBytes: 30 * 1024,
        stagingThreshold: 30 * 1024,
        timeout: 120000,
        doNamespace: env.FORMULARY_DATA_DO as DurableObjectNamespace,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(registrar);
}
