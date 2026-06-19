import { unzipSync } from "fflate";

export type FormularyFileType = "plans" | "formulary" | "costs";

/** Cached parsed data per file type */
const dataCache = new Map<
    FormularyFileType,
    { records: Record<string, string>[]; fetchedAt: number }
>();

const CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * CMS Part D Formulary — monthly ZIP from data.cms.gov.
 *
 * The full ZIP is ~2.7GB. We fetch individual inner ZIPs using byte ranges.
 * File layout (approximate byte offsets from Feb 2026 release):
 *   0-8.3M:     basic drugs formulary (8MB compressed → 58MB text, 1.12M rows)
 *   8.3M-8.8M:  beneficiary cost (466KB compressed → 652KB text)
 *   ...intermediate small files...
 *   8.8M-9.0M:  insulin cost, indication-based coverage, etc.
 *   9.0M-2.3GB: pharmacy network files (SKIP)
 *   2.31GB:     plan information (400KB compressed → 14MB text)
 *
 * Strategy: fetch beneficiary cost (small, fast) and plan info via Range,
 * then decompress fully with fflate (small text).
 *
 * The basic drugs formulary decompresses to ~58MB / 1.12M rows — too large to
 * materialize all at once in a 128MB Worker. Instead we STREAM-decompress it
 * with the native DecompressionStream API and filter line-by-line, only
 * materializing matching records (capped). Peak memory stays ~17MB (the two
 * compressed ZIP layers) regardless of the 58MB text size.
 */

const FALLBACK_ZIP_URL =
    "https://data.cms.gov/sites/default/files/2026-02/d20b96a8-8acb-43cc-91e0-4f0b94c1d3f0/2026_20260219.zip";

const CMS_DCAT_URL = "https://data.cms.gov/data.json";
const FORMULARY_TITLE_MATCH = "monthly prescription drug plan formulary";

let resolvedZipUrl: string | null = null;
let zipUrlResolvedAt = 0;
const URL_RESOLVE_TTL = 7 * 24 * 60 * 60 * 1000;

