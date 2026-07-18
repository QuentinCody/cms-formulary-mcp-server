import {
    buildStreamFilters,
    decodeEntryRecords,
    inflateRaw,
    sliceZipEntryDeflate,
    streamFormularyMatches,
} from "./formulary-decode";
import {
    fetchRange,
    LOCAL_HEADER_BYTES,
    readZipDirectory,
    type ZipDirectory,
    type ZipEntry,
} from "./zip-directory";

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
 * The full ZIP is ~2.3GB. We NEVER download it whole: every read is an HTTP
 * byte-range against a single inner entry, and the entry offsets are
 * DISCOVERED from the ZIP's own central directory (see ./zip-directory) rather
 * than hardcoded.
 *
 * Why discovery: CMS ships a new ZIP monthly at a new URL, and the inner layout
 * moves with it. Freezing offsets from one release makes the server
 * self-destruct on the next — the June 2026 release is 2,296,903,000 bytes,
 * which is 15MB SHORTER than the Feb 2026 `plans` offset (2,312,124,500), so
 * the frozen range produced `HTTP 416 Range Not Satisfiable`. Discovery costs
 * two small ranges (~64KB tail + ~2KB directory), cached for URL_RESOLVE_TTL,
 * and self-heals across releases.
 *
 * Layout (June 2026 release, for orientation only — never relied upon):
 *   0:          basic drugs formulary  (8.3MB compressed → 58MB text, 1.12M rows)
 *   8.30M:      beneficiary cost       (465KB compressed)
 *   8.98M–2.3G: pharmacy network files (SKIP — never read)
 *   2.296G:     plan information       (399KB compressed → 14MB text)
 *
 * Strategy: fetch beneficiary cost and plan info via Range, then decompress
 * fully (small text). The basic drugs formulary decompresses to ~58MB / 1.12M
 * rows — too large for a 128MB Worker — so it is STREAM-decompressed and
 * filtered line-by-line, materializing only matching records (capped). Peak
 * memory stays ~17MB (the two compressed ZIP layers) regardless of text size.
 */

const FALLBACK_ZIP_URL =
    "https://data.cms.gov/sites/default/files/2026-02/d20b96a8-8acb-43cc-91e0-4f0b94c1d3f0/2026_20260219.zip";

const CMS_DCAT_URL = "https://data.cms.gov/data.json";
const FORMULARY_TITLE_MATCH = "monthly prescription drug plan formulary";

const USER_AGENT = "cms-formulary-mcp-server/1.0 (bio-mcp)";

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
 * LAST-RESORT byte offsets, frozen at the Feb 2026 release. Used ONLY when the
 * central directory cannot be read at all (upstream down / ranges refused).
 * They are stale by construction — a fallback read that succeeds is luck, and
 * one that fails must say so loudly rather than return empty.
 */
const LAST_RESORT_RANGES: Record<FormularyFileType, { start: number; end: number }> = {
    formulary: { start: 0, end: 8_500_000 },
    costs: { start: 8_300_763, end: 8_300_763 + 466_209 + 200 },
    plans: { start: 2_312_124_500, end: 2_312_124_500 + 400_283 + 200 },
};

/**
 * Slack added to an entry's range. The LOCAL header's extra field may be longer
 * than the central directory's, so we over-fetch a little and let
 * sliceZipEntryDeflate() find the real data start from the local header itself.
 */
const LOCAL_HEADER_PAD = 256;

/** Max rows materialized from a streamed formulary scan (per request). */
const FORMULARY_MATCH_CAP = 1000;

/** Parsed-directory cache, keyed by URL and aged out on URL_RESOLVE_TTL. */
let cachedDirectory: ZipDirectory | null = null;

/** Read + cache the ZIP's table of contents. Never re-parsed per request. */
async function getZipDirectory(): Promise<ZipDirectory> {
    const url = await getLatestZipUrl();
    if (
        cachedDirectory &&
        cachedDirectory.url === url &&
        Date.now() - cachedDirectory.fetchedAt < URL_RESOLVE_TTL
    ) {
        return cachedDirectory;
    }
    cachedDirectory = await readZipDirectory(url, USER_AGENT);
    return cachedDirectory;
}

/**
 * Entry identity, anchored to the START of the name. Anchoring matters: the
 * archive also ships "insulin beneficiary cost file …", which a loose
 * "beneficiary cost" substring match would select instead of the real one.
 */
const ENTRY_PREFIX: Record<FormularyFileType, string> = {
    formulary: "basic drugs formulary",
    costs: "beneficiary cost",
    plans: "plan information",
};

