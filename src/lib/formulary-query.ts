import { fail } from "./snapshot-http";

export function sourceEncoding(params: Record<string, unknown>): "utf-8" | "windows-1252" {
  const encoding = params.source_encoding ?? "windows-1252";
  if (encoding !== "windows-1252" && encoding !== "utf-8") fail("source_encoding must be windows-1252 or utf-8");
  return encoding;
}

export function pageControls(params: Record<string, unknown>) {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? params.size ?? 100;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) fail("offset must be a nonnegative safe integer");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) fail("limit/size must be an integer from 1 to 1000");
  if (params.limit !== undefined && params.size !== undefined && params.limit !== params.size) fail("limit and size disagree");
  return { offset, limit };
}

export function pipeHeaders(line: string): string[] {
  const headers = line.replace(/^\uFEFF/, "").split("|");
  if (headers.some(header => !header) || new Set(headers.map(header => header.toLowerCase())).size !== headers.length) fail("Invalid or ambiguous CMS pipe-delimited headers", 502);
  return headers;
}

export function pipeValues(line: string, headers: string[]): string[] {
  const values = line.split("|");
  if (values.length !== headers.length) fail("CMS pipe-delimited row width differs from header", 502);
  return values;
}

export function pipeRecord(headers: string[], values: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
}
