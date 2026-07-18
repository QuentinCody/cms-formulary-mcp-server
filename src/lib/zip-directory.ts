/**
 * ZIP-over-HTTP central-directory reader.
 *
 * Reads a remote ZIP's table of contents using only bounded Range requests, so
 * a multi-GB archive can be navigated without downloading it. The flow is the
 * standard one:
 *
 *   1. size the object (HEAD, or a suffix-range probe reading Content-Range)
 *   2. range-fetch the last ~64KB and find the EOCD record
 *   3. follow the ZIP64 locator when the classic 32-bit fields are saturated
 *   4. range-fetch the central directory and parse its entries
 *
 * Callers get per-entry name, compressed size, and local-header offset — enough
 * to range-fetch one entry out of the archive. Nothing here caches; that is the
 * caller's policy decision.
 */

/** Read a little-endian uint16 from a byte array. */
export function readU16(d: Uint8Array, o: number): number {
    return d[o] | (d[o + 1] << 8);
}

/** Read a little-endian uint32 from a byte array. */
export function readU32(d: Uint8Array, o: number): number {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

/**
 * Read a little-endian uint64. ZIP64 sizes/offsets are well under 2^53 for any
 * real archive, so a Number is exact here.
 */
export function readU64(d: Uint8Array, o: number): number {
    return Number(BigInt(readU32(d, o)) | (BigInt(readU32(d, o + 4)) << 32n));
}

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CD_ENTRY_SIG = 0x02014b50;

/** 32-bit sentinels meaning "the real value lives in the ZIP64 extra field". */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** Minimum size of the EOCD record. */
const EOCD_BYTES = 22;

/** Size of the ZIP64 EOCD locator, which sits immediately before the EOCD. */
const ZIP64_LOCATOR_BYTES = 20;

/** The EOCD lies within the last 64KB (max ZIP comment) + the record itself. */
export const EOCD_SEARCH_BYTES = 65_536 + EOCD_BYTES;

/** Fixed size of a ZIP local file header, before filename + extra field. */
export const LOCAL_HEADER_BYTES = 30;

export interface ZipEntry {
    name: string;
    /** Compression method: 8 = deflate, 0 = stored. */
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    nameLength: number;
}

export interface ZipDirectory {
    url: string;
    /** Real object size in bytes, as reported by the origin. */
    size: number;
    entries: ZipEntry[];
    /** True when the archive's table of contents required ZIP64 to read. */
    zip64: boolean;
    fetchedAt: number;
}

/**
 * Fetch a bounded byte range. Every caller here reads at most a few hundred KB;
 * this must never be used to pull a whole archive.
 */
export async function fetchRange(
    url: string,
    start: number,
    end: number,
    what: string,
    userAgent: string,
): Promise<Uint8Array> {
    const resp = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}`, "User-Agent": userAgent },
    });
    if (!resp.ok && resp.status !== 206) {
        throw new Error(
            `ZIP range request failed while reading ${what}: HTTP ${resp.status} ` +
            `(requested bytes=${start}-${end} of ${url}).`,
        );
    }
    return new Uint8Array(await resp.arrayBuffer());
}

/**
 * Total object size, via HEAD with a suffix-range probe as the fallback. A HEAD
 * failure is carried into the probe's error rather than swallowed, so a total
 * failure names both causes.
 */
export async function getObjectSize(url: string, userAgent: string): Promise<number> {
    let headProblem: string;
    try {
        const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": userAgent } });
        const len = Number(head.headers.get("content-length"));
        if (head.ok && Number.isFinite(len) && len > 0) return len;
        headProblem =
            `HEAD returned HTTP ${head.status} with content-length=` +
            `${head.headers.get("content-length") ?? "none"}`;
    } catch (err) {
        headProblem = `HEAD threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    const probe = await fetch(url, { headers: { Range: "bytes=-1", "User-Agent": userAgent } });
    const contentRange = probe.headers.get("content-range");
    // Drain the 1-byte body so the connection can be reused.
    await probe.arrayBuffer().catch(() => new ArrayBuffer(0));
    const total = contentRange?.match(/\/(\d+)\s*$/)?.[1];
    if (!total) {
        throw new Error(
            `Could not determine the size of ${url}: ${headProblem}; the suffix-range probe ` +
            `returned content-range=${contentRange ?? "none"}.`,
        );
    }
    return Number(total);
}

interface CdLocation {
    offset: number;
    size: number;
    count: number;
    zip64: boolean;
}

/**
 * Locate the central directory from the EOCD in a tail buffer, transparently
 * handling ZIP64. Throws a tagged ZIP64_EOCD_OUTSIDE_TAIL error (carrying
 * `zip64EocdOffset`) when the ZIP64 EOCD sits before the tail window, so the
 * caller can range-fetch it instead.
 */
