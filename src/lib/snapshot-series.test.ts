import { afterEach, expect, it, vi } from "vitest";
import { discoverSnapshots, selectSnapshot } from "./snapshots";

// Synthetic CMS FAQ 1.7 structures, not downloaded archive/catalog evidence.
const title = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";
const currentUrl = "https://data.cms.gov/files/2026_20260916.zip";
const olderUrl = "https://data.cms.gov/files/2026_20260815.zip";
const series = { "@id": "https://data.cms.gov/series/formulary", title, last: { "@id": "https://data.cms.gov/releases/september" } };
const release = { "@id": series.last["@id"], title: "Native release label", inSeries: [{ "@id": series["@id"], title }], temporal: [{ startDate: "2026-01-01", endDate: "2026-12-31" }], issued: { "@value": "2026-09-23" }, distribution: [{ mediaType: "application/zip", downloadURL: currentUrl }], future: { retain: true } };
const older = { ...release, "@id": "https://data.cms.gov/releases/august", distribution: [{ title: `${title} : 2026-08-20`, downloadURL: olderUrl }] };
const catalog = { conformsTo: { title: "DCAT-US 3.0" }, datasetSeries: [series], dataset: [release, older] };
function mock(value: unknown = catalog) {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(value));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

it("preserves native releases and follows series.last for latest despite unknown release dates", async () => {
  const fetcher = mock();
  const discovery = await discoverSnapshots();
  expect(discovery).toMatchObject({ catalog_format: "DCAT-US 3.0", metadata: { series, releases: [release, older] } });
  expect(discovery.snapshots[0]).toMatchObject({ url: currentUrl, benefit_year: "2026", filename_date: "2026-09-16", snapshot_month: null, catalog_release_date: null, latest_in_series: true, release_metadata: release, native: release.distribution[0] });
  expect((await selectSnapshot()).snapshot.url).toBe(currentUrl);
  expect(fetcher.mock.calls[0][0]).toBe("https://data.cms.gov/data.json");
});

it("does not use temporal coverage or issued metadata as a snapshot month", async () => {
  mock();
  await expect(selectSnapshot({ snapshot_month: "2026-09" })).rejects.toMatchObject({ status: 404 });
  expect((await selectSnapshot({ release_url: currentUrl })).snapshot.snapshot_month).toBeNull();
});

it("keeps explicit historical URL and observable distribution-title month selection", async () => {
  mock();
  expect((await selectSnapshot({ snapshot_month: "2026-08", benefit_year: "2026" })).snapshot.url).toBe(olderUrl);
  expect((await selectSnapshot({ release_url: olderUrl })).snapshot.release_metadata).toEqual(older);
});

it("honors the series pointer instead of a newer-looking filename or publication date", async () => {
  mock({ ...catalog, datasetSeries: [{ ...series, last: { "@id": older["@id"] } }] });
  expect((await selectSnapshot()).snapshot.url).toBe(olderUrl);
});

it.each([undefined, null, { "@id": "missing-release" }])("requires explicit selection when latest cannot be resolved: %j", async last => {
  mock({ ...catalog, datasetSeries: [{ ...series, last }] });
  await expect(selectSnapshot()).rejects.toMatchObject({ status: 409 });
  expect((await selectSnapshot({ release_url: olderUrl })).snapshot.url).toBe(olderUrl);
});

it("requires explicit selection when the provider's latest belongs to another benefit year", async () => {
  const current = { ...release, distribution: [{ downloadURL: currentUrl.replace("2026_", "2027_") }] };
  mock({ ...catalog, dataset: [current, older] });
  await expect(selectSnapshot({ benefit_year: "2026" })).rejects.toMatchObject({ status: 409 });
  expect((await selectSnapshot({ benefit_year: "2026", release_url: olderUrl })).snapshot.url).toBe(olderUrl);
});

it("supports title-only inSeries links while refusing conflicting explicit identities", async () => {
  const titleOnly = { ...release, inSeries: [{ title }] };
  const impostor = { ...older, inSeries: [{ "@id": "other-series", title }] };
  mock({ ...catalog, dataset: [titleOnly, impostor] });
  expect((await discoverSnapshots()).metadata).toEqual({ series, releases: [titleOnly] });
});

it.each([
  { ...catalog, datasetSeries: [] },
  { ...catalog, datasetSeries: [series, series] },
  { ...catalog, datasetSeries: [{ ...series, "@id": null }] },
  { ...catalog, dataset: [] },
  { ...catalog, dataset: [release, release] },
  { ...catalog, dataset: [{ ...release, "@id": null }] },
  { ...catalog, dataset: [{ ...release, distribution: null }] },
])("rejects malformed/ambiguous family and release metadata %#", async value => {
  const fetcher = mock(value);
  await expect(discoverSnapshots()).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects multiple ZIPs on the latest release unless an exact URL is selected", async () => {
  const second = currentUrl.replace("20260916", "20260917");
  mock({ ...catalog, dataset: [{ ...release, distribution: [{ downloadURL: currentUrl }, { downloadURL: second }] }] });
  await expect(selectSnapshot()).rejects.toMatchObject({ status: 409 });
  expect((await selectSnapshot({ release_url: second })).snapshot.url).toBe(second);
});

it("guards metadata changes across series pointers and selected release fields", async () => {
  mock(); const initial = await selectSnapshot({ release_url: currentUrl });
  for (const changed of [
    { ...catalog, datasetSeries: [{ ...series, last: { "@id": older["@id"] } }] },
    { ...catalog, dataset: [{ ...release, issued: "changed" }, older] },
  ]) {
    mock(changed);
    await expect(selectSnapshot({ release_url: currentUrl, expected_snapshot_sha256: initial.snapshot_sha256 })).rejects.toMatchObject({ status: 409 });
  }
});

it.each([404, 410])("falls back only when the current catalog returns %i", async status => {
  const legacy = { conformsTo: "https://project-open-data.cio.gov/v1.1/schema", dataset: [{ title, distribution: older.distribution }] };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status })).mockResolvedValueOnce(Response.json(legacy));
  vi.stubGlobal("fetch", fetcher);
  expect(await discoverSnapshots()).toMatchObject({ catalog_format: "DCAT-US 1.1", catalog_url: "https://data.cms.gov/v1-1-data.json" });
  expect(fetcher.mock.calls.map(args => args[0])).toEqual(["https://data.cms.gov/data.json", "https://data.cms.gov/v1-1-data.json"]);
});

it("never fetches an external distribution or follows last as a network URL", async () => {
  const malicious = { ...release, distribution: [{ downloadURL: "https://example.com/file.zip" }] };
  const fetcher = mock({ ...catalog, dataset: [malicious, older] });
  await expect(selectSnapshot()).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
