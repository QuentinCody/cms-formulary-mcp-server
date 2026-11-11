import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import extract_network
from network_archive import network_members
from network_rows import RecordWriter, scan_rows


COLUMNS = ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "PHARMACY_NUMBER", "NOTE",
           "SELECTED_DISPENSING_FEE_30", "SELECTED_DISPENSING_FEE_60", "SELECTED_DISPENSING_FEE_90"]
HEADER = ("|".join(COLUMNS) + "\r\n").encode()
ROW = b"H0028|007|000|000001234567| \xd3\xe1 | .3000 |0|0.30\r\n"


def zip_bytes(name, raw, method=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=method) as archive:
        archive.writestr(name, raw)
    return output.getvalue()


def fixture(root, texts=None, parts=None, methods=None):
    source = root / "source.zip"
    texts = texts or [HEADER + ROW + ROW, HEADER + ROW.replace(b"|007|", b"|107|") + ROW]
    with zipfile.ZipFile(source, "w") as outer:
        for index, raw in enumerate(texts):
            part = (parts or list(range(1, len(texts) + 1)))[index]
            name = f"pharmacy networks file  20260930 part {part}"
            outer.writestr(name + ".zip", zip_bytes(name + ".txt", raw),
                           compress_type=(methods or [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED])[index % 2])
        outer.writestr("unrelated.txt", b"not a network file")
    args = extract_network.parser().parse_args([
        "--input", str(source), "--output", str(root / "extract.zip"),
        "--source-url", "https://data.cms.gov/2026_20260916.zip",
        "--sha256", hashlib.sha256(source.read_bytes()).hexdigest(),
        "--contract-id", "H0028", "--plan-id", "007", "--segment-id", "000",
    ])
    return args


