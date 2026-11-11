import { extractId, hexHash, record, validExtractId } from "./network-input";
import type { NetworkStore } from "./network-store";
import { pageControls, pipeRecord } from "./formulary-query";
import { fail } from "./snapshot-http";
import type { NetworkManifest } from "./network-manifest";

export interface NetworkNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub }

export function networkReadParams(params: Record<string, unknown>, rows: boolean) {
  const allowed = rows ? ["extract_id", "archive_sha256", "CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "PHARMACY_NUMBER", "offset", "limit"] : ["extract_id", "archive_sha256"];
  if (Object.keys(params).some(key => !allowed.includes(key)) || !validExtractId(params.extract_id) || !hexHash(params.archive_sha256)) fail("An exact extract_id and archive_sha256 are required; unsupported parameters are rejected");
  if (rows && !["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID"].every(key => typeof params[key] === "string")) fail("Supply the exact contract, plan and segment IDs");
  if (params.PHARMACY_NUMBER !== undefined && (typeof params.PHARMACY_NUMBER !== "string" || params.PHARMACY_NUMBER.length > 128)) fail("Invalid exact pharmacy number");
  return rows ? pageControls(params) : undefined;
}

export function readNetworkStore(store: NetworkStore, params: Record<string, unknown>, rows: boolean) {
  const page = networkReadParams(params, rows);
  const state = store.state();
  if (!state.completed_at) fail("Network extract import is not complete", 409);
  const manifest = store.manifest(state);
  const id = extractId(state.manifest_text);
  if (params.extract_id !== id || params.archive_sha256 !== manifest.source.sha256) fail("Network extract/archive pin mismatch", 409);
  if (rows && Object.entries(manifest.selection.filters).some(([key, value]) => params[key] !== value)) fail("Requested plan differs from the imported plan", 409);
  const source = { extract_id: id, manifest_sha256: id.slice("cms_network_".length), manifest_text: state.manifest_text, manifest,
    imported_at: state.completed_at, transfer: { records_sha256_verified: true, raw_record_values_verified: true, bytes: state.received_bytes, rows: state.received_rows },
    native_source_verification: { mode: "authenticated offline extractor attestation", rechecked_by_worker: false } };
  const base = { extract_id: id, archive_sha256: manifest.source.sha256, ...manifest.selection.filters, _source: source };
  if (!page) return { status: 200, data: base };
  const { results, total, byteLimited, rowSources } = readNetworkPage(params, store, page, manifest);
  const complete = page.offset === 0 && results.length === total;
  return { status: 200, completeness: { complete, returned: results.length, total_available: total,
    ...(!complete ? { truncation: { reason: "page_limit" as const, detail: byteLimited ? "Page reached the 2 MiB row-data limit; continue with next_offset." : "One page of the matching imported plan rows." } } : {}) },
    data: { ...base, results, row_sources: rowSources, total_imported: state.received_rows, total_filtered: total,
      returned: results.length, offset: page.offset, limit: page.limit, truncated: !complete,
      next_offset: page.offset + results.length < total ? page.offset + results.length : null } };
}

function readNetworkPage(params: Record<string, unknown>, store: NetworkStore, page: { offset: number; limit: number; }, manifest: NetworkManifest) {
  const filter = params.PHARMACY_NUMBER === undefined ? "" : " WHERE pharmacy=?";
  const bindings = params.PHARMACY_NUMBER === undefined ? [] : [String(params.PHARMACY_NUMBER)];
  const total = Number(store.sql.exec(`SELECT COUNT(*) AS n FROM _network_rows${filter}`, ...bindings).toArray()[0].n);
  const results: Record<string, string>[] = [];
  const rowSources: Array<{ member: number; line: number; raw_base64: string; }> = [];
  let bytes = 0;
  let byteLimited = false;
  for (const row of store.sql.exec(`SELECT member, source_line, values_json, raw_base64 FROM _network_rows${filter} ORDER BY sequence LIMIT ? OFFSET ?`, ...bindings, page.limit, page.offset)) {
    const member = Number(row.member);
    const result = pipeRecord(manifest.members[member].text.columns, JSON.parse(String(row.values_json)));
    const evidence = { member, line: Number(row.source_line), raw_base64: String(row.raw_base64) };
    bytes += new TextEncoder().encode(JSON.stringify([result, evidence])).length;
    if (bytes > 2 * 1024 * 1024) { byteLimited = true; break; }
    results.push(result); rowSources.push(evidence);
  }
  return { results, total, byteLimited, rowSources };
}

export async function readNetwork(namespace: NetworkNamespace | undefined, path: string, params: Record<string, unknown>) {
  const rows = path === "pharmacy-network/fees";
  networkReadParams(params, rows);
  if (!namespace) fail("Network import storage is unavailable", 503);
  const stub = namespace.get(namespace.idFromName(String(params.extract_id)));
  const response = await stub.fetch(new Request(`http://network/network-import/${rows ? "fees" : "extract"}`, { method: "POST", body: JSON.stringify(params) }));
  const result = record(await response.json());
  if (!response.ok) fail(String(result.error ?? "Network extract read failed"), response.status);
  return result as unknown as ReturnType<typeof readNetworkStore>;
}
