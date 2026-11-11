import { afterEach, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
const mocks = vi.hoisted(() => ({ directory: vi.fn(), select: vi.fn() }));
vi.mock("./zip-directory", async original => ({ ...await original<typeof import("./zip-directory")>(), readZipDirectory: mocks.directory }));
vi.mock("./snapshots", async original => ({ ...await original<typeof import("./snapshots")>(), selectSnapshot: mocks.select }));
import { networkParts } from "./network-archive";
import { createFormularyApiFetch } from "./api-adapter";
import { locateCentralDirectory, parseCentralDirectory, type ZipDirectory } from "./zip-directory";

afterEach(() => vi.clearAllMocks());
const url = "https://data.cms.gov/2026_20260916.zip";
const name = (part: number) => `pharmacy networks file  20260930 part ${part}.zip`;
function directory(names = [name(2), name(1)]): ZipDirectory {
  return { url, size: 2291903716, fetchedAt: 0, zip64: false,
    entries: names.map((entry, index) => ({ name: entry, crc32: 123 + index, method: index % 2 ? 0 : 8,
      compressedSize: 409000000, uncompressedSize: 410000000, localHeaderOffset: index * 410000100, nameLength: entry.length })) };
}

it("retains observed partition metadata without claiming read or checksum verification", () => {
  const source = directory();
  const parts = networkParts(source);
  expect(parts.map(part => part.part)).toEqual([1, 2]);
  expect(parts[0]).toEqual({ ...source.entries[1], part: 1, member_date_label: "20260930", crc32_verified: false });
});

it.each([
  [], [name(1), name(1)], [name(1), name(3)], [name(2)],
  [name(1), name(2).replace("20260930", "20260831")],
  ["pharmacy networks file unknown.zip"],
].map(names => ({ names })))("rejects missing, duplicated, inconsistent or unrecognized partitions %#", ({ names }) => {
  expect(() => networkParts(directory(names))).toThrow();
});

it("accepts one unpartitioned network member and rejects unsupported compression", () => {
  expect(networkParts(directory(["pharmacy networks file  20260930.zip"]))[0].part).toBe(0);
  const source = directory(); source.entries[0].method = 12;
  expect(() => networkParts(source)).toThrow("Unsupported");
});

it("preserves the central directory's native CRC32", () => {
  const bytes = zipSync({ [name(1)]: strToU8("123456789") }, { level: 0 });
  const location = locateCentralDirectory(bytes, 0, url);
  expect(parseCentralDirectory(bytes.subarray(location.offset, location.offset + location.size), url)[0])
    .toMatchObject({ crc32: 0xcbf43926, method: 0, uncompressedSize: 9 });
});

it("discovers the explicitly selected archive and rejects filters before network reads", async () => {
  const selection = { snapshot: { url }, snapshot_sha256: "a".repeat(64), metadata: { original: "kept" } };
  mocks.select.mockResolvedValue(selection); mocks.directory.mockResolvedValue(directory());
  const fetcher = createFormularyApiFetch();
  const result = await fetcher({ method: "GET", path: "/pharmacy-network/archive", params: { release_url: url } });
  expect(mocks.select).toHaveBeenCalledWith({ release_url: url });
  expect(mocks.directory).toHaveBeenCalledWith(url, expect.any(String));
  expect(result.data).toMatchObject({ archive_bytes: 2291903716, archive_sha256: null, archive_checksum_verified: false,
    _snapshot: selection, reader: { mode: "offline", import_required: true, fee_query_path: "/pharmacy-network/fees" } });
  mocks.select.mockClear(); mocks.directory.mockClear();
  await expect(fetcher({ method: "GET", path: "/pharmacy-network/archive", params: { CONTRACT_ID: "H0028" } })).rejects.toMatchObject({ status: 400 });
  expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.directory).not.toHaveBeenCalled();
});