async function getLatestZipUrl(): Promise<string> {
    if (resolvedZipUrl && Date.now() - zipUrlResolvedAt < URL_RESOLVE_TTL) {
        return resolvedZipUrl;
    }
    try {
        const resp = await fetch(CMS_DCAT_URL, {
            headers: { Accept: "application/json", "User-Agent": "cms-formulary-mcp-server/1.0" },
            signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const catalog = (await resp.json()) as {
            dataset?: Array<{
                title?: string;
                distribution?: Array<{ downloadURL?: string }>;
            }>;
        };
        for (const ds of catalog.dataset ?? []) {
            if (!ds.title?.toLowerCase()?.includes(FORMULARY_TITLE_MATCH)) continue;
            const url = ds.distribution?.[0]?.downloadURL;
            if (url?.endsWith(".zip")) {
                resolvedZipUrl = url;
                zipUrlResolvedAt = Date.now();
                return url;
            }
        }
    } catch { /* best-effort: fallback */ }
    return resolvedZipUrl ?? FALLBACK_ZIP_URL;
}

/**
 * Known byte ranges for the Feb 2026 ZIP.
 * beneficiary cost starts at ~8.3MB, ends ~8.8MB.
 * plan info starts at ~2.312GB, ends ~2.313GB.
 *
 * These offsets are approximate — we fetch a generous range and
 * let fflate find the valid ZIP entries within.
 */
/**
 * Exact byte offsets from the Feb 2026 ZIP central directory.
 * Each range covers: local file header + filename + compressed data.
 * Add padding (~200 bytes) for the local file header.
 */
const RANGES: Record<string, { start: number; end: number }> = {
    costs: { start: 8_300_763, end: 8_300_763 + 466_209 + 200 },
    plans: { start: 2_312_124_500, end: 2_312_124_500 + 400_283 + 200 },
};

/**
 * The basic drugs formulary is the first entry in the outer ZIP (byte 0).
 * Its outer (deflate) entry is ~8.3MB; we over-fetch to tolerate small layout
 * shifts between monthly releases, then locate the entry by its PK header.
 */
const FORMULARY_RANGE = { start: 0, end: 8_500_000 } as const;

/** Max rows materialized from a streamed formulary scan (per request). */
const FORMULARY_MATCH_CAP = 1000;

/** Read a little-endian uint16 from a byte array. */
function readU16(d: Uint8Array, o: number): number {
    return d[o] | (d[o + 1] << 8);
}

/** Read a little-endian uint32 from a byte array. */
function readU32(d: Uint8Array, o: number): number {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

/**
 * Given a buffer starting at (or near) a ZIP local file header, return the
 * raw-deflate compressed payload of that single entry. Returns null if no
 * local header (PK\x03\x04) is found or the entry is not deflate-compressed.
 */
function sliceZipEntryDeflate(buffer: Uint8Array): Uint8Array | null {
    let off = -1;
    for (let i = 0; i < Math.min(buffer.length, 1000); i++) {
        if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04) {
            off = i;
            break;
        }
    }
    if (off < 0) return null;
    const method = readU16(buffer, off + 8);
    if (method !== 8) return null; // 8 = deflate; 0 = stored (not expected here)
    const comp = readU32(buffer, off + 18);
    const fnLen = readU16(buffer, off + 26);
    const efLen = readU16(buffer, off + 28);
    const dataStart = off + 30 + fnLen + efLen;
    if (comp === 0 || dataStart + comp > buffer.length) return null;
    return buffer.subarray(dataStart, dataStart + comp);
}

/** Inflate a raw-deflate buffer fully via the native DecompressionStream API. */
async function inflateRaw(deflate: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([deflate]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Case-insensitive substring filters extracted from request params. */
type StreamFilter = [string, string];

function buildStreamFilters(params: Record<string, unknown>): StreamFilter[] {
    return Object.entries(params)
        .filter(
            ([key, val]) =>
                key !== "limit" &&
                key !== "offset" &&
                key !== "size" &&
                val !== undefined &&
                val !== "",
        )
        .map(([key, val]) => [key, String(val).toLowerCase()] as StreamFilter);
}

/**
 * Stream-decompress the 58MB basic drugs formulary TXT and return matching
 * records (capped). Filters are applied per-line so we never hold the full
 * 1.12M-row table in memory.
 */
async function streamFormularyMatches(
    txtDeflate: Uint8Array,
    filters: StreamFilter[],
    cap: number,
): Promise<{ matched: number; total: number; records: Record<string, string>[] }> {
    const reader = new Blob([txtDeflate])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let headers: string[] | null = null;
    const headerIdx: Record<string, number> = {};
    let total = 0;
    let matched = 0;
    const records: Record<string, string>[] = [];

    const handleLine = (line: string): void => {
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (headers === null) {
            headers = trimmed.split("|").map((h) => h.trim());
            headers.forEach((h, i) => { headerIdx[h] = i; });
            return;
        }
        if (!trimmed) return;
        total++;
        const values = trimmed.split("|");
        for (const [key, needle] of filters) {
            const idx = headerIdx[key];
            if (idx === undefined || !(values[idx] ?? "").toLowerCase().includes(needle)) {
                return;
            }
        }
        matched++;
        if (records.length < cap) {
            const record: Record<string, string> = {};
            for (let j = 0; j < headers.length; j++) {
                record[headers[j]] = (values[j] ?? "").trim();
            }
            records.push(record);
        }
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
        }
    }
    if (buffer.length > 0) handleLine(buffer);

    return { matched, total, records };
}

/**
 * Fetch and stream-filter the basic drugs formulary file.
 * Returns matching records (capped) plus total counts for pagination metadata.
 *
 * Requires at least one filter param — an unfiltered scan would attempt to
 * return all 1.12M rows. Callers without a filter get a clear, actionable
 * error rather than an opaque memory failure.
 */
export async function getFormularyMatches(
    params: Record<string, unknown>,
): Promise<{ matched: number; total: number; records: Record<string, string>[] }> {
    const filters = buildStreamFilters(params);
    if (filters.length === 0) {
        throw Object.assign(
            new Error(
                "The basic drugs formulary has 1.12M rows. Provide at least one filter " +
                "(e.g. FORMULARY_ID, NDC, or RXCUI) so results can be narrowed. " +
                "Get a FORMULARY_ID from /plans first.",
            ),
            { status: 400 },
        );
    }

    const zipUrl = await getLatestZipUrl();
    const response = await fetch(zipUrl, {
        headers: {
            Range: `bytes=${FORMULARY_RANGE.start}-${FORMULARY_RANGE.end}`,
            "User-Agent": "cms-formulary-mcp-server/1.0 (bio-mcp)",
        },
    });
    if (!response.ok && response.status !== 206) {
        throw new Error(
            `CMS ZIP range request failed: HTTP ${response.status}. ` +
            "The ZIP layout may have changed with a new monthly release.",
        );
    }

    const outer = new Uint8Array(await response.arrayBuffer());
    const outerDeflate = sliceZipEntryDeflate(outer);
    if (!outerDeflate) {
        throw new Error(
            "Could not locate the basic drugs formulary entry in the ZIP range. " +
            "The file offsets may have shifted in a new monthly release.",
        );
    }
    const innerZip = await inflateRaw(outerDeflate);
    const txtDeflate = sliceZipEntryDeflate(innerZip);
    if (!txtDeflate) {
        throw new Error(
            "Could not locate the formulary TXT inside the nested ZIP. " +
            "The CMS file structure may have changed.",
        );
    }

    return streamFormularyMatches(txtDeflate, filters, FORMULARY_MATCH_CAP);
}

export function parsePipeDelimited(text: string): Record<string, string>[] {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [];
    const headers = lines[0].split("|").map((h) => h.trim());
    const records: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = line.split("|");
        const record: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            record[headers[j]] = (values[j] ?? "").trim();
        }
        records.push(record);
    }
    return records;
}

/**
 * Try to extract a text file from a (possibly nested) ZIP buffer.
 * Returns parsed records or null if extraction fails.
 */
function extractFromZipBuffer(buffer: Uint8Array): Record<string, string>[] | null {
    const decoder = new TextDecoder("utf-8");

    // Find the PK signature (ZIP local file header) in the buffer
    let zipStart = -1;
    for (let i = 0; i < Math.min(buffer.length, 1000); i++) {
        if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04) {
            zipStart = i;
            break;
        }
    }
    if (zipStart < 0) return null;

    const zipData = zipStart > 0 ? buffer.slice(zipStart) : buffer;

    try {
        const entries = unzipSync(zipData);
        for (const [name, data] of Object.entries(entries)) {
            const lowerName = name.toLowerCase();
            // It might be a nested ZIP
            if (lowerName.endsWith(".zip")) {
                try {
                    const innerEntries = unzipSync(data);
                    for (const [innerName, innerData] of Object.entries(innerEntries)) {
                        if (innerName.endsWith(".txt")) {
                            return parsePipeDelimited(decoder.decode(innerData));
                        }
                    }
                } catch { /* best-effort: not a valid inner ZIP */ }
            }
            if (lowerName.endsWith(".txt")) {
                return parsePipeDelimited(decoder.decode(data));
            }
        }
    } catch { /* best-effort: ZIP extraction failed — the range may not align with a complete entry */ }
    return null;
}

