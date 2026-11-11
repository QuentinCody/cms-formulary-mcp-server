import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from upload_network import ImportClient, chunks, endpoint, parser, upload


class TransferPeer:
    """Protocol peer that stores bytes before optionally losing an acknowledgement."""
    def __init__(self, disconnect=False):
        self.manifest = None
        self.received = b""
        self.count = 0
        self.complete = False
        self.disconnect = disconnect
        self.calls = []

    def call(self, path, body=b"", upload=None, index=None):
        self.calls.append(path)
        if path == "start":
            self.manifest = json.loads(body)
            self.extract_id = "cms_network_" + hashlib.sha256(body).hexdigest()
        elif path.endswith("/chunk"):
            if index != self.count:
                raise AssertionError("Unexpected chunk index")
            self.received += body
            self.count += 1
            if self.disconnect:
                self.disconnect = False
                raise OSError("lost acknowledgement after acceptance")
        elif path.endswith("/commit"):
            if hashlib.sha256(self.received).hexdigest() != self.manifest["records"]["sha256"]:
                raise AssertionError("Commit did not preserve exact bytes")
            self.complete = True
        return {"success": True, "extract_id": self.extract_id, "upload_id": "11111111-1111-1111-1111-111111111111",
                "next_chunk": self.count, "received_bytes": len(self.received), "received_rows": len(self.received.splitlines()), "complete": self.complete}


def artifact(root):
    records = b"".join((json.dumps({"fixture": "α🧬" * 1500, "index": i}, ensure_ascii=False) + "\n").encode() for i in range(90))
    manifest = {"records": {"file": "records.jsonl", "bytes": len(records), "rows": 90, "sha256": hashlib.sha256(records).hexdigest()},
                "source": {"sha256": "a" * 64}, "selection": {"filters": {"CONTRACT_ID": "H0028", "PLAN_ID": "007", "SEGMENT_ID": "000"}}}
    path = root / "artifact.zip"
    with zipfile.ZipFile(path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("records.jsonl", records)
    args = parser().parse_args(["--input", str(path), "--sha256", hashlib.sha256(path.read_bytes()).hexdigest(), "--endpoint", "http://127.0.0.1:8853"])
    return args, records


class UploadTests(unittest.TestCase):
    def test_lost_acknowledgement_resumes_at_exact_byte_offset_without_reupload(self):
        with tempfile.TemporaryDirectory() as directory:
            args, records = artifact(Path(directory))
            peer = TransferPeer(disconnect=True)
            with self.assertRaisesRegex(OSError, "lost acknowledgement"):
                upload(args, peer)
            first = len(peer.received)
            self.assertGreater(first, 0)
            receipt = upload(args, peer)
            self.assertEqual(peer.received, records)
            self.assertEqual(receipt["rows"], 90)
            self.assertEqual(receipt["PLAN_ID"], "007")
            self.assertTrue(receipt["complete"])
            count = peer.count
            self.assertEqual(upload(args, peer), receipt)
            self.assertEqual(peer.count, count)

    def test_wrong_artifact_pin_stops_before_any_request(self):
        with tempfile.TemporaryDirectory() as directory:
            args, _ = artifact(Path(directory)); args.sha256 = "0" * 64
            peer = TransferPeer()
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                upload(args, peer)
            self.assertEqual(peer.calls, [])

    def test_wrong_member_pin_stops_before_any_request(self):
        with tempfile.TemporaryDirectory() as directory:
            args, records = artifact(Path(directory))
            with zipfile.ZipFile(args.input) as original:
                manifest = json.loads(original.read("manifest.json"))
            manifest["records"]["sha256"] = "0" * 64
            with zipfile.ZipFile(args.input, "w") as changed:
                changed.writestr("manifest.json", json.dumps(manifest)); changed.writestr("records.jsonl", records)
            args.sha256 = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
            peer = TransferPeer()
            with self.assertRaisesRegex(ValueError, "JSONL bytes"):
                upload(args, peer)
            self.assertEqual(peer.calls, [])

    def test_chunks_preserve_utf8_bytes_and_reject_unbounded_or_unterminated_records(self):
        raw = ("α🧬\n" * 100).encode()
        self.assertEqual(b"".join(chunks(io.BytesIO(raw), 31)), raw)
        for raw in (b"x" * (512 * 1024 + 1) + b"\n", b"no newline"):
            with self.assertRaises(ValueError):
                list(chunks(io.BytesIO(raw)))

    def test_origin_and_token_constraints_prevent_implicit_destinations(self):
        self.assertEqual(endpoint("https://worker.example/"), "https://worker.example")
        for url in ("http://worker.example", "https://user:secret@worker.example", "https://worker.example/mcp", "https://worker.example/?token=x", "file:///tmp/x"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                endpoint(url)
        for token in ("", "token\nheader"):
            with self.assertRaises(ValueError):
                ImportClient("http://localhost:8853", token)


if __name__ == "__main__":
    unittest.main()
