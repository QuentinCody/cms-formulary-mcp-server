import type { ApiCatalog, ParamDef } from "@bio-mcp/shared/codemode/catalog";

const pins: ParamDef[] = [
  { name: "extract_id", type: "string", required: true, description: "Immutable cms_network_<manifest SHA-256> ID from a completed authenticated offline extract import." },
  { name: "archive_sha256", type: "string", required: true, description: "Exact whole-archive SHA-256 matching that extract; no implicit latest release." },
];
export const networkEndpoints: ApiCatalog["endpoints"] = [
  { method: "GET", path: "/pharmacy-network/extract", category: "pharmacy-network", queryParams: pins,
    summary: "Read a completed imported extract's full native manifest and raw manifest text. Transfer bytes and native row values are verified; whole-source scanning/CRC remains authenticated offline extractor evidence." },
  { method: "GET", path: "/pharmacy-network/fees", category: "pharmacy-network",
    summary: "Query every native pharmacy-network fee field for one imported plan and explicit archive. Exact pharmacy filtering and bounded continuation preserve raw lines and member positions. No negotiated-price, patient-cost or current-coverage inference.",
    queryParams: [...pins,
      { name: "CONTRACT_ID", type: "string", required: true, description: "Exact contract ID in the imported selection." },
      { name: "PLAN_ID", type: "string", required: true, description: "Exact three-character native plan ID, retaining zeros." },
      { name: "SEGMENT_ID", type: "string", required: true, description: "Exact three-character native segment ID." },
      { name: "PHARMACY_NUMBER", type: "string", required: false, description: "Optional exact native pharmacy number; duplicates remain distinct source rows." },
      { name: "offset", type: "number", required: false, description: "Zero-based matching-row offset; use next_offset from the preceding page." },
      { name: "limit", type: "number", required: false, description: "1–1,000 rows, default 100. A page also stops at 2 MiB of row data, with explicit continuation." },
    ] },
];
