import { catalogJson, fail, snapshotHash } from "./snapshot-http";
import { seriesSnapshots } from "./snapshot-series";

const TITLE = "Monthly Prescription Drug Plan Formulary and Pharmacy Network Information";
export interface Snapshot {
  url: string;
  benefit_year: string | null;
  snapshot_month: string | null;
  catalog_release_date: string | null;
  filename_date: string | null;
  native: Record<string, unknown>;
  release_metadata?: Record<string, unknown>;
  latest_in_series?: boolean;
}
export interface SnapshotSelection {
  release_url?: string;
  snapshot: Snapshot;
  metadata: Record<string, unknown>;
  snapshot_sha256: string;
  catalog_url: string;
  catalog_format?: string;
  observed_at: string;
  atomic_snapshot: false;
  archive_checksum_verified: false;
}

function date(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

export function parseSnapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid CMS distribution", 502);
  // SAFETY: distribution JSON object checked above.
  const native = value as Record<string, unknown>;
  if (typeof native.downloadURL !== "string") return null;
  let url: URL;
  try { url = new URL(native.downloadURL); } catch { return null; }
  if (url.origin !== "https://data.cms.gov" || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().endsWith(".zip")) return null;
  const name = url.pathname.split("/").pop() ?? "";
  const match = /^(\d{4})[._](\d{4})(\d{2})(\d{2})\.zip$/i.exec(name);
  const filenameDate = match ? date(`${match[2]}-${match[3]}-${match[4]}`) : null;
  const releaseDate = date(typeof native.title === "string" ? /:\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(native.title)?.[1] : undefined);
  return { url: url.href, benefit_year: match?.[1] ?? null, snapshot_month: releaseDate?.slice(0, 7) ?? null, catalog_release_date: releaseDate, filename_date: filenameDate, native };
}

export async function discoverSnapshots(): Promise<{ snapshots: Snapshot[]; metadata: Record<string, unknown>; catalog_url: string; catalog_format: string; observed_at: string }> {
  let path = "/data.json";
  let catalog: Record<string, unknown>;
  try { catalog = await catalogJson(path); }
  catch (error) {
    if (!error || typeof error !== "object" || !("status" in error) || ![404, 410].includes(Number(error.status))) throw error;
    path = "/v1-1-data.json"; catalog = await catalogJson(path);
  }
  if (Array.isArray(catalog.datasetSeries)) {
    const result = seriesSnapshots(catalog, TITLE, parseSnapshot);
    if (!result.snapshots.length) fail("No supported monthly formulary ZIP distributions", 502);
    return { ...result, catalog_url: `https://data.cms.gov${path}`, catalog_format: "DCAT-US 3.0", observed_at: new Date().toISOString() };
  }
  if (!/\/v1\.1\//.test(String(catalog.conformsTo ?? catalog["@context"] ?? "")) || !Array.isArray(catalog.dataset)) fail("CMS DCAT-US 1.1 compatibility catalog required", 502);
  const matches = catalog.dataset.filter(value => value && typeof value === "object" && value.title === TITLE);
  if (matches.length !== 1 || !Array.isArray(matches[0].distribution)) fail("Monthly formulary dataset missing or ambiguous", 502);
  // SAFETY: exact-title entry and its distribution array checked above.
  const metadata = matches[0] as Record<string, unknown>;
  const snapshots = (matches[0].distribution as unknown[]).map(parseSnapshot).filter((item): item is Snapshot => item !== null);
  if (!snapshots.length) fail("No supported monthly formulary ZIP distributions", 502);
  return { snapshots, metadata, catalog_url: `https://data.cms.gov${path}`, catalog_format: "DCAT-US 1.1", observed_at: new Date().toISOString() };
}

export function snapshotControls(params: Record<string, unknown>): { selection: Record<string, unknown>; filters: Record<string, unknown> } {
  const { snapshot_month, benefit_year, release_url, expected_snapshot_sha256, ...filters } = params;
  if (snapshot_month !== undefined && (typeof snapshot_month !== "string" || !date(`${snapshot_month}-01`))) fail("snapshot_month must be YYYY-MM");
  if (benefit_year !== undefined && (typeof benefit_year !== "string" || !/^\d{4}$/.test(benefit_year))) fail("benefit_year must be a four-digit string");
  if (release_url !== undefined && typeof release_url !== "string") fail("release_url must be an exact advertised URL");
  if (expected_snapshot_sha256 !== undefined && (typeof expected_snapshot_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(expected_snapshot_sha256))) fail("Expected snapshot SHA-256 must have 64 hex characters");
  return { selection: { snapshot_month, benefit_year, release_url, expected_snapshot_sha256 }, filters };
}

export async function selectSnapshot(params: Record<string, unknown> = {}): Promise<SnapshotSelection> {
  const { selection } = snapshotControls(params);
  const discovery = await discoverSnapshots();
  let matches = discovery.snapshots.filter(item =>
    (selection.release_url === undefined || item.url === selection.release_url) &&
    (selection.snapshot_month === undefined || item.snapshot_month === selection.snapshot_month) &&
    (selection.benefit_year === undefined || item.benefit_year === selection.benefit_year));
  if (!matches.length) fail("Requested formulary snapshot is not advertised", 404);
  if (selection.release_url === undefined && selection.snapshot_month === undefined) {
    if (discovery.catalog_format === "DCAT-US 3.0") {
      matches = matches.filter(item => item.latest_in_series);
      if (!matches.length) fail("Series latest release is missing or does not match the requested benefit year; select an exact release_url", 409);
    } else {
      if (matches.some(item => !item.catalog_release_date)) fail("Undated ZIP distribution prevents latest selection; select an exact release_url", 409);
      const dates = matches.map(item => item.catalog_release_date).sort();
      const latest = dates[dates.length - 1];
      matches = matches.filter(item => item.catalog_release_date === latest);
    }
  }
  if (matches.length !== 1) fail("Ambiguous formulary snapshot; select an exact release_url", 409);
  const snapshot = matches[0];
  const hash = await snapshotHash({ snapshot, metadata: discovery.metadata });
  if (selection.expected_snapshot_sha256 !== undefined && String(selection.expected_snapshot_sha256).toLowerCase() !== hash) fail("Formulary snapshot metadata changed", 409);
  return { snapshot, release_url: snapshot.url, metadata: discovery.metadata, snapshot_sha256: hash, catalog_url: discovery.catalog_url, catalog_format: discovery.catalog_format, observed_at: discovery.observed_at, atomic_snapshot: false, archive_checksum_verified: false };
}
