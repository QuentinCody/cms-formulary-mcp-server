import { fail } from "./snapshot-http";
import type { SnapshotSelection } from "./snapshots";
import { readZipDirectory, type ZipDirectory } from "./zip-directory";

/** Discover every advertised network partition without reading its huge body. */
export function networkParts(directory: ZipDirectory) {
  const entries = directory.entries.filter(entry => entry.name.split("/").pop()?.toLowerCase().startsWith("pharmacy networks file"));
  if (!entries.length || new Set(entries.map(entry => entry.name)).size !== entries.length) fail("Missing or duplicate CMS pharmacy-network members", 502);
  const parts = entries.map(entry => {
    const match = /^pharmacy networks file\s+(\d{8})(?: part ([1-9]\d*))?\.zip$/i.exec(entry.name.split("/").pop() ?? "");
    if (!match || ![0, 8].includes(entry.method)) fail("Unsupported CMS pharmacy-network member", 502);
    return { part: Number(match[2] ?? 0), member_date_label: match[1], ...entry, crc32_verified: false };
  }).sort((left, right) => left.part - right.part);
  if (new Set(parts.map(part => part.member_date_label)).size !== 1 ||
      !(parts.length === 1 && parts[0].part === 0) && parts.some((part, index) => part.part !== index + 1)) fail("Incomplete or inconsistent CMS pharmacy-network partitions", 502);
  return parts;
}

export async function describeNetworkArchive(selection: SnapshotSelection) {
  const directory = await readZipDirectory(selection.snapshot.url, "cms-formulary-mcp-server/1.0 (bio-mcp)");
  return { release_url: selection.snapshot.url, snapshot_sha256: selection.snapshot_sha256,
    archive_bytes: directory.size, archive_sha256: null, archive_checksum_verified: false,
    network_parts: networkParts(directory), _snapshot: selection,
    reader: { mode: "offline", script: "servers/cms-formulary-mcp-server/scripts/extract_network.py",
      input: "Complete local archive, exact source URL and verified whole-archive SHA-256; exact CONTRACT_ID, PLAN_ID and SEGMENT_ID.",
      output: "Validated ZIP containing manifest.json and records.jsonl, with complete member hashes/CRC and original selected row bytes.",
      fee_query_path: "/pharmacy-network/fees", import_required: true,
      limitation: "Discovery does not read fees or prove an extract is imported. Fee queries require a completed authenticated import, its immutable ID and the archive hash." } };
}
