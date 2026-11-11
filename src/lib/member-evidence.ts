import { createHash } from "node:crypto";
import { readU16, readU32 } from "./zip-directory";
import { fail } from "./snapshot-http";

const crcTable = Uint32Array.from({ length: 256 }, (_, seed) => {
  let value = seed;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export class MemberDigest {
  private crc = 0xffffffff;
  private hash = createHash("sha256");
  private size = 0;
  update(bytes: Uint8Array) {
    this.size += bytes.length; this.hash.update(bytes);
    for (const byte of bytes) this.crc = crcTable[(this.crc ^ byte) & 255] ^ (this.crc >>> 8);
  }
  finish(expected?: { size: number; crc32: number }) {
    const crc32 = (this.crc ^ 0xffffffff) >>> 0;
    if (expected && (expected.size !== this.size || expected.crc32 !== crc32)) fail("CMS member size or CRC32 mismatch", 502);
    return { bytes: this.size, sha256: this.hash.digest("hex"), crc32, crc32_verified: Boolean(expected) };
  }
}

export function localMember(buffer: Uint8Array) {
  if (buffer.length < 30 || readU32(buffer, 0) !== 0x04034b50 || readU16(buffer, 8) !== 8 || (readU16(buffer, 6) & 1)) fail("Unsupported CMS deflate member header", 502);
  const nameLength = readU16(buffer, 26);
  const extraLength = readU16(buffer, 28);
  const start = 30 + nameLength + extraLength;
  const compressed = readU32(buffer, 18);
  if (!compressed || start + compressed > buffer.length) fail("Incomplete CMS compressed member", 502);
  return { name: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(30, 30 + nameLength)),
    size: readU32(buffer, 22), crc32: readU32(buffer, 14), deflate: buffer.subarray(start, start + compressed) };
}
