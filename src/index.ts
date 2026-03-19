// CMS Formulary MCP Server — Medicare formulary coverage and restrictions
// Code Mode only: cms_formulary_search, cms_formulary_execute, query_data, get_schema
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerQueryData } from "./tools/query-data";
import { registerGetSchema } from "./tools/get-schema";
import { registerCodeMode } from "./tools/code-mode";
import { FormularyDataDO } from "./do";

export { FormularyDataDO };

export class MyMCP extends McpAgent<Env> {
    server = new McpServer({
        name: "cms-formulary",
        version: "0.1.0",
    });

    async init() {
        registerQueryData(this.server, this.env);
        registerGetSchema(this.server, this.env);
        registerCodeMode(this.server, this.env);
    }
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
            return new Response("ok", {
                status: 200,
                headers: { "content-type": "text/plain" },
            });
        }

        if (url.pathname === "/mcp") {
            return MyMCP.serve("/mcp", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
        }

        return new Response("Not found", { status: 404 });
    },
};
