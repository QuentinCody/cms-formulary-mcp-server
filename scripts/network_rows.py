"""Preserve selected native fields and original line bytes while scanning all rows."""
import base64
import hashlib
import json

from network_archive import CHUNK


MAX_LINE = 65536
KEYS = ("CONTRACT_ID", "PLAN_ID", "SEGMENT_ID")


def clean_line(raw):
    line = raw[:-1] if raw.endswith(b"\n") else raw
    return line[:-1] if line.endswith(b"\r") else line


def native_headers(raw, encoding):
    headers = clean_line(raw).decode(encoding).removeprefix("\ufeff").split("|")
    if any(not h for h in headers) or len(set(h.casefold() for h in headers)) != len(headers):
        raise ValueError("Empty or ambiguous native columns")
    required = set(KEYS) | {"PHARMACY_NUMBER"}
    if not required.issubset(headers):
        raise ValueError("Missing native pharmacy/plan identity columns")
    variants = [prefix for prefix in ("SELECTED_DISPENSING_FEE_", "SELECTED_DRUG_DISPENSING_FEE_")
                if all(prefix + days in headers for days in ("30", "60", "90"))]
    if len(variants) != 1:
        raise ValueError("Missing or ambiguous selected-drug fee column family")
    return headers


class RecordWriter:
    def __init__(self, stream, maximum):
        self.stream, self.maximum = stream, maximum
        self.sha, self.bytes, self.rows = hashlib.sha256(), 0, 0

    def write(self, member, line, values, raw):
        record = {"member": member, "line": line, "values": values,
                  "raw_base64": base64.b64encode(raw).decode("ascii")}
        encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.bytes += len(encoded)
        if self.bytes > self.maximum:
            raise ValueError("Selected records exceed --max-output-bytes; no artifact published")
        self.stream.write(encoded)
        self.sha.update(encoded)
        self.rows += 1

    def receipt(self):
        return {"rows": self.rows, "bytes": self.bytes, "sha256": self.sha.hexdigest()}


def source_lines(stream, receipt, maximum):
    pending = b""
    while chunk := stream.read(CHUNK):
        receipt["bytes"] += len(chunk)
        if receipt["bytes"] > maximum:
            raise ValueError("Uncompressed TXT exceeds --max-text-bytes")
        receipt["sha"].update(chunk)
        lines = (pending + chunk).split(b"\n")
        pending = lines.pop()
        for line in lines:
            if len(line) + 1 > MAX_LINE:
                raise ValueError("Source line exceeds 65,536 bytes")
            yield line + b"\n"
        if len(pending) > MAX_LINE:
            raise ValueError("Source line exceeds 65,536 bytes")
    if pending:
        yield pending


def scan_rows(stream, writer, member, filters, encoding, maximum):
    receipt = {"bytes": 0, "sha": hashlib.sha256()}
    lines = source_lines(stream, receipt, maximum)
    header = next(lines, None)
    if header is None:
        raise ValueError("Missing native pharmacy-network header")
    columns = native_headers(header, encoding)
    selected = [(columns.index(key), value.encode(encoding)) for key, value in filters.items()]
    total, matched, blank = 0, 0, 0
    for number, raw in enumerate(lines, 2):
        line = clean_line(raw)
        if not line:
            blank += 1
            continue
        total += 1
        values = line.split(b"|")
        if len(values) != len(columns):
            raise ValueError(f"Ragged native record at line {number}")
        if all(values[index] == expected for index, expected in selected):
            writer.write(member, number, [value.decode(encoding) for value in values], raw)
            matched += 1
    return {"columns": columns, "raw_header_base64": base64.b64encode(header).decode("ascii"),
            "rows": total, "matched_rows": matched, "blank_lines": blank,
            "bytes": receipt["bytes"], "sha256": receipt["sha"].hexdigest(), "encoding": encoding}
