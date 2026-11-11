"""Bounded local ZIP reads for CMS pharmacy-network extraction."""
import hashlib
import re
import zipfile


CHUNK = 1024 * 1024


def digest(stream, maximum, sink=None):
    sha, count = hashlib.sha256(), 0
    while chunk := stream.read(CHUNK):
        count += len(chunk)
        if count > maximum:
            raise ValueError("Source exceeds the configured byte limit")
        sha.update(chunk)
        if sink is not None:
            sink.write(chunk)
    return {"bytes": count, "sha256": sha.hexdigest()}


def check_member(info, maximum):
    if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ValueError("Only unencrypted stored/deflate ZIP members are supported")
    if info.is_dir() or info.file_size > maximum:
        raise ValueError("Invalid or oversized ZIP member")


def member_metadata(info):
    return {"name": info.filename, "compression": info.compress_type,
            "compressed_bytes": info.compress_size, "bytes": info.file_size,
            "crc32": info.CRC, "local_header_offset": info.header_offset}


def network_members(archive):
    candidates = [i for i in archive.infolist()
                  if i.filename.rsplit("/", 1)[-1].lower().startswith("pharmacy networks file")]
    if not candidates or len({i.filename for i in candidates}) != len(candidates):
        raise ValueError("Missing or duplicate pharmacy-network members")
    parsed = []
    for info in candidates:
        name = info.filename.rsplit("/", 1)[-1]
        match = re.fullmatch(r"pharmacy networks file\s+(\d{8})(?: part ([1-9]\d*))?\.zip", name, re.I)
        if not match:
            raise ValueError("Unrecognized pharmacy-network member name")
        parsed.append((match[1], int(match[2] or 0), info))
    if len({date for date, _, _ in parsed}) != 1:
        raise ValueError("Pharmacy-network member dates disagree")
    parts = sorted(part for _, part, _ in parsed)
    if parts != [0] and parts != list(range(1, len(parts) + 1)):
        raise ValueError("Pharmacy-network parts are missing or duplicated")
    return [info for _, _, info in sorted(parsed, key=lambda item: item[1])]


def spool_inner(archive, info, target, maximum):
    check_member(info, maximum)
    with archive.open(info) as source, target.open("xb") as sink:
        evidence = digest(source, maximum, sink)
    if evidence["bytes"] != info.file_size:
        raise ValueError("Incomplete nested ZIP")
    # ZipExtFile checks CRC32 at EOF, including for stored outer members.
    return {**member_metadata(info), **evidence, "crc32_verified": True}


def text_member(archive, outer, maximum):
    choices = archive.infolist()
    if len(choices) != 1 or choices[0].filename != outer.filename[:-4] + ".txt":
        raise ValueError("Expected one exactly named TXT in each pharmacy-network ZIP")
    check_member(choices[0], maximum)
    return choices[0]