class NetworkExtractTests(unittest.TestCase):
    def test_all_parts_exact_fields_raw_bytes_duplicates_and_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            manifest = extract_network.build(args)
            self.assertEqual([m["text"]["rows"] for m in manifest["members"]], [2, 2])
            self.assertEqual([m["text"]["matched_rows"] for m in manifest["members"]], [2, 1])
            self.assertTrue(manifest["complete_matching_rows"])
            with zipfile.ZipFile(args.output) as artifact:
                raw = artifact.read("records.jsonl")
                self.assertEqual(json.loads(artifact.read("manifest.json")), manifest)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), manifest["records"]["sha256"])
            rows = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(len(rows), 3)
            self.assertEqual([(row["member"], row["line"]) for row in rows], [(0, 2), (0, 3), (1, 3)])
            for row in rows:
                self.assertEqual(base64.b64decode(row["raw_base64"]), ROW)
                self.assertEqual(row["values"], ROW[:-2].decode("cp1252").split("|"))
            for member in manifest["members"]:
                self.assertTrue(member["outer"]["crc32_verified"])
                self.assertTrue(member["text"]["crc32_verified"])
            self.assertFalse(list(Path(directory).glob(".cms-network-*")))

    def test_rejects_wrong_pin_existing_output_and_each_byte_bound(self):
        for failure in ("sha256", "max_archive_bytes", "max_inner_bytes", "max_text_bytes", "max_output_bytes", "existing"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory))
                if failure == "existing":
                    Path(args.output).write_bytes(b"keep")
                else:
                    setattr(args, failure, "0" * 64 if failure == "sha256" else 1)
                with self.assertRaises(ValueError):
                    extract_network.build(args)
                if failure == "existing":
                    self.assertEqual(Path(args.output).read_bytes(), b"keep")
                else:
                    self.assertFalse(Path(args.output).exists())
                self.assertFalse(list(Path(directory).glob(".cms-network-*")))

    def test_requires_complete_unique_partition_sequence(self):
        for parts in ([1, 3], [1, 1], [2, 3]):
            with self.subTest(parts=parts), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory), parts=parts)
                with self.assertRaises(ValueError):
                    extract_network.build(args)
                self.assertFalse(Path(args.output).exists())

    def test_ragged_unselected_rows_and_ambiguous_columns_fail(self):
        for raw in (HEADER + ROW.replace(b"|007|", b"|107|") + b"short\n",
                    HEADER.replace(b"|NOTE|", b"|PLAN_ID|") + ROW,
                    HEADER.replace(b"SELECTED_DISPENSING_FEE_90", b"unknown") + ROW,
                    HEADER + b"x" * 65537):
            with self.subTest(raw=raw[:80]), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory), [raw])
                with self.assertRaises(ValueError):
                    extract_network.build(args)
                self.assertFalse(Path(args.output).exists())

    def test_pdf_fee_labels_are_preserved_without_renaming(self):
        stream = io.BytesIO(HEADER.replace(b"SELECTED_DISPENSING", b"SELECTED_DRUG_DISPENSING") + ROW)
        output = RecordWriter(io.BytesIO(), 10000)
        result = scan_rows(stream, output, 0, {"PLAN_ID": "007"}, "cp1252", 10000)
        self.assertIn("SELECTED_DRUG_DISPENSING_FEE_30", result["columns"])
        self.assertEqual(result["matched_rows"], 1)

    def test_utf8_bom_blank_lines_and_final_unterminated_row(self):
        raw = b"\xef\xbb\xbf" + HEADER + b"\r\n" + ROW[:-2].replace(b"\xd3\xe1", "🧬".encode())
        output = RecordWriter(io.BytesIO(), 10000)
        result = scan_rows(io.BytesIO(raw), output, 0, {"PLAN_ID": "007"}, "utf-8", 10000)
        self.assertEqual((result["rows"], result["blank_lines"], result["matched_rows"]), (1, 1, 1))
        self.assertEqual(result["sha256"], hashlib.sha256(raw).hexdigest())

    def test_source_mutation_and_publish_race_do_not_publish_or_replace(self):
        for failure in ("mutation", "race"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory))
                original = extract_network.digest
                calls = 0
                def changed(*values, **keywords):
                    nonlocal calls
                    result = original(*values, **keywords)
                    calls += 1
                    return {**result, "sha256": "0" * 64} if calls == 2 else result
                def raced(*_):
                    Path(args.output).write_bytes(b"keep")
                    raise FileExistsError("new competing output")
                with contextlib.ExitStack() as stack:
                    if failure == "race":
                        stack.enter_context(patch.object(extract_network.os, "link", side_effect=raced))
                    else:
                        stack.enter_context(patch.object(extract_network, "digest", side_effect=changed))
                    with self.assertRaises((ValueError, FileExistsError)):
                        extract_network.build(args)
                if failure == "race":
                    self.assertEqual(Path(args.output).read_bytes(), b"keep")
                else:
                    self.assertFalse(Path(args.output).exists())

    def test_missing_network_and_wrong_inner_name_fail(self):
        with zipfile.ZipFile(io.BytesIO(zip_bytes("other.txt", b"x"))) as archive:
            with self.assertRaises(ValueError):
                network_members(archive)
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            Path(args.input).write_bytes(zip_bytes("pharmacy networks file  20260930 part 1.zip", zip_bytes("other.txt", HEADER + ROW)))
            args.sha256 = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
            with self.assertRaises(ValueError):
                extract_network.build(args)

    def test_both_nested_crc_failures_are_rejected_even_with_correct_archive_pin(self):
        def corrupt_crc(raw):
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                position = archive.start_dir + 16
            changed = bytearray(raw)
            changed[position] ^= 1
            return bytes(changed)
        for layer in ("outer", "inner"):
            with self.subTest(layer=layer), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory))
                name = "pharmacy networks file  20260930 part 1"
                inner = zip_bytes(name + ".txt", HEADER + ROW)
                if layer == "inner":
                    inner = corrupt_crc(inner)
                raw = zip_bytes(name + ".zip", inner)
                if layer == "outer":
                    raw = corrupt_crc(raw)
                Path(args.input).write_bytes(raw)
                args.sha256 = hashlib.sha256(raw).hexdigest()
                with self.assertRaises(zipfile.BadZipFile):
                    extract_network.build(args)
                self.assertFalse(Path(args.output).exists())

    def test_no_matches_are_explicit_and_do_not_imply_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory)); args.plan_id = "999"
            manifest = extract_network.build(args)
            self.assertEqual(manifest["records"]["rows"], 0)
            self.assertTrue(manifest["all_network_members_scanned"])
            self.assertIn("No coverage or suppression inference", manifest["interpretation"])


if __name__ == "__main__":
    unittest.main()
