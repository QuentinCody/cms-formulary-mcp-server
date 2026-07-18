/**
 * Decoding for the CMS Part D formulary files.
 *
 * Every file in the monthly archive is a ZIP *inside* the outer ZIP, holding a
 * single pipe-delimited TXT. This module turns a fetched byte range into
 * records; locating that range is ./http's job, and reading the archive's table
 * of contents is ./zip-directory's.
 *
 * Memory matters here: the basic-drugs formulary decompresses to ~58MB across
 * 1.12M rows, which a 128MB Worker cannot hold. streamFormularyMatches() exists
 * so that file is filtered line-by-line and never fully materialized.
 */
import { unzipSync } from "fflate";
import { readU16, readU32 } from "./zip-directory";

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
 * Given a buffer starting at (or near) a ZIP local file header, return the
 * raw-deflate compressed payload of that single entry. Returns null if no
 * local header (PK\x03\x04) is found or the entry is not deflate-compressed.
 */
export function sliceZipEntryDeflate(buffer: Uint8Array): Uint8Array | null {
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
export async function inflateRaw(deflate: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([deflate]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Try to extract a text file from a COMPLETE (possibly nested) ZIP buffer.
 * Returns parsed records, or null if extraction fails. Requires a real central
 * directory — see decodeEntryRecords() for the bare-entry case.
 */
export function extractFromZipBuffer(buffer: Uint8Array): Record<string, string>[] | null {
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
 * Decode one discovered entry's byte range into records.
 *
 * A precisely-bounded entry range is a BARE local file entry — local header +
 * deflate payload, with no central directory — and fflate's unzipSync needs an
 * EOCD, so it rejects such a buffer outright ("invalid zip data"). We therefore
 * inflate the outer entry ourselves and hand fflate the complete inner ZIP.
 * (The old frozen offsets only ever parsed because their sloppy end ran past
 * EOF and swept the real central directory in behind the payload.)
 */
export async function decodeEntryRecords(
    buffer: Uint8Array,
    label: string,
): Promise<Record<string, string>[] | null> {
    const outerDeflate = sliceZipEntryDeflate(buffer);
    if (outerDeflate) {
        const innerZip = await inflateRaw(outerDeflate).catch((err: unknown) => {
            console.warn(
                `[cms-formulary] Inflating "${label}" failed: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
        });
        if (innerZip) {
            const records = extractFromZipBuffer(innerZip);
            if (records && records.length > 0) return records;
        }
    }
    // Fallback: the buffer may already BE a complete ZIP — e.g. a last-resort
    // frozen range whose end ran past EOF and captured the central directory.
    return extractFromZipBuffer(buffer);
}

/** Case-insensitive substring filters extracted from request params. */
export type StreamFilter = [string, string];

export function buildStreamFilters(params: Record<string, unknown>): StreamFilter[] {
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
export async function streamFormularyMatches(
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
