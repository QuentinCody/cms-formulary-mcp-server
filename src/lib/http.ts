import {
    buildStreamFilters,
    inflateRaw,
    streamFormularyMatches,
} from "./formulary-decode";
import {
    fetchRange,
    LOCAL_HEADER_BYTES,
    readZipDirectory,
    type ZipDirectory,
    type ZipEntry,
} from "./zip-directory";
import type { SnapshotSelection } from "./snapshots";
import { pageControls, sourceEncoding } from "./formulary-query";
import { localMember, MemberDigest } from "./member-evidence";

export type FormularyFileType = "plans" | "formulary" | "costs" | "insulin-costs";

/** Read selected nested members by discovered byte ranges; stream their text
 * and retain only the requested matching page. Full parsed row caches are avoided.
 * Pharmacy-network members require a separate large-member reader.
 */

const USER_AGENT = "cms-formulary-mcp-server/1.0 (bio-mcp)";

/**
 * Slack added to an entry's range. The LOCAL header's extra field may be longer
 * than the central directory's, so we over-fetch a little and let
 * sliceZipEntryDeflate() find the real data start from the local header itself.
 */
const LOCAL_HEADER_PAD = 256;

/**
 * Entry identity, anchored to the START of the name. Anchoring matters: the
 * archive also ships "insulin beneficiary cost file …", which a loose
 * "beneficiary cost" substring match would select instead of the real one.
 */
const ENTRY_PREFIX: Record<FormularyFileType, string> = {
    formulary: "basic drugs formulary",
    costs: "beneficiary cost",
    plans: "plan information",
    "insulin-costs": "insulin beneficiary cost",
};

export function findEntry(dir: ZipDirectory, fileType: FormularyFileType): ZipEntry {
    const prefix = ENTRY_PREFIX[fileType];
    const entries = dir.entries.filter((e) =>
        e.name.split("/").pop()?.trim().toLowerCase().startsWith(prefix),
    );
    if (entries.length > 1) throw new Error(`Ambiguous "${prefix}" entries in ${dir.url}; refusing to select by ZIP order`);
    const entry = entries[0];
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
    entry: ZipEntry;
    url: string;
    size: number;
}

/**
 * Resolve only from the selected archive's central directory. No frozen offsets.
 */
async function resolveRange(fileType: FormularyFileType, selection: SnapshotSelection): Promise<ResolvedRange> {
    const dir = await readZipDirectory(selection.snapshot.url, USER_AGENT);
    const entry = findEntry(dir, fileType);
    const { start, end } = rangeForEntry(entry, dir);
    return { start, end, entry, url: dir.url, size: dir.size };
}

/** Fetch one discovered entry's bytes. */
async function fetchEntry(resolved: ResolvedRange, label: string): Promise<Uint8Array> {
    return fetchRange(resolved.url, resolved.start, resolved.end, `the "${label}" entry`, USER_AGENT);
}

/**
 * Fetch and stream-filter the requested pipe-delimited source file.
 * Returns matching records (capped) plus total counts for pagination metadata.
 *
 * Requires at least one filter param — an unfiltered scan would attempt to
 * return all 1.12M rows. Callers without a filter get a clear, actionable
 * error rather than an opaque memory failure.
 */
export async function getFormularyMatches(
    params: Record<string, unknown>,
    selection: SnapshotSelection,
    fileType: FormularyFileType = "formulary",
) {
    const filters = buildStreamFilters(params);
    const page = pageControls(params);
    const encoding = sourceEncoding(params);
    if (fileType === "formulary" && filters.length === 0) {
        throw Object.assign(
            new Error(
                "The basic drugs formulary requires at least one filter " +
                "(e.g. FORMULARY_ID, NDC, or RXCUI) so results can be narrowed. " +
                "Get a FORMULARY_ID from /plans first.",
            ),
            { status: 400 },
        );
    }

    const resolved = await resolveRange(fileType, selection);
    const label = resolved.entry?.name ?? "basic drugs formulary";
    const outer = await fetchEntry(resolved, label);

    const member = localMember(outer);
    const innerZip = await inflateRaw(member.deflate);
    const digest = new MemberDigest(); digest.update(innerZip);
    const archiveMember = digest.finish(member);
    const textMember = localMember(innerZip);
    const result = await streamFormularyMatches(textMember.deflate, filters, page.limit, page.offset, { ...textMember, encoding });
    return { ...result, source: { archive_url: resolved.url, archive_bytes: resolved.size,
        outer_member: member.name, outer_member_evidence: archiveMember, text_member: textMember.name,
        text: result.source_text, fetched_range: { start: resolved.start, end: resolved.end } } };
}
