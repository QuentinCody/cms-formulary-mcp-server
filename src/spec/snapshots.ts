import type { ApiCatalog, ParamDef } from "@bio-mcp/shared/codemode/catalog";
export const snapshotParams: ParamDef[] = [
  { name: "snapshot_month", type: "string", required: false, description: "YYYY-MM from the catalog distribution title, distinct from benefit year and filename date." },
  { name: "benefit_year", type: "string", required: false, description: "Four-digit contract/benefit year from the archive filename; not inferred from release year." },
  { name: "release_url", type: "string", required: false, description: "Exact advertised CMS ZIP URL from /snapshots; resolves ties explicitly." },
  { name: "expected_snapshot_sha256", type: "string", required: false, description: "Metadata guard from /snapshot. Not an archive content checksum or immutable-data guarantee." },
];
export const sourceEncodingParam: ParamDef = { name: "source_encoding", type: "string", required: false, enum: ["windows-1252", "utf-8"], description: "Native text encoding, default windows-1252 as observed in the CMS plan file; UTF-8 is available explicitly. Output preserves original field casing and padding; _source records byte hashes and member CRC checks." };
export const snapshotEndpoints: ApiCatalog["endpoints"] = [
  { method: "GET", path: "/snapshots", category: "snapshots", summary: "Discover monthly ZIP distributions with full native metadata and separate benefit year, catalog release date, snapshot month and filename date. No automatic February fallback." },
  { method: "GET", path: "/snapshot", category: "snapshots", summary: "Select one snapshot, using the DCAT-US 3.0 series last reference, or latest catalog date for legacy 1.1. Rejects ambiguity or unavailable selection; returns a metadata hash for consistent joins and continuation.", queryParams: snapshotParams },
  { method: "GET", path: "/insulin-costs", category: "costs", summary: "Read native insulin beneficiary cost rows, including 2026 copay and coinsurance fields. Does not calculate an individual's cost or infer negotiated prices.", queryParams: [...snapshotParams, sourceEncodingParam,
    { name: "CONTRACT_ID", type: "string", required: false, description: "Contract ID; preserve leading zeros in the full plan key." },
    { name: "PLAN_ID", type: "string", required: false, description: "Plan ID within contract." },
    { name: "SEGMENT_ID", type: "string", required: false, description: "Segment ID; part of plan identity." },
    { name: "limit", type: "number", required: false, description: "Page size, default 100." },
  ] },
];
export const snapshotWorkflows: ApiCatalog["workflows"] = [{
  title: "Read plan rows from one explicit snapshot",
  keywords: ["snapshot", "month", "benefit year", "release", "segment"],
  description: "Select the latest advertised snapshot, then carry its exact URL and metadata hash into data requests. Preserve CONTRACT_ID, PLAN_ID and SEGMENT_ID for joins; check PLAN_SUPPRESSED_YN before interpreting absent downstream data.",
  code: 'const release = await api.get("/snapshot");\nif (!release.release_url || !release.snapshot_sha256) return release;\nreturn await api.get("/plans", {release_url: release.release_url, expected_snapshot_sha256: release.snapshot_sha256, limit: 25});',
}, {
  title: "Inspect 2026 insulin cost-sharing fields without calculating a benefit",
  keywords: ["insulin", "coinsurance", "2026", "cost"],
  description: "Uses the latest advertised snapshot for benefit year 2026. Keep blank tiers and four coin_amt_*_insln fields as native values; no patient-specific out-of-pocket calculation.",
  code: 'return await api.get("/insulin-costs", {benefit_year: "2026", limit: 25});',
}];
export const snapshotNotes = "\n- All data routes return _snapshot with native metadata and selection evidence. Snapshot month uses the catalog title date; filename_date remains separate. Unknown dates remain null.\n- DCAT-US 3.0 latest selection follows series.last.@id; missing/unresolved pointers or a different requested benefit year require an exact release_url. Legacy 1.1 selection sorts catalog dates; unknown/ambiguous dates require an explicit URL. No stale-February or frozen-offset fallback. All tables are stream-filtered anew for each page. Metadata guards do not establish immutable bytes or an atomic snapshot.\n- CMS launched DCAT-US 3.0 September 29, 2026. Discovery reads /data.json and uses /v1-1-data.json only after HTTP 404/410; CMS retires compatibility March 31, 2027. Native series/release metadata is retained; temporal coverage and issued dates are not substituted for snapshot month.\n- 2026 adds SELECTED_DRUG_YN and insulin coinsurance fields; all native columns remain intact. Selected-drug pharmacy dispensing fees are in the separate large network file, which is not parsed here.\n- PUF snapshots may differ from current Medicare Plan Finder. Suppressed plans appear only in Plan Information. No inferred coverage denial or personalized cost calculation.";
