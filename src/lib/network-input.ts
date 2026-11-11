import { createHash, timingSafeEqual } from "node:crypto";
import { fail } from "./snapshot-http";

export const MANIFEST_LIMIT = 256 * 1024;
export const CHUNK_LIMIT = 512 * 1024;
export const hashBytes = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export const extractId = (value: Uint8Array | string) => `cms_network_${hashBytes(value)}`;
export const validExtractId = (value: unknown): value is string => typeof value === "string" && /^cms_network_[a-f0-9]{64}$/.test(value);
export const hexHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function authorizedImport(request: Request, token: string): boolean {
  const actual = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function importBody(request: Request, limit = CHUNK_LIMIT): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let count = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > limit) fail("Network import body exceeds byte limit", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Network import body timed out"), { status: 408 })), 10000);
    })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export function importJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { fail("Invalid UTF-8 JSON in network import"); }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an import object");
  return value as Record<string, unknown>;
}

export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail("Invalid import count or byte size");
  return value;
}

export function base64Bytes(value: unknown, maximum = 65536): Uint8Array {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(maximum / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("Invalid native base64 bytes");
  const raw = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (raw.length > maximum) fail("Native record exceeds byte limit");
  return raw;
}

export function nativeLine(bytes: Uint8Array, encoding: "cp1252" | "utf-8"): string {
  try {
    // Match Python's strict cp1252 codec even on runtimes that decode this
    // TextDecoder label as Latin-1. Null entries are undefined source bytes.
    const c1 = [0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,
      0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0,
      0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
      0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178];
    const text = encoding === "utf-8" ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      : Array.from(bytes, byte => {
        if (byte < 0x80 || byte > 0x9f) return String.fromCharCode(byte);
        const code = c1[byte - 0x80];
        if (!code) fail("Invalid Python cp1252 source byte");
        return String.fromCharCode(code);
      }).join("");
    return text.replace(/\n$/, "").replace(/\r$/, "");
  } catch { fail("Invalid selected source encoding"); }
}

export function importError(error: unknown): Response {
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
  return Response.json({ success: false, error: error instanceof Error ? error.message : "Network import failed" }, { status });
}
