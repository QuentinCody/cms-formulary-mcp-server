import { fail } from "./snapshot-http";
import type { Snapshot } from "./snapshots";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid CMS series record", 502);
  return value as Record<string, unknown>;
}

/** CMS FAQ 1.7 uses series.last.@id to locate the current release's ZIP. */
export function seriesSnapshots(catalog: Record<string, unknown>, title: string, parse: (value: unknown) => Snapshot | null) {
  if (!Array.isArray(catalog.datasetSeries) || !Array.isArray(catalog.dataset)) fail("Invalid CMS dataset-series catalog", 502);
  const families = catalog.datasetSeries.map(record).filter(item => item.title === title);
  if (families.length !== 1) fail("Monthly formulary series missing or ambiguous", 502);
  const series = families[0];
  if (typeof series["@id"] !== "string" || !series["@id"]) fail("CMS series identifier missing", 502);
  const releases = catalog.dataset.map(record).filter(item => Array.isArray(item.inSeries) && item.inSeries.some(value => {
    const link = record(value);
    return link["@id"] !== undefined ? link["@id"] === series["@id"] : link.title === series.title;
  }));
  const ids = releases.map(item => item["@id"]);
  if (!ids.length || ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) fail("CMS release identifiers missing or ambiguous", 502);
  const last = series.last === undefined || series.last === null ? undefined : record(series.last)["@id"];
  const snapshots: Snapshot[] = [];
  for (const release of releases) {
    if (!Array.isArray(release.distribution)) fail("CMS release distributions missing", 502);
    for (const distribution of release.distribution) {
      const snapshot = parse(distribution);
      if (snapshot) snapshots.push({ ...snapshot, release_metadata: release, latest_in_series: release["@id"] === last });
    }
  }
  return { snapshots, metadata: { series, releases } };
}
