import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ matches: vi.fn() }));
vi.mock("./http", () => ({ getFormularyMatches: mocks.matches }));
import { createFormularyApiFetch } from "./api-adapter";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { formularyCatalog } from "../spec/catalog";
const title = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";
const url = "https://data.cms.gov/2026_20260916.zip";
const metadata = { title, distribution: [{ title: `${title} : 2026-09-23`, downloadURL: url }] };
function setup() {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ conformsTo: "https://project-open-data.cio.gov/v1.1/schema", dataset: [metadata] })));
  return createFormularyApiFetch();
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each([{ limit: -1 }, { limit: 1001 }, { offset: -1 }, { offset: 0.5 }, { limit: 1, size: 2 }])("rejects invalid pages before upstream discovery", async params => {
  await expect(setup()({ method: "GET", path: "/plans", params })).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});
it("retains partial-page completeness through API staging", async () => {
  mocks.matches.mockResolvedValue({ matched: 2003, total: 10000, records: [{ ID: "last" }] });
  expect(await setup()({ method: "GET", path: "/formulary", params: { NDC: "001", offset: 2002, limit: 1 } })).toMatchObject({
    completeness: { complete: false, returned: 1, total_available: 2003 }, data: { next_offset: null, truncated: true, results: [{ ID: "last" }] },
  });
});
it.each(["/plans", "/costs", "/monthly"])("attaches selected snapshot to %s without treating controls as field filters", async path => {
  const row = { CONTRACT_ID: "H0001", PLAN_ID: "001", SEGMENT_ID: "002", PLAN_SUPPRESSED_YN: "Y", future_column: "retain" };
  mocks.matches.mockResolvedValue({ matched: 1, total: 1, records: [row] });
  expect(await setup()({ method: "GET", path, params: { snapshot_month: "2026-09", benefit_year: "2026", CONTRACT_ID: "H0001", limit: 1 } })).toMatchObject({ data: { results: [row], _snapshot: { snapshot: { benefit_year: "2026", snapshot_month: "2026-09", catalog_release_date: "2026-09-23", filename_date: "2026-09-16" }, metadata } } });
});
it("passes only data filters to streaming and retains new native fields", async () => {
  const row = { NDC: "00012345678", SELECTED_DRUG_YN: "Y", TIER_LEVEL_VALUE: "6", future_field: "retain" };
  mocks.matches.mockResolvedValue({ matched: 1, total: 500, records: [row] });
  expect(await setup()({ method: "GET", path: "/formulary", params: { release_url: url, NDC: "00012345678" } })).toMatchObject({ data: { results: [row], _snapshot: { snapshot: { url } } } });
  expect(mocks.matches.mock.calls[0][0]).toEqual({ NDC: "00012345678" });
});
it("exposes discovery and rejects writes and unknown controls on discovery", async () => {
  const api = setup();
  expect(await api({ method: "GET", path: "/snapshots" })).toMatchObject({ data: { snapshots: [{ url }] } });
  expect(await api({ method: "GET", path: "/snapshot" })).toMatchObject({ data: { snapshot: { url } } });
  await expect(api({ method: "GET", path: "/snapshots", params: { limit: 1 } })).rejects.toMatchObject({ status: 400 });
  await expect(api({ method: "POST", path: "/plans" })).rejects.toMatchObject({ status: 405 });
});

it("stages full native rows and snapshot metadata with a bounded handle", async () => {
  const api = setup();
  const row = { CONTRACT_ID: "H0001", PLAN_ID: "001", SEGMENT_ID: "002", notes: "α".repeat(20000) };
  mocks.matches.mockResolvedValue({ matched: 1, total: 1, records: [row] });
  const stored: unknown[] = [];
  // SAFETY: fixture implements shared staging's two required DO methods.
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      // SAFETY: request originates from shared staging under test.
      const payload = await request.json() as { data: unknown }; stored.push(payload.data);
      return Response.json({ success: true, tables_created: ["payloads"], total_rows: 1 });
    }
    return Response.json({ success: true, schema: { tables: { payloads: { columns: [{ name: "root_json" }] } } } });
  } }) } as unknown as DurableObjectNamespace;
  const proxy = createApiProxyTool({ apiFetch: api, catalog: formularyCatalog, doNamespace: namespace, stagingPrefix: "formulary", maxInlineBytes: 30 * 1024 });
  const result = await proxy.handler({ method: "GET", path: "/plans" }, { sql: () => [] });
  expect(result).toMatchObject({ __staged: true, data_access_id: expect.any(String) });
  expect(stored.map(value => typeof value === "string" ? JSON.parse(value) : value)).toEqual(expect.arrayContaining([expect.objectContaining({ results: [row], _snapshot: expect.objectContaining({ metadata, snapshot: expect.objectContaining({ url }) }) })]));
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(100000);
});