export function findEntry(dir: ZipDirectory, fileType: FormularyFileType): ZipEntry {
    const prefix = ENTRY_PREFIX[fileType];
    const entry = dir.entries.find((e) =>
        e.name.split("/").pop()?.trim().toLowerCase().startsWith(prefix),
    );
    if (!entry) {
        throw new Error(
            `No entry starting with "${prefix}" in the CMS ZIP (${dir.url}, ${dir.size} bytes). ` +
            `Central directory lists: ${dir.entries.map((e) => e.name).join(", ")}. ` +
            "CMS may have renamed the inner files.",
        );
    }
    return entry;
}

/** Byte range covering an entry's local header + its compressed payload. */
export function rangeForEntry(entry: ZipEntry, dir: ZipDirectory): { start: number; end: number } {
    const start = entry.localHeaderOffset;
    if (start >= dir.size) {
        throw new Error(
            `Entry "${entry.name}" claims local-header offset ${start}, but ${dir.url} is only ` +
            `${dir.size} bytes. The central directory disagrees with the object.`,
        );
    }
    const end = Math.min(
        start + LOCAL_HEADER_BYTES + entry.nameLength + LOCAL_HEADER_PAD + entry.compressedSize,
        dir.size - 1,
    );
    return { start, end };
}

interface ResolvedRange {
    start: number;
    end: number;
    entry: ZipEntry | null;
    url: string;
    size: number | null;
}

/**
 * Resolve an entry's byte range, discovering it from the central directory and
 * degrading LOUDLY to the frozen Feb-2026 offsets only when discovery is
 * impossible. A directory we *did* read is authoritative: a missing entry
 * throws rather than silently reading a stale offset.
 */
async function resolveRange(fileType: FormularyFileType): Promise<ResolvedRange> {
    let dir: ZipDirectory;
    try {
        dir = await getZipDirectory();
    } catch (err) {
        const url = await getLatestZipUrl();
        const fallback = LAST_RESORT_RANGES[fileType];
        console.warn(
            `[cms-formulary] Central-directory discovery failed for ${url} ` +
            `(${err instanceof Error ? err.message : String(err)}). Falling back to the frozen ` +
            `Feb-2026 offsets for "${fileType}" (${fallback.start}-${fallback.end}) — these are ` +
            "stale by construction and may not match this release.",
        );
        return { ...fallback, entry: null, url, size: null };
    }

    const entry = findEntry(dir, fileType);
    const { start, end } = rangeForEntry(entry, dir);
    return { start, end, entry, url: dir.url, size: dir.size };
}

/** Context suffix for a failed read: names the file, the offsets, and the real size. */
function readFailureContext({ start, end, url, size, entry }: ResolvedRange): string {
    const sizeNote = size === null ? "" : ` (object size ${size})`;
    const cause = entry
        ? "The central directory and the object disagree."
        : "Central-directory discovery was unavailable and the frozen Feb-2026 offsets no longer match.";
    return `at bytes ${start}-${end} of ${url}${sizeNote}. ${cause}`;
}

/** Fetch one discovered entry's bytes. */
async function fetchEntry(resolved: ResolvedRange, label: string): Promise<Uint8Array> {
    return fetchRange(resolved.url, resolved.start, resolved.end, `the "${label}" entry`, USER_AGENT);
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

    const resolved = await resolveRange("formulary");
    const label = resolved.entry?.name ?? "basic drugs formulary";
    const outer = await fetchEntry(resolved, label);

    const outerDeflate = sliceZipEntryDeflate(outer);
    if (!outerDeflate) {
        throw new Error(
            `Could not locate a deflate local file header for "${label}" ${readFailureContext(resolved)}`,
        );
    }
    const innerZip = await inflateRaw(outerDeflate);
    const txtDeflate = sliceZipEntryDeflate(innerZip);
    if (!txtDeflate) {
        throw new Error(
            `Could not locate the formulary TXT inside the nested ZIP "${label}" ` +
            `(${innerZip.length} bytes inflated). The CMS file structure may have changed.`,
        );
    }

    return streamFormularyMatches(txtDeflate, filters, FORMULARY_MATCH_CAP);
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

    const resolved = await resolveRange(fileType);
    const label = resolved.entry?.name ?? `(fallback range — ${fileType} entry unknown)`;
    const buffer = await fetchEntry(resolved, label);
    const records = await decodeEntryRecords(buffer, label);

    if (!records || records.length === 0) {
        throw new Error(
            `Could not extract ${fileType} data from "${label}" ${readFailureContext(resolved)}`,
        );
    }

    dataCache.set(fileType, { records, fetchedAt: Date.now() });
    return records;
}
