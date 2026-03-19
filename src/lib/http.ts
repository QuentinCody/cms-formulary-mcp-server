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
 *   0-8.3M:     basic drugs formulary (8MB compressed → 58MB text — TOO LARGE for Worker)
 *   8.3M-8.8M:  beneficiary cost (466KB compressed → 652KB text)
 *   ...intermediate small files...
 *   8.8M-9.0M:  insulin cost, indication-based coverage, etc.
 *   9.0M-2.3GB: pharmacy network files (SKIP)
 *   2.31GB:     plan information (400KB compressed → 14MB text)
 *
 * Strategy: fetch beneficiary cost (small, fast) and plan info via Range.
 * The basic drugs formulary (58MB) is too large to decompress in a Worker.
 * For formulary drug lookups, return an error directing users to the CMS
 * Part D spending data server instead.
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
            if (!ds.title?.toLowerCase().includes(FORMULARY_TITLE_MATCH)) continue;
            const url = ds.distribution?.[0]?.downloadURL;
            if (url?.endsWith(".zip")) {
                resolvedZipUrl = url;
                zipUrlResolvedAt = Date.now();
                return url;
            }
        }
    } catch {
        // fallback
    }
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
                } catch {
                    // not a valid inner ZIP
                }
            }
            if (lowerName.endsWith(".txt")) {
                return parsePipeDelimited(decoder.decode(data));
            }
        }
    } catch {
        // ZIP extraction failed — the range may not align with a complete entry
    }
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
        throw new Error(
            "The basic drugs formulary file is 58MB uncompressed — too large for in-Worker decompression. " +
            "Use the CMS Part D server (partd_execute) with /spending/annual for drug-level spending data, " +
            "or use /plans here to find FORMULARY_IDs and /costs for beneficiary cost-sharing details.",
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
