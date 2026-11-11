export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

async function collect(response: Response, cap: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > cap) fail("CMS response exceeds byte limit", 502);
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {}); // Cleanup must not replace the original read failure.
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function boundedFetch(url: string, init: RequestInit, cap: number, validate?: (response: Response) => void): Promise<{ bytes: Uint8Array; headers: Headers; status: number }> {
  const parsed = new URL(url);
  if (parsed.origin !== "https://data.cms.gov" || parsed.username || parsed.password || parsed.hash) fail("Unsupported CMS source URL");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("CMS read timed out"), { status: 504 })); }, 15000);
  });
  const work = async () => {
    const response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    try {
      if (!response.ok) fail(`CMS HTTP ${response.status}`, response.status);
      validate?.(response);
    } catch (error) {
      void response.body?.cancel().catch(() => {}); // Best-effort cleanup before propagating validation error.
      throw error;
    }
    return { bytes: await collect(response, cap), headers: response.headers, status: response.status };
  };
  try { return await Promise.race([work(), timeout]); }
  finally { clearTimeout(timer); }
}

export async function catalogJson(path: string): Promise<Record<string, unknown>> {
  // The October 2026 DCAT-US 3.0 catalog is 17.7 MB; retain an explicit ceiling.
  const response = await boundedFetch(`https://data.cms.gov${path}`, { headers: { Accept: "application/json" } }, 24 * 1024 * 1024);
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(response.bytes)); }
  catch { fail("Invalid CMS catalog JSON", 502); }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("Invalid CMS catalog envelope", 502);
  // SAFETY: JSON object validated above; individual fields remain unknown.
  return data as Record<string, unknown>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    // SAFETY: sorted keys are own keys of this JSON object.
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return value;
}

export async function snapshotHash(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
