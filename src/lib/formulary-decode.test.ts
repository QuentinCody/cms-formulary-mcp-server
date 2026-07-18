import { deflateSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
    buildStreamFilters,
    decodeEntryRecords,
    extractFromZipBuffer,
    parsePipeDelimited,
    sliceZipEntryDeflate,
    streamFormularyMatches,
} from "./formulary-decode";

const PLANS_TXT =
    "CONTRACT_ID|PLAN_ID|PLAN_NAME|FORMULARY_ID\r\n" +
    "H0028|007|Humana Gold Plus|00026408\r\n" +
    "S5601|123|SilverScript Choice|00026409\r\n";

function u32(v: number): number[] {
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function u16(v: number): number[] {
    return [v & 0xff, (v >>> 8) & 0xff];
}

/**
 * Build a BARE ZIP local entry: local file header + raw-deflate payload, with
 * NO central directory. This is exactly the shape a precisely-bounded HTTP
 * Range over one archive member returns — and the shape fflate cannot parse.
 */
function bareLocalEntry(name: string, payload: Uint8Array, uncompressedSize: number): Uint8Array {
    const nameBytes = strToU8(name);
    return new Uint8Array([
        ...u32(0x04034b50), // local file header signature
        ...u16(20), // version needed
        ...u16(0), // flags
        ...u16(8), // method: deflate
        ...u16(0), // mod time
        ...u16(0), // mod date
        ...u32(0), // crc32 (unchecked on this path)
        ...u32(payload.length),
        ...u32(uncompressedSize),
        ...u16(nameBytes.length),
        ...u16(0), // extra field length
        ...nameBytes,
        ...payload,
    ]);
}

/** The real archive shape: an inner ZIP holding one pipe-delimited TXT. */
function nestedFormularyEntry(innerName: string, text: string): Uint8Array {
    const innerZip = zipSync({ [innerName]: strToU8(text) });
    const payload = deflateSync(innerZip);
    return bareLocalEntry("plan information  20260630.zip", payload, innerZip.length);
}

describe("parsePipeDelimited", () => {
    it("parses headers and rows, trimming CR from CRLF line endings", () => {
        const records = parsePipeDelimited(PLANS_TXT);

        expect(records).toHaveLength(2);
        expect(records[0]).toEqual({
            CONTRACT_ID: "H0028",
            PLAN_ID: "007",
            PLAN_NAME: "Humana Gold Plus",
            FORMULARY_ID: "00026408",
        });
    });

    it("returns nothing for a header-only or empty file", () => {
        expect(parsePipeDelimited("A|B\n")).toEqual([]);
        expect(parsePipeDelimited("")).toEqual([]);
    });
});

describe("sliceZipEntryDeflate", () => {
    it("returns the deflate payload of a bare local entry", () => {
        const payload = deflateSync(strToU8("hello world"));
        const entry = bareLocalEntry("x.txt", payload, 11);

        expect(sliceZipEntryDeflate(entry)).toEqual(payload);
    });

    it("returns null when the payload is truncated by the fetched range", () => {
        const payload = deflateSync(strToU8("hello world"));
        const entry = bareLocalEntry("x.txt", payload, 11);

        // Chop the tail: the header still claims the full compressed size.
        expect(sliceZipEntryDeflate(entry.subarray(0, entry.length - 5))).toBeNull();
    });

    it("returns null for a stored (non-deflate) entry", () => {
        const raw = strToU8("stored");
        const entry = bareLocalEntry("x.txt", raw, raw.length);
        entry[8] = 0; // method = 0 (stored)

        expect(sliceZipEntryDeflate(entry)).toBeNull();
    });

    it("returns null when there is no local header at all", () => {
        expect(sliceZipEntryDeflate(new Uint8Array(64))).toBeNull();
    });
});

describe("extractFromZipBuffer", () => {
    it("reads the TXT out of a complete nested ZIP", () => {
        const inner = zipSync({ "plan information.txt": strToU8(PLANS_TXT) });
        const outer = zipSync({ "plan information.zip": inner });

        const records = extractFromZipBuffer(outer);

        expect(records).toHaveLength(2);
        expect(records?.[0].CONTRACT_ID).toBe("H0028");
    });

    it("CANNOT parse a bare local entry — the reason decodeEntryRecords exists", () => {
        // fflate needs a central directory / EOCD. A precisely-bounded Range over
        // one member has neither, so this returns null ("invalid zip data").
        // The old frozen offsets only worked because their sloppy end ran past
        // EOF and swept the real central directory in behind the payload.
        const bare = nestedFormularyEntry("plan information  20260630.txt", PLANS_TXT);

        expect(extractFromZipBuffer(bare)).toBeNull();
    });
});

describe("decodeEntryRecords", () => {
    it("decodes a bare local entry holding a nested ZIP of pipe-delimited text", () => {
        const bare = nestedFormularyEntry("plan information  20260630.txt", PLANS_TXT);

        return expect(decodeEntryRecords(bare, "plan information")).resolves.toEqual([
            { CONTRACT_ID: "H0028", PLAN_ID: "007", PLAN_NAME: "Humana Gold Plus", FORMULARY_ID: "00026408" },
            { CONTRACT_ID: "S5601", PLAN_ID: "123", PLAN_NAME: "SilverScript Choice", FORMULARY_ID: "00026409" },
        ]);
    });

    it("still decodes a COMPLETE ZIP buffer, the last-resort fallback shape", async () => {
        const inner = zipSync({ "plan information.txt": strToU8(PLANS_TXT) });
        const complete = zipSync({ "plan information.zip": inner });

        const records = await decodeEntryRecords(complete, "plan information");

        expect(records).toHaveLength(2);
    });

    it("returns null for bytes that are not a ZIP at all", async () => {
        expect(await decodeEntryRecords(new Uint8Array(128), "junk")).toBeNull();
    });
});

describe("buildStreamFilters", () => {
    it("keeps field filters and drops pagination params", () => {
        const filters = buildStreamFilters({
            FORMULARY_ID: "00026408",
            NDC: "00002143380",
            limit: 100,
            offset: 0,
            size: 10,
        });

        expect(filters).toEqual([
            ["FORMULARY_ID", "00026408"],
            ["NDC", "00002143380"],
        ]);
    });

    it("lowercases needles and drops empty/undefined values", () => {
        expect(buildStreamFilters({ PLAN_NAME: "Humana", X: "", Y: undefined })).toEqual([
            ["PLAN_NAME", "humana"],
        ]);
    });
});

describe("streamFormularyMatches", () => {
    const FORMULARY_TXT =
        "FORMULARY_ID|NDC|TIER_LEVEL_CODE\r\n" +
        "00026408|00002143380|1\r\n" +
        "00026408|00002143381|3\r\n" +
        "00026409|00002143382|2\r\n";

    it("counts every row but returns only matching records", async () => {
        const deflated = deflateSync(strToU8(FORMULARY_TXT));

        const out = await streamFormularyMatches(deflated, [["FORMULARY_ID", "00026408"]], 1000);

        expect(out.total).toBe(3); // total_unfiltered spans the whole file
        expect(out.matched).toBe(2);
        expect(out.records.map((r) => r.NDC)).toEqual(["00002143380", "00002143381"]);
    });

    it("caps materialized records while still counting all matches", async () => {
        const deflated = deflateSync(strToU8(FORMULARY_TXT));

        const out = await streamFormularyMatches(deflated, [["FORMULARY_ID", "00026408"]], 1);

        expect(out.matched).toBe(2); // the true match count is still reported
        expect(out.records).toHaveLength(1); // ...but only `cap` rows are held
    });
});
