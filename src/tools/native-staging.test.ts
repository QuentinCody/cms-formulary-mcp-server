/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { FormularyDataDO } from "../do";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { formularyCatalog } from "../spec/catalog";
import { McpServer } from "@bio-mcp/shared/mcp";
import { verifyCitationEnvelope } from "@bio-mcp/shared";
import { registerQueryData } from "./query-data";

it("recovers source metadata chunks beside native TEXT rows through both query aliases", async () => {
  const db = new DatabaseSync(":memory:");
  let ready = Promise.resolve();
  const sql = { exec: (query: string, ...values: SQLInputValue[]) => {
    const rows = db.prepare(query).all(...values); const iterator = rows[Symbol.iterator]();
    return { toArray: () => rows, one: () => rows[0], next: () => iterator.next(), [Symbol.iterator]: () => iterator };
  } };
  const transactionSync = <T>(run: () => T): T => {
    db.exec("BEGIN");
    try { const value = run(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const ctx = { storage: { sql, transactionSync }, blockConcurrencyWhile: (run: () => Promise<void>) => { ready = run(); return ready; } };
  const instance = new FormularyDataDO(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => { await ready; return instance.fetch(request); } }) } as unknown as DurableObjectNamespace;
  const native = { results: [{ CONTRACT_ID: "H0028", PLAN_ID: "007", SEGMENT_ID: "000", coin_amt_pref_insln: " .2500 ", note: " Óá " }], _snapshot: { original_metadata: "α🧬".repeat(50000) } };
  const proxy = createApiProxyTool({ apiFetch: async () => ({ status: 200, data: native }), catalog: formularyCatalog, doNamespace: namespace, stagingPrefix: "formulary", maxInlineBytes: 30720 });
  const server = new McpServer({ name: "fixture", version: "1" }); registerQueryData(server, { FORMULARY_DATA_DO: namespace });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }> })._registeredTools;
  try {
    const staged = await proxy.handler({ method: "GET", path: "/insulin-costs" }, { sql: () => [] }) as { data_access_id: string };
    for (const prefix of ["", "mcp_"]) {
      const rows = async (query: string) => {
        const args = { data_access_id: staged.data_access_id, sql: query, limit: 100 };
        const result = await tools[`${prefix}formulary_query_data`].handler(args, {});
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const proof = await verifyCitationEnvelope({ citation: result.structuredContent._meta.citation, structuredContent: result.structuredContent, toolArguments: args });
        expect(proof.verification).toMatchObject({ query: "verified", result: "verified" });
        return result.structuredContent.data.rows;
      };
      const restored = await rows('SELECT "CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "coin_amt_pref_insln", "note" FROM results');
      expect(restored).toEqual(native.results);
      const root = (await rows("SELECT root_json FROM payloads ORDER BY id LIMIT 1"))[0].root_json;
      expect(root).toMatch(/^__CHUNKED__:/);
      const id = root.slice(12); expect(id).toMatch(/^chunk_[a-f0-9]+$/);
      let raw = "";
      const chunks = await rows(`SELECT chunk_index, length(chunk_data) AS n FROM content_chunks WHERE content_id = '${id}' ORDER BY chunk_index`);
      for (const chunk of chunks) {
        for (let start = 1; start <= chunk.n; start += 2000) raw += (await rows(`SELECT substr(chunk_data, ${start}, 2000) AS part FROM content_chunks WHERE content_id = '${id}' AND chunk_index = ${chunk.chunk_index}`))[0].part;
      }
      const decoded = JSON.parse(raw);
      expect(typeof decoded === "string" ? JSON.parse(decoded) : decoded).toEqual(native);
    }
  } finally { db.close(); }
});
