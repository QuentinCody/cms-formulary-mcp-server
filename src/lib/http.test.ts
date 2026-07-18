import { describe, expect, it } from "vitest";
import { findEntry, rangeForEntry } from "./http";
import type { ZipDirectory, ZipEntry } from "./zip-directory";

function entry(name: string, localHeaderOffset: number, compressedSize = 1000): ZipEntry {
    return {
        name,
        method: 8,
        compressedSize,
        uncompressedSize: compressedSize * 2,
        localHeaderOffset,
        nameLength: name.length,
    };
}

/**
 * The real June-2026 table of contents, as read from the archive's own central
 * directory. Entry order and names are verbatim — the "insulin beneficiary
 * cost" sibling is the reason entry matching must be prefix-anchored.
 */
function cmsDirectory(overrides: Partial<ZipDirectory> = {}): ZipDirectory {
    return {
        url: "https://data.cms.gov/sites/default/files/2026-06/x/2026_20260610.zip",
        size: 2_296_903_000,
        zip64: false,
        fetchedAt: Date.now(),
        entries: [
            entry("basic drugs formulary file  20260630.zip", 0, 8_304_467),
            entry("beneficiary cost file  20260630.zip", 8_304_537, 465_200),
            entry("excluded drugs formulary file  20260630.zip", 8_769_802, 27_269),
            entry("geographic locator file  20260630.zip", 8_797_144, 29_578),
            entry("indication based coverage formulary file  20260630.zip", 8_826_789, 1_620),
            entry("insulin beneficiary cost file  20260630.zip", 8_828_493, 150_095),
            entry("pharmacy networks file  20260630 part 1.zip", 8_978_661, 409_447_459),
            entry("plan information  20260630.zip", 2_296_498_611, 399_367),
            entry("sample files 20260630.zip", 2_296_898_038, 3_172),
        ],
        ...overrides,
    };
}

describe("findEntry", () => {
    it("selects the plan information entry", () => {
        expect(findEntry(cmsDirectory(), "plans").name).toBe("plan information  20260630.zip");
    });

    it("selects the basic drugs formulary entry", () => {
        expect(findEntry(cmsDirectory(), "formulary").name).toBe(
            "basic drugs formulary file  20260630.zip",
        );
    });

    it("selects beneficiary cost, NOT its insulin sibling", () => {
        // A loose `includes("beneficiary cost")` match would select
        // "insulin beneficiary cost file" whenever it sorted first — the two
        // files have entirely different schemas, so this must stay anchored.
        expect(findEntry(cmsDirectory(), "costs").name).toBe("beneficiary cost file  20260630.zip");
    });

    it("still selects beneficiary cost when the insulin sibling is listed first", () => {
        const dir = cmsDirectory();
        const reordered = cmsDirectory({
            entries: [
                dir.entries.find((e) => e.name.startsWith("insulin"))!,
                ...dir.entries.filter((e) => !e.name.startsWith("insulin")),
            ],
        });

        expect(findEntry(reordered, "costs").name).toBe("beneficiary cost file  20260630.zip");
    });

    it("matches case-insensitively and ignores any directory prefix", () => {
        const dir = cmsDirectory({
            entries: [entry("2026/06/Plan Information  20260630.zip", 42)],
        });

        expect(findEntry(dir, "plans").localHeaderOffset).toBe(42);
    });

    it("throws a diagnostic error naming the real entries when CMS renames a file", () => {
        const dir = cmsDirectory({ entries: [entry("something else entirely.zip", 0)] });

        expect(() => findEntry(dir, "plans")).toThrow(/No entry starting with "plan information"/);
        expect(() => findEntry(dir, "plans")).toThrow(/something else entirely\.zip/);
    });
});

describe("rangeForEntry", () => {
    it("covers the local header, filename, padding and the compressed payload", () => {
        const dir = cmsDirectory();
        const plans = findEntry(dir, "plans");

        const { start, end } = rangeForEntry(plans, dir);

        expect(start).toBe(2_296_498_611);
        // 30 (local header) + nameLength + 256 (pad) + compressed size
        expect(end).toBe(2_296_498_611 + 30 + plans.nameLength + 256 + 399_367);
        expect(end).toBeLessThan(dir.size);
    });

    it("never asks for a range past the end of the object", () => {
        const dir = cmsDirectory();
        const last = findEntry(dir, "plans");
        const nearEnd = cmsDirectory({
            entries: [{ ...last, localHeaderOffset: dir.size - 100, compressedSize: 10_000 }],
        });

        const { end } = rangeForEntry(findEntry(nearEnd, "plans"), nearEnd);

        expect(end).toBe(nearEnd.size - 1);
    });

    it("throws rather than emitting a 416-bound range when the offset is past the object", () => {
        // This is the shipped bug in miniature: the frozen Feb-2026 `plans`
        // offset (2,312,124,500) sits beyond the June-2026 object, and asking
        // for it returned HTTP 416.
        const dir = cmsDirectory();
        const stale = { ...findEntry(dir, "plans"), localHeaderOffset: 2_312_124_500 };

        expect(() => rangeForEntry(stale, dir)).toThrow(/claims local-header offset 2312124500/);
        expect(() => rangeForEntry(stale, dir)).toThrow(/only 2296903000 bytes/);
    });
});
