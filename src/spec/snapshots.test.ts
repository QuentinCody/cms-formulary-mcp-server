import { afterEach, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("../lib/http", () => ({ getFormularyMatches: read }));
import { createFormularyApiFetch } from "../lib/api-adapter";
import { snapshotWorkflows } from "./snapshots";
import { formularyCatalog } from "./catalog";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each((snapshotWorkflows ?? []).flatMap(workflow => ["1.1", "3.0"].map(format => ({ ...workflow, format }))))("executes catalog recipe: $title ($format)", async workflow => {
  const title = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";
  const distribution = [{ title: `${title} : 2026-09-23`, downloadURL: "https://data.cms.gov/2026_20260916.zip" }];
  const series = { "@id": "https://data.cms.gov/series/formulary", title, last: { "@id": "https://data.cms.gov/releases/fixture" } };
  const catalog = workflow.format === "1.1"
    ? { conformsTo: "https://project-open-data.cio.gov/v1.1/schema", dataset: [{ title, distribution }] }
    : { datasetSeries: [series], dataset: [{ "@id": series.last["@id"], inSeries: [{ "@id": series["@id"] }], distribution }] };
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(catalog)));
  const row = { CONTRACT_ID: "H0001", PLAN_ID: "001", SEGMENT_ID: "002" }; read.mockResolvedValue({ matched: 1, total: 1, records: [row] });
  const fetcher = createFormularyApiFetch();
  const api = { get: async (path: string, params?: Record<string, unknown>) => (await fetcher({ method: "GET", path, params })).data };
  // SAFETY: checked-in recipe text runs only against the mocked adapter.
  const run = new Function("api", `return (async () => {${workflow.code}})()`);
  expect(await run(api)).toMatchObject({ results: [row], _snapshot: { catalog_format: `DCAT-US ${workflow.format}`, snapshot: { benefit_year: "2026", snapshot_month: "2026-09" } } });
  expect(formularyCatalog.endpointCount).toBe(formularyCatalog.endpoints.length);
});

it("returns a staged snapshot handle without dereferencing its removed fields", async () => {
  const workflow = snapshotWorkflows?.[0]; if (!workflow) throw new Error("Missing recipe");
  const handle = { __staged: true, data_access_id: "fixture" }; const api = { get: vi.fn().mockResolvedValue(handle) };
  // SAFETY: checked-in recipe with a staging fixture.
  const run = new Function("api", `return (async () => {${workflow.code}})()`);
  expect(await run(api)).toBe(handle); expect(api.get).toHaveBeenCalledTimes(1);
});
