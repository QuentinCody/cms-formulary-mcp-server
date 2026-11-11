import { base64Bytes, importJson, integer, nativeLine, record } from "./network-input";
import type { NetworkManifest } from "./network-manifest";
import { fail } from "./snapshot-http";

export interface NetworkRecord { member: number; line: number; values: string[]; raw_base64: string }
export interface NetworkPosition { member: number; line: number }

export function validateRecords(bytes: Uint8Array, manifest: NetworkManifest, previous: NetworkPosition): NetworkRecord[] {
  if (!bytes.length || bytes[bytes.length - 1] !== 10) fail("Chunks must contain complete newline-terminated JSONL records");
  let start = 0;
  let position = previous;
  const rows: NetworkRecord[] = [];
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    const row = record(importJson(bytes.subarray(start, end))); start = end + 1;
    const member = integer(row.member, manifest.members.length - 1);
    const line = integer(row.line);
    if (line < 2 || member < position.member || member === position.member && line <= position.line) fail("Native record positions must increase");
    const evidence = manifest.members[member].text;
    if (line > evidence.rows + evidence.blank_lines + 1) fail("Record position exceeds the declared source file");
    if (!Array.isArray(row.values) || row.values.length !== evidence.columns.length || row.values.some(value => typeof value !== "string")) fail("Native record width/type mismatch");
    const native = nativeLine(base64Bytes(row.raw_base64), evidence.encoding).split("|");
    if (native.some(value => /[\r\n]/.test(value))) fail("One physical source line is required per record");
    if (JSON.stringify(native) !== JSON.stringify(row.values)) fail("Record values differ from original line bytes");
    for (const [key, value] of Object.entries(manifest.selection.filters)) if (native[evidence.columns.indexOf(key)] !== value) fail("Record belongs to a different plan");
    rows.push({ member, line, values: row.values, raw_base64: row.raw_base64 as string });
    position = { member, line };
  }
  return rows;
}
