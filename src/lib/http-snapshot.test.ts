import { afterEach, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import type { SnapshotSelection } from "./snapshots";
const mocks = vi.hoisted(() => ({ directory: vi.fn(), range: vi.fn() }));
vi.mock("./zip-directory", async importOriginal => ({ ...await importOriginal<typeof import("./zip-directory")>(), readZipDirectory: mocks.directory, fetchRange: mocks.range }));
import { getFormularyMatches } from "./http";
afterEach(() => vi.clearAllMocks());
function selection(month: string): SnapshotSelection {
  return { snapshot: { url: `https://data.cms.gov/2026_2026${month}01.zip`, benefit_year: "2026", snapshot_month: `2026-${month}`, catalog_release_date: `2026-${month}-01`, filename_date: `2026-${month}-01`, native: {} }, snapshot_sha256: month.repeat(32), metadata: {}, catalog_url: "https://data.cms.gov/v1-1-data.json", observed_at: "2026-09-29", atomic_snapshot: false, archive_checksum_verified: false };
}
function archive(plan: string) {
  const text = `CONTRACT_ID|PLAN_ID|SEGMENT_ID|PLAN_NAME|PLAN_SUPPRESSED_YN\nH0001|001|002|${plan}|Y\n`;
  const inner = zipSync({ "plan.txt": strToU8(text) }, { level: 6 });
  return zipSync({ "plan information.zip": inner }, { level: 6 });
}
it("streams the selected snapshot afresh and preserves segment/suppression fields", async () => {
  mocks.directory.mockImplementation(async url => ({ url, size: 100000, zip64: false, fetchedAt: Date.now(), entries: [{ name: "plan information.zip", method: 8, compressedSize: 1000, uncompressedSize: 2000, localHeaderOffset: 0, nameLength: 20 }] }));
  mocks.range.mockResolvedValueOnce(archive("August")).mockResolvedValueOnce(archive("September")).mockResolvedValueOnce(archive("Corrected September"));
  expect((await getFormularyMatches({}, selection("08"), "plans")).records).toEqual([{ CONTRACT_ID: "H0001", PLAN_ID: "001", SEGMENT_ID: "002", PLAN_NAME: "August", PLAN_SUPPRESSED_YN: "Y" }]);
  expect((await getFormularyMatches({}, selection("09"), "plans")).records).toMatchObject([{ PLAN_NAME: "September" }]);
  expect((await getFormularyMatches({}, selection("09"), "plans")).records).toMatchObject([{ PLAN_NAME: "Corrected September" }]);
  expect(mocks.range).toHaveBeenCalledTimes(3);
});
it("fails without reading frozen byte offsets when central-directory discovery fails", async () => {
  mocks.directory.mockRejectedValue(new Error("directory unavailable"));
  await expect(getFormularyMatches({}, selection("07"), "costs")).rejects.toThrow("directory unavailable");
  expect(mocks.range).not.toHaveBeenCalled();
});

it("reads the insulin sibling and preserves all four native coinsurance fields and blank tier", async () => {
  mocks.directory.mockResolvedValue({ url: selection("06").snapshot.url, size: 10000, entries: [{ name: "insulin beneficiary cost file.zip", localHeaderOffset: 0, compressedSize: 1000, nameLength: 33 }] });
  const text = "CONTRACT_ID|PLAN_ID|SEGMENT_ID|TIER|COIN_AMT_PREF_INSLN|COIN_AMT_NONPREF_INSLN|COIN_AMT_MAIL_PREF_INSLN|COIN_AMT_MAIL_NONPREF_INSLN\nH0001|001|002||.25|.20|.15|.10\n";
  const inner = zipSync({ "insulin.txt": strToU8(text) }, { level: 6 });
  mocks.range.mockResolvedValue(zipSync({ "insulin beneficiary cost file.zip": inner }, { level: 6 }));
  expect((await getFormularyMatches({}, selection("06"), "insulin-costs")).records).toEqual([{ CONTRACT_ID: "H0001", PLAN_ID: "001", SEGMENT_ID: "002", TIER: "", COIN_AMT_PREF_INSLN: ".25", COIN_AMT_NONPREF_INSLN: ".20", COIN_AMT_MAIL_PREF_INSLN: ".15", COIN_AMT_MAIL_NONPREF_INSLN: ".10" }]);
});
