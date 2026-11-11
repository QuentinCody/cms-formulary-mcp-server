import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";
import { NetworkStore } from "./lib/network-store";
import { handleNetworkRequest } from "./lib/network-route";

export class FormularyDataDO extends RestStagingDO {
  private network?: NetworkStore;
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/network-import/")) {
      this.network ??= new NetworkStore(this.sql, work => this.ctx.storage.transactionSync(work));
      return handleNetworkRequest(request, this.network);
    }
    return super.fetch(request);
  }

  protected getSchemaHints(data: unknown): SchemaHints | undefined {
    if (!data || typeof data !== "object") return undefined;
    const rows = "results" in data && Array.isArray(data.results) ? data.results : undefined;
    const sample = rows ? rows[0] : Array.isArray(data) ? data[0] : data;
    if (!sample || typeof sample !== "object") return undefined;
    const columns = Object.keys(sample);
    const lookup = new Set(columns.map(column => column.toUpperCase()));
    let tableName: string;
    if (lookup.has("NDC")) tableName = "formulary_drugs";
    else if (lookup.has("COPAY_AMT_PREF_INSLN")) tableName = "insulin_cost";
    else if (lookup.has("COST_AMT_PREF") || lookup.has("DAYS_SUPPLY")) tableName = "beneficiary_cost";
    else if (lookup.has("CONTRACT_ID") && lookup.has("PLAN_ID")) tableName = "plan_info";
    else return undefined;
    return {
      ...(rows ? {} : { tableName }),
      indexes: columns.filter(column => ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "FORMULARY_ID", "NDC", "TIER", "TIER_LEVEL_VALUE", "DAYS_SUPPLY"].includes(column.toUpperCase())),
      columnTypes: Object.fromEntries(columns.map(column => [column, "TEXT"])),
    };
  }
}
