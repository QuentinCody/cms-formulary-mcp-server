import { base64Bytes, hexHash, integer, nativeLine, record } from "./network-input";
import { fail } from "./snapshot-http";

export interface NetworkMember {
  outer: { name: string; sha256: string; bytes: number; crc32: number; crc32_verified: true };
  text: { name: string; sha256: string; bytes: number; crc32: number; crc32_verified: true;
    columns: string[]; rows: number; matched_rows: number; blank_lines: number; encoding: "cp1252" | "utf-8"; raw_header_base64: string };
}
export interface NetworkManifest {
  schema: "cms-pharmacy-network-extract"; version: 1;
  source: { url: string; sha256: string; bytes: number };
  selection: { filters: { CONTRACT_ID: string; PLAN_ID: string; SEGMENT_ID: string }; match: string };
  members: NetworkMember[];
  records: { file: string; rows: number; bytes: number; sha256: string };
  complete_matching_rows: true; all_network_members_scanned: true;
}

function memberEvidence(value: unknown) {
  const evidence = record(value);
  if (typeof evidence.name !== "string" || evidence.name.length > 512 || !hexHash(evidence.sha256) || evidence.crc32_verified !== true) fail("Missing offline member evidence");
  integer(evidence.bytes); integer(evidence.crc32, 0xffffffff);
  return evidence;
}

function member(value: unknown): NetworkMember {
  const source = record(value);
  const outer = memberEvidence(source.outer);
  const text = memberEvidence(source.text);
  if (text.encoding !== "cp1252" && text.encoding !== "utf-8") fail("Unsupported native member encoding");
  const columns = text.columns;
  if (!Array.isArray(columns) || columns.length > 128 || columns.length < 7 || columns.some(column => typeof column !== "string" || !column || column.length > 128)) fail("Invalid native column list");
  if (new Set(columns.map(column => column.toLowerCase())).size !== columns.length || !["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "PHARMACY_NUMBER"].every(key => columns.includes(key))) fail("Ambiguous or missing native identity columns");
  const families = ["SELECTED_DISPENSING_FEE_", "SELECTED_DRUG_DISPENSING_FEE_"].filter(prefix => ["30", "60", "90"].every(days => columns.includes(prefix + days)));
  if (families.length !== 1) fail("Missing or ambiguous selected-drug fee fields");
  const header = nativeLine(base64Bytes(text.raw_header_base64), text.encoding).replace(/^\uFEFF/, "").split("|");
  if (JSON.stringify(header) !== JSON.stringify(columns) || text.name !== String(outer.name).replace(/\.zip$/i, ".txt")) fail("Native header or member-name mismatch");
  if (integer(text.matched_rows) > integer(text.rows)) fail("Matching rows exceed source rows");
  integer(text.blank_lines);
  // Native objects are preserved intact after validating fields used by storage.
  return source as unknown as NetworkMember;
}

export function validateManifest(value: unknown): NetworkManifest {
  const { labels, manifest, members } = validateManifestSource(value);
  if (labels.some(label => !label) || new Set(labels.map(label => label?.[1])).size !== 1) fail("Inconsistent network member names");
  if (!(labels.length === 1 && !labels[0]?.[2]) && labels.some((label, index) => Number(label?.[2]) !== index + 1)) fail("Missing, duplicate or unordered network parts");
  const records = record(manifest.records);
  if (records.file !== "records.jsonl" || !hexHash(records.sha256) || integer(records.rows) !== members.reduce((sum, item) => sum + item.text.matched_rows, 0)) fail("Record totals or digest disagree");
  integer(records.bytes, 512 * 1024 * 1024);
  return manifest as unknown as NetworkManifest;
}

function validateManifestSource(value: unknown) {
  const manifest = record(value);
  if (manifest.schema !== "cms-pharmacy-network-extract" || manifest.version !== 1 || manifest.complete_matching_rows !== true || manifest.all_network_members_scanned !== true) fail("A complete v1 network extract is required");
  const source = record(manifest.source);
  if (!hexHash(source.sha256) || !integer(source.bytes) || source.sha256_verified !== true) fail("Missing pinned source archive");
  let url: URL;
  try { url = new URL(String(source.url)); } catch { fail("Invalid source archive URL"); }
  if (url.origin !== "https://data.cms.gov" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(".zip")) fail("Expected an exact CMS archive URL");
  const filters = record(record(manifest.selection).filters);
  if (record(manifest.selection).match !== "exact native text") fail("Exact native text selection required");
  if (Object.keys(filters).sort().join() !== "CONTRACT_ID,PLAN_ID,SEGMENT_ID" || !/^[A-Z]\d{4}$/.test(String(filters.CONTRACT_ID)) || !/^\d{3}$/.test(String(filters.PLAN_ID)) || !/^\d{3}$/.test(String(filters.SEGMENT_ID))) fail("Exact native plan identity required");
  if (Object.values(filters).some(value => typeof value !== "string")) fail("Plan keys must remain text");
  if (!Array.isArray(manifest.members) || !manifest.members.length || manifest.members.length > 64) fail("Invalid network member count");
  const members = manifest.members.map(member);
  const labels = members.map(item => /^pharmacy networks file\s+(\d{8})(?: part ([1-9]\d*))?\.zip$/i.exec(item.outer.name.split("/").pop() ?? ""));
  return { labels, manifest, members };
}
