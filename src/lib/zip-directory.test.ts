import { describe, expect, it } from "vitest";
import {
    locateCentralDirectory,
    parseCentralDirectory,
    readU64,
    readZip64Eocd,
} from "./zip-directory";

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

// ---------------------------------------------------------------------------
// Synthetic ZIP structure builders. CMS ships a classic (non-ZIP64) archive
// today, so the ZIP64 paths can only be exercised against fixtures — without
// these they would rot untested until the archive crosses 4GB.
// ---------------------------------------------------------------------------

function u64Bytes(value: number): number[] {
    const big = BigInt(value);
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push(Number((big >> BigInt(8 * i)) & 0xffn));
    return out;
}

function u32Bytes(value: number): number[] {
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u16Bytes(value: number): number[] {
    return [value & 0xff, (value >>> 8) & 0xff];
}

interface EntrySpec {
    name: string;
    method?: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    /** Emit a ZIP64 extra field, saturating the listed base fields. */
    zip64?: { uncompressed?: boolean; compressed?: boolean; offset?: boolean };
}

function buildCdEntry(spec: EntrySpec): number[] {
    const name = [...new TextEncoder().encode(spec.name)];
    const z64 = spec.zip64;

    const extra: number[] = [];
    if (z64) {
        const payload: number[] = [];
        // Order is fixed: uncompressed, compressed, then local-header offset.
        if (z64.uncompressed) payload.push(...u64Bytes(spec.uncompressedSize));
        if (z64.compressed) payload.push(...u64Bytes(spec.compressedSize));
        if (z64.offset) payload.push(...u64Bytes(spec.localHeaderOffset));
        extra.push(...u16Bytes(0x0001), ...u16Bytes(payload.length), ...payload);
    }

    return [
        ...u32Bytes(0x02014b50), // signature
        ...u16Bytes(0x41), // version made by
        ...u16Bytes(20), // version needed
        ...u16Bytes(0), // flags
        ...u16Bytes(spec.method ?? 8), // method
        ...u16Bytes(0), // mod time
        ...u16Bytes(0), // mod date
        ...u32Bytes(0), // crc32
        ...u32Bytes(z64?.compressed ? U32_MAX : spec.compressedSize),
        ...u32Bytes(z64?.uncompressed ? U32_MAX : spec.uncompressedSize),
        ...u16Bytes(name.length),
        ...u16Bytes(extra.length),
        ...u16Bytes(0), // comment length
        ...u16Bytes(0), // disk start
        ...u16Bytes(0), // internal attrs
        ...u32Bytes(0), // external attrs
        ...u32Bytes(z64?.offset ? U32_MAX : spec.localHeaderOffset),
        ...name,
        ...extra,
    ];
}

function buildEocd(opts: { count: number; cdSize: number; cdOffset: number; comment?: string }): number[] {
    const comment = [...new TextEncoder().encode(opts.comment ?? "")];
    return [
        ...u32Bytes(0x06054b50),
        ...u16Bytes(0), // disk number
        ...u16Bytes(0), // cd start disk
        ...u16Bytes(Math.min(opts.count, U16_MAX)),
        ...u16Bytes(Math.min(opts.count, U16_MAX)),
        ...u32Bytes(opts.cdSize),
        ...u32Bytes(opts.cdOffset),
        ...u16Bytes(comment.length),
        ...comment,
    ];
}

function buildZip64Eocd(opts: { count: number; cdSize: number; cdOffset: number }): number[] {
    return [
        ...u32Bytes(0x06064b50),
        ...u64Bytes(44), // size of remaining record
        ...u16Bytes(0x2d), // version made by
        ...u16Bytes(0x2d), // version needed
        ...u32Bytes(0), // disk number
        ...u32Bytes(0), // cd start disk
        ...u64Bytes(opts.count), // entries this disk
        ...u64Bytes(opts.count), // total entries
        ...u64Bytes(opts.cdSize),
        ...u64Bytes(opts.cdOffset),
    ];
}

function buildZip64Locator(zip64EocdOffset: number): number[] {
    return [
        ...u32Bytes(0x07064b50),
        ...u32Bytes(0), // disk holding the zip64 EOCD
        ...u64Bytes(zip64EocdOffset),
        ...u32Bytes(1), // total disks
    ];
}

describe("readU64", () => {
    it("reads a little-endian 64-bit value beyond the 32-bit range", () => {
        const buf = new Uint8Array(u64Bytes(2_312_124_500));
        expect(readU64(buf, 0)).toBe(2_312_124_500);
    });

    it("reads a value above 4GB exactly", () => {
        const buf = new Uint8Array(u64Bytes(5_000_000_123));
        expect(readU64(buf, 0)).toBe(5_000_000_123);
    });
});

describe("parseCentralDirectory", () => {
    it("parses names, sizes and local-header offsets for every entry", () => {
        const cd = new Uint8Array([
            ...buildCdEntry({
                name: "basic drugs formulary file  20260630.zip",
                compressedSize: 8_304_467,
                uncompressedSize: 8_570_448,
                localHeaderOffset: 0,
            }),
            ...buildCdEntry({
                name: "plan information  20260630.zip",
                compressedSize: 399_367,
                uncompressedSize: 430_952,
                localHeaderOffset: 2_296_498_611,
            }),
        ]);

        const entries = parseCentralDirectory(cd, "http://example/test.zip");

        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
            name: "basic drugs formulary file  20260630.zip",
            compressedSize: 8_304_467,
            localHeaderOffset: 0,
            method: 8,
        });
        expect(entries[1]).toMatchObject({
            name: "plan information  20260630.zip",
            compressedSize: 399_367,
            localHeaderOffset: 2_296_498_611,
        });
        // nameLength drives the range padding, so it must be the byte length.
        expect(entries[1].nameLength).toBe("plan information  20260630.zip".length);
    });

    it("resolves a ZIP64 extra field when the 32-bit offset slot is saturated", () => {
        // The case that forces ZIP64: a local-header offset past 4GB.
        const offset = 5_000_000_123;
        const cd = new Uint8Array(
            buildCdEntry({
                name: "huge entry.zip",
                compressedSize: 12_345,
                uncompressedSize: 67_890,
                localHeaderOffset: offset,
                zip64: { offset: true },
            }),
        );

        const entries = parseCentralDirectory(cd, "http://example/test.zip");

        expect(entries).toHaveLength(1);
        expect(entries[0].localHeaderOffset).toBe(offset);
        // Non-saturated fields still come from the classic slots.
        expect(entries[0].compressedSize).toBe(12_345);
        expect(entries[0].uncompressedSize).toBe(67_890);
    });

    it("resolves ZIP64 sizes and offset together, honoring field order", () => {
        const cd = new Uint8Array(
            buildCdEntry({
                name: "everything big.bin",
                compressedSize: 4_294_967_400,
                uncompressedSize: 8_589_934_592,
                localHeaderOffset: 6_000_000_000,
                zip64: { uncompressed: true, compressed: true, offset: true },
            }),
        );

        const [entry] = parseCentralDirectory(cd, "http://example/test.zip");

        expect(entry.uncompressedSize).toBe(8_589_934_592);
        expect(entry.compressedSize).toBe(4_294_967_400);
        expect(entry.localHeaderOffset).toBe(6_000_000_000);
    });

    it("skips unrelated extra fields to find the ZIP64 one", () => {
        const entry = buildCdEntry({
            name: "x.bin",
            compressedSize: 1,
            uncompressedSize: 1,
            localHeaderOffset: 9_000_000_000,
            zip64: { offset: true },
        });
        // Splice a decoy extra field (id 0x5455, "extended timestamp") ahead of the ZIP64 one.
        const decoy = [...u16Bytes(0x5455), ...u16Bytes(3), 1, 2, 3];
        const nameLen = "x.bin".length;
        const extraStart = 46 + nameLen;
        const oldExtraLen = entry[30] | (entry[31] << 8);
        const withDecoy = [
            ...entry.slice(0, 30),
            ...u16Bytes(oldExtraLen + decoy.length),
            ...entry.slice(32, extraStart),
            ...decoy,
            ...entry.slice(extraStart),
        ];

        const [parsed] = parseCentralDirectory(new Uint8Array(withDecoy), "http://example/test.zip");

        expect(parsed.localHeaderOffset).toBe(9_000_000_000);
    });

    it("throws when the buffer holds no central-directory entries", () => {
        expect(() => parseCentralDirectory(new Uint8Array(64), "http://example/test.zip")).toThrow(
            /Parsed 0 entries/,
        );
    });
});

