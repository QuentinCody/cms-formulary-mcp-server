import { expect, it } from "vitest";
import { deflateSync, zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { localMember, MemberDigest } from "./member-evidence";
import { streamFormularyMatches, inflateRaw } from "./formulary-decode";

it("verifies incremental CRC32 and byte-exact SHA-256", () => {
  const digest = new MemberDigest(); digest.update(strToU8("1234")); digest.update(strToU8("56789"));
  expect(digest.finish({ size: 9, crc32: 0xcbf43926 })).toEqual({ bytes: 9, crc32: 0xcbf43926, crc32_verified: true, sha256: createHash("sha256").update("123456789").digest("hex") });
});
it("retains Windows-1252 native characters, field casing and padding", async () => {
  const raw = Uint8Array.from([...strToU8("ID|name\r\n001| "), 0xd3, 0xe1, ...strToU8(" \r\n")]);
  const zip = zipSync({ "plans.txt": raw }, { level: 6 }); const member = localMember(zip);
  const result = await streamFormularyMatches(member.deflate, [], 1, 0, { ...member, encoding: "windows-1252" });
  expect(result).toMatchObject({ records: [{ ID: "001", name: " Óá " }], source_text: { bytes: raw.length, crc32_verified: true, encoding: "windows-1252", sha256: createHash("sha256").update(raw).digest("hex") } });
  await expect(streamFormularyMatches(member.deflate, [], 1, 0, { ...member, encoding: "utf-8" })).rejects.toThrow();
});
it.each(["size", "crc32"])("rejects a source with changed %s", async field => {
  const member = localMember(zipSync({ "rows.txt": strToU8("ID|value\n001|.2500\n") }));
  await expect(streamFormularyMatches(member.deflate, [], 1, 0, { ...member, [field]: 1, encoding: "utf-8" })).rejects.toMatchObject({ status: 502 });
});
it("caps actual nested ZIP inflation and source record width", async () => {
  await expect(inflateRaw(deflateSync(new Uint8Array(16 * 1024 * 1024 + 1)))).rejects.toMatchObject({ status: 502 });
  await expect(streamFormularyMatches(deflateSync(strToU8("a\n" + "x".repeat(65537) + "\n")), [], 1)).rejects.toMatchObject({ status: 502 });
});