export function locateCentralDirectory(tail: Uint8Array, tailStart: number, url: string): CdLocation {
    let eocd = -1;
    for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
        if (readU32(tail, i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) {
        throw new Error(
            `Could not find the ZIP end-of-central-directory record in the last ${tail.length} ` +
            `bytes of ${url}. The object may not be a ZIP.`,
        );
    }

    const count = readU16(tail, eocd + 10);
    const size = readU32(tail, eocd + 12);
    const offset = readU32(tail, eocd + 16);

    // ZIP64 applies when any classic field is saturated. The locator sits
    // immediately before the EOCD; the ZIP64 EOCD holds the real values.
    const needsZip64 = offset === U32_MAX || size === U32_MAX || count === U16_MAX;

    let locator = -1;
    for (let i = eocd - ZIP64_LOCATOR_BYTES; i >= 0; i--) {
        if (readU32(tail, i) === ZIP64_LOCATOR_SIG) { locator = i; break; }
    }

    if (!needsZip64 && locator < 0) return { offset, size, count, zip64: false };
    if (locator < 0) {
        throw new Error(
            `${url} needs ZIP64 (cd offset=${offset}, size=${size}, entries=${count}) but no ` +
            "ZIP64 EOCD locator was found in the tail.",
        );
    }

    const zip64EocdOffset = readU64(tail, locator + 8);
    if (zip64EocdOffset < tailStart) {
        throw Object.assign(new Error("ZIP64_EOCD_OUTSIDE_TAIL"), { zip64EocdOffset });
    }
    return readZip64Eocd(tail, zip64EocdOffset - tailStart, zip64EocdOffset, url);
}

/** Parse a ZIP64 EOCD record at `base` within `buf`. */
export function readZip64Eocd(
    buf: Uint8Array,
    base: number,
    absoluteOffset: number,
    url: string,
): CdLocation {
    if (readU32(buf, base) !== ZIP64_EOCD_SIG) {
        throw new Error(
            `Expected a ZIP64 EOCD record at byte ${absoluteOffset} of ${url}, found signature ` +
            `0x${readU32(buf, base).toString(16)}.`,
        );
    }
    return {
        count: readU64(buf, base + 32),
        size: readU64(buf, base + 40),
        offset: readU64(buf, base + 48),
        zip64: true,
    };
}

/** Parse central-directory bytes into entries, resolving ZIP64 extra fields. */
export function parseCentralDirectory(cd: Uint8Array, url: string): ZipEntry[] {
    const entries: ZipEntry[] = [];
    let p = 0;
    while (p + 46 <= cd.length && readU32(cd, p) === CD_ENTRY_SIG) {
        const method = readU16(cd, p + 10);
        let compressedSize = readU32(cd, p + 20);
        let uncompressedSize = readU32(cd, p + 24);
        const nameLength = readU16(cd, p + 28);
        const extraLength = readU16(cd, p + 30);
        const commentLength = readU16(cd, p + 32);
        let localHeaderOffset = readU32(cd, p + 42);
        const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLength));

        // ZIP64 extra field (0x0001): the 8-byte values appear in a fixed order,
        // and ONLY for the fields whose 32-bit slot is saturated.
        let ef = p + 46 + nameLength;
        const efEnd = ef + extraLength;
        while (ef + 4 <= efEnd) {
            const headerId = readU16(cd, ef);
            const headerSize = readU16(cd, ef + 2);
            if (headerId === 0x0001) {
                let q = ef + 4;
                if (uncompressedSize === U32_MAX) { uncompressedSize = readU64(cd, q); q += 8; }
                if (compressedSize === U32_MAX) { compressedSize = readU64(cd, q); q += 8; }
                if (localHeaderOffset === U32_MAX) { localHeaderOffset = readU64(cd, q); q += 8; }
                break;
            }
            ef += 4 + headerSize;
        }

        entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset, nameLength });
        p += 46 + nameLength + extraLength + commentLength;
    }

    if (entries.length === 0) {
        throw new Error(
            `Parsed 0 entries from the central directory of ${url} (${cd.length} bytes read). ` +
            "The ZIP structure is not what this reader expects.",
        );
    }
    return entries;
}

/**
 * Read a remote ZIP's central directory using bounded Range requests only
 * (~64KB tail + the directory itself, typically a couple of KB).
 */
export async function readZipDirectory(url: string, userAgent: string): Promise<ZipDirectory> {
    const size = await getObjectSize(url, userAgent);
    const tailLength = Math.min(EOCD_SEARCH_BYTES, size);
    const tailStart = size - tailLength;
    const tail = await fetchRange(url, tailStart, size - 1, "the ZIP end-of-central-directory", userAgent);

    let located: CdLocation;
    try {
        located = locateCentralDirectory(tail, tailStart, url);
    } catch (err) {
        // Rare: a ZIP64 EOCD sitting before our 64KB tail window. Fetch it directly.
        const zip64EocdOffset = (err as { zip64EocdOffset?: number })?.zip64EocdOffset;
        if (zip64EocdOffset === undefined) throw err;
        const z64 = await fetchRange(
            url,
            zip64EocdOffset,
            zip64EocdOffset + 55,
            "the ZIP64 end-of-central-directory",
            userAgent,
        );
        located = readZip64Eocd(z64, 0, zip64EocdOffset, url);
    }

    if (located.offset + located.size > size) {
        throw new Error(
            `The central directory of ${url} claims bytes ${located.offset}-` +
            `${located.offset + located.size - 1}, past the object's real size of ${size}.`,
        );
    }

    const cd = await fetchRange(
        url,
        located.offset,
        located.offset + located.size - 1,
        "the ZIP central directory",
        userAgent,
    );
    const entries = parseCentralDirectory(cd, url);

    return { url, size, entries, zip64: located.zip64, fetchedAt: Date.now() };
}