describe("locateCentralDirectory", () => {
    it("reads offset, size and count from a classic EOCD", () => {
        const tail = new Uint8Array(buildEocd({ count: 14, cdSize: 1713, cdOffset: 2_296_901_265 }));

        const located = locateCentralDirectory(tail, 0, "http://example/test.zip");

        expect(located).toEqual({ offset: 2_296_901_265, size: 1713, count: 14, zip64: false });
    });

    it("finds the EOCD even when a ZIP comment trails it", () => {
        const tail = new Uint8Array(
            buildEocd({ count: 2, cdSize: 100, cdOffset: 500, comment: "packed by CMS" }),
        );

        expect(locateCentralDirectory(tail, 0, "http://example/test.zip")).toMatchObject({
            offset: 500,
            count: 2,
        });
    });

    it("follows the ZIP64 locator when the classic fields are saturated", () => {
        const zip64Eocd = buildZip64Eocd({
            count: 70_000,
            cdSize: 8_000_000,
            cdOffset: 5_000_000_123,
        });
        const zip64EocdOffset = 0; // placed at the very start of our tail window
        const tail = new Uint8Array([
            ...zip64Eocd,
            ...buildZip64Locator(zip64EocdOffset),
            ...buildEocd({ count: U16_MAX, cdSize: U32_MAX, cdOffset: U32_MAX }),
        ]);

        const located = locateCentralDirectory(tail, 0, "http://example/test.zip");

        expect(located).toEqual({
            offset: 5_000_000_123,
            size: 8_000_000,
            count: 70_000,
            zip64: true,
        });
    });

    it("signals ZIP64_EOCD_OUTSIDE_TAIL so the caller can range-fetch it", () => {
        // Locator points before the tail window we hold.
        const tail = new Uint8Array([
            ...buildZip64Locator(1000),
            ...buildEocd({ count: U16_MAX, cdSize: U32_MAX, cdOffset: U32_MAX }),
        ]);

        try {
            locateCentralDirectory(tail, 900_000, "http://example/test.zip");
            expect.unreachable("should have thrown");
        } catch (err) {
            expect((err as Error).message).toBe("ZIP64_EOCD_OUTSIDE_TAIL");
            expect((err as { zip64EocdOffset: number }).zip64EocdOffset).toBe(1000);
        }
    });

    it("throws a diagnostic error when there is no EOCD at all", () => {
        expect(() => locateCentralDirectory(new Uint8Array(128), 0, "http://example/test.zip")).toThrow(
            /end-of-central-directory/,
        );
    });
});

describe("readZip64Eocd", () => {
    it("rejects a buffer whose signature is not a ZIP64 EOCD", () => {
        expect(() => readZip64Eocd(new Uint8Array(64), 0, 4242, "http://example/test.zip")).toThrow(
            /Expected a ZIP64 EOCD record at byte 4242/,
        );
    });

    it("reads counts, size and offset from a well-formed record", () => {
        const buf = new Uint8Array(buildZip64Eocd({ count: 3, cdSize: 400, cdOffset: 9_000_000_000 }));

        expect(readZip64Eocd(buf, 0, 0, "http://example/test.zip")).toEqual({
            count: 3,
            size: 400,
            offset: 9_000_000_000,
            zip64: true,
        });
    });
});
