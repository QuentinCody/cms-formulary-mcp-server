import { afterEach, expect, it, vi } from "vitest";
import { discoverSnapshots, parseSnapshot, selectSnapshot, snapshotControls } from "./snapshots";
const title = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";
const september = { title: `${title} : 2026-09-23`, downloadURL: "https://data.cms.gov/sites/default/files/2026-09/903ba816-d276-4c17-9b5a-0224bbd4e949/2026_20260916.zip" };
const october = { title: `${title} : 2025-10-15`, downloadURL: "https://data.cms.gov/sites/default/files/fixture/2026.20251015.zip" };
function mock(distribution: unknown[] = [october, september]) {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ conformsTo: "https://project-open-data.cio.gov/v1.1/schema", dataset: [{ title, distribution }] }));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

it("retains provider catalog and filename dates separately (September 2026 CMS example)", () => {
  expect(parseSnapshot(september)).toMatchObject({ benefit_year: "2026", snapshot_month: "2026-09", catalog_release_date: "2026-09-23", filename_date: "2026-09-16", native: september });
});
it("does not derive benefit year from release year at the October rollover", () => {
  expect(parseSnapshot(october)).toMatchObject({ benefit_year: "2026", snapshot_month: "2025-10" });
});
it("selects latest by catalog date rather than catalog order", async () => {
  mock([october, september]);
  expect((await selectSnapshot()).snapshot.url).toBe(september.downloadURL);
});
it("selects requested historical month and preserves its metadata hash", async () => {
  mock();
  const first = await selectSnapshot({ snapshot_month: "2025-10", benefit_year: "2026" });
  expect(first.snapshot.url).toBe(october.downloadURL);
  expect(await selectSnapshot({ release_url: october.downloadURL, expected_snapshot_sha256: first.snapshot_sha256 })).toMatchObject({ snapshot_sha256: first.snapshot_sha256 });
});
it("rejects stale metadata guards and absent snapshots", async () => {
  mock();
  await expect(selectSnapshot({ expected_snapshot_sha256: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
  await expect(selectSnapshot({ snapshot_month: "2024-01" })).rejects.toMatchObject({ status: 404 });
});
it("requires explicit selection for tied dates or undated distributions", async () => {
  mock([september, { ...september, downloadURL: september.downloadURL.replace("20260916", "20260917") }]);
  await expect(selectSnapshot()).rejects.toMatchObject({ status: 409 });
  mock([september, { downloadURL: "https://data.cms.gov/unknown.zip" }]);
  await expect(selectSnapshot()).rejects.toMatchObject({ status: 409 });
});
it("never falls back to February data when catalog discovery fails", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })); vi.stubGlobal("fetch", fetcher);
  await expect(selectSnapshot()).rejects.toMatchObject({ status: 503 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("uses the current catalog and rejects unqualified formats", async () => {
  const fetcher = mock(); await discoverSnapshots();
  expect(fetcher.mock.calls[0][0]).toBe("https://data.cms.gov/data.json");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ conformsTo: "v3", dataset: [] })));
  await expect(discoverSnapshots()).rejects.toMatchObject({ status: 502 });
});
it.each(["https://evil.example/2026.20260101.zip", "https://user@data.cms.gov/2026.20260101.zip", "https://data.cms.gov/file.zip?redirect=x"])("does not accept untrusted distribution %s", downloadURL => {
  expect(parseSnapshot({ downloadURL })).toBeNull();
});
it.each([{ snapshot_month: "2026-13" }, { benefit_year: 2026 }, { expected_snapshot_sha256: "bad" }])("validates selection controls %#", params => {
  expect(() => snapshotControls(params)).toThrow();
});