/**
 * Get parsed formulary data for a specific file type.
 */
export async function getFormularyData(
    fileType: FormularyFileType,
): Promise<Record<string, string>[]> {
    // Check cache
    const cached = dataCache.get(fileType);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        return cached.records;
    }

    if (fileType === "formulary") {
        // The 58MB formulary is stream-filtered via getFormularyMatches(); it is
        // never materialized wholesale. Reaching here means the adapter misrouted.
        throw new Error(
            "Use getFormularyMatches() for the formulary file — it is stream-filtered, not bulk-loaded.",
        );
    }

    const range = RANGES[fileType];
    if (!range) {
        throw new Error(`No known range for file type: ${fileType}`);
    }

    const zipUrl = await getLatestZipUrl();
    const response = await fetch(zipUrl, {
        headers: {
            Range: `bytes=${range.start}-${range.end}`,
            "User-Agent": "cms-formulary-mcp-server/1.0 (bio-mcp)",
        },
    });

    if (!response.ok && response.status !== 206) {
        throw new Error(
            `CMS ZIP range request failed: HTTP ${response.status}. ` +
            "The ZIP layout may have changed with a new monthly release.",
        );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const records = extractFromZipBuffer(buffer);

    if (!records || records.length === 0) {
        throw new Error(
            `Could not extract ${fileType} data from ZIP range. ` +
            "The file offsets may have shifted in a new monthly release. " +
            `Range: ${range.start}-${range.end}`,
        );
    }

    dataCache.set(fileType, { records, fetchedAt: Date.now() });
    return records;
}
