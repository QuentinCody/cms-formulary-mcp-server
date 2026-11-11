#!/usr/bin/env python3
"""Verify and resumably upload a pinned network extract to an explicitly selected Worker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from network_archive import digest


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise ValueError("Endpoint requires HTTPS or an explicit local loopback HTTP address")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Endpoint must be a server origin without credentials, path or query")
    return value.rstrip("/")


class ImportClient:
    def __init__(self, origin, token):
        self.origin, self.token = endpoint(origin), token
        if not token or "\r" in token or "\n" in token:
            raise ValueError("A nonempty import token must be supplied through the selected environment variable")
        self.opener = urllib.request.build_opener(NoRedirect())

    def call(self, path, body=b"", upload=None, index=None):
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/octet-stream"}
        if upload is not None:
            headers["X-Network-Upload-ID"] = upload
        if index is not None:
            headers["X-Network-Chunk-Index"] = str(index)
        request = urllib.request.Request(self.origin + "/pharmacy-network/import/" + path,
                                         data=body, headers=headers, method="POST")
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise ValueError("Import acknowledgement exceeds 64 KiB")
                value = json.loads(raw)
        except urllib.error.HTTPError as error:
            detail = error.read(4096).decode("utf-8", errors="replace").replace(self.token, "[redacted]")
            raise ValueError(f"Import HTTP {error.code}: {detail}") from None
        if not isinstance(value, dict) or value.get("success") is not True:
            raise ValueError("Import did not return a successful acknowledgement")
        return value


def checked_status(status, extract_id, manifest):
    if status.get("extract_id") != extract_id or not isinstance(status.get("upload_id"), str) or not re.fullmatch(r"[a-f0-9-]{36}", status["upload_id"]):
        raise ValueError("Unexpected extract/upload identity in acknowledgement")
    for key in ("next_chunk", "received_bytes", "received_rows"):
        if type(status.get(key)) is not int or status[key] < 0:
            raise ValueError("Invalid upload progress acknowledgement")
    if type(status.get("complete")) is not bool or status["received_bytes"] > manifest["records"]["bytes"] or status["received_rows"] > manifest["records"]["rows"]:
        raise ValueError("Upload progress contradicts manifest")
    if status["complete"] and (status["received_bytes"] != manifest["records"]["bytes"] or status["received_rows"] != manifest["records"]["rows"]):
        raise ValueError("Incomplete upload labelled complete")
    return status


def chunks(stream, target=256 * 1024):
    pending = b""
    while line := stream.readline(512 * 1024 + 1):
        if len(line) > 512 * 1024 or not line.endswith(b"\n"):
            raise ValueError("Each JSONL record must fit 512 KiB and end in a newline")
        if pending and len(pending) + len(line) > target:
            yield pending
            pending = b""
        pending += line
    if pending:
        yield pending


def read_extract_manifest(archive):
    if sorted(archive.namelist()) != ["manifest.json", "records.jsonl"]:
        raise ValueError("Expected exactly manifest.json and records.jsonl")
    if archive.getinfo("manifest.json").file_size > 256 * 1024 or archive.getinfo("records.jsonl").file_size > 512 * 1024 * 1024:
        raise ValueError("Extract member exceeds import limit")
    raw_manifest = archive.read("manifest.json")
    manifest = json.loads(raw_manifest)
    with archive.open("records.jsonl") as records:
        record_pin = digest(records, 512 * 1024 * 1024)
    if any(record_pin[key] != manifest["records"][key] for key in ("bytes", "sha256")):
        raise ValueError("JSONL bytes do not match the manifest")
    return raw_manifest, manifest


def upload(args, client=None):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", args.sha256):
        raise ValueError("--sha256 must pin the complete extract ZIP")
    endpoint(args.endpoint)
    with Path(args.input).open("rb") as source:
        pin = digest(source, 1024 ** 3)
        if pin["sha256"] != args.sha256.lower():
            raise ValueError("Extract artifact SHA-256 mismatch")
        source.seek(0)
        with zipfile.ZipFile(source) as archive:
            raw_manifest, manifest = read_extract_manifest(archive)
            extract_id = "cms_network_" + hashlib.sha256(raw_manifest).hexdigest()
            client = client or ImportClient(args.endpoint, os.environ.get(args.token_env, ""))
            status = checked_status(client.call("start", raw_manifest), extract_id, manifest)
            if args.restart and not status["complete"]:
                status = checked_status(client.call(extract_id + "/restart", upload=status["upload_id"]), extract_id, manifest)
            if not status["complete"]:
                with archive.open("records.jsonl") as records:
                    records.seek(status["received_bytes"])
                    for chunk in chunks(records):
                        expected_bytes = status["received_bytes"] + len(chunk)
                        expected_chunk = status["next_chunk"] + 1
                        status = checked_status(client.call(extract_id + "/chunk", chunk, status["upload_id"], status["next_chunk"]), extract_id, manifest)
                        if status["received_bytes"] != expected_bytes or status["next_chunk"] != expected_chunk:
                            raise ValueError("Chunk acknowledgement did not advance exactly once; rerun to resume")
                        print(json.dumps({"chunks": status["next_chunk"], "bytes": status["received_bytes"], "rows": status["received_rows"]}), file=sys.stderr, flush=True)
        source.seek(0)
        if digest(source, 1024 ** 3) != pin:
            raise ValueError("Extract artifact changed during upload; incomplete import was not committed")
        status = checked_status(client.call(extract_id + "/commit", upload=status["upload_id"]), extract_id, manifest)
        if not status["complete"]:
            raise ValueError("Import remains incomplete")
    return {"endpoint": endpoint(args.endpoint), "artifact_sha256_verified_locally": pin["sha256"],
            "extract_id": extract_id, "archive_sha256": manifest["source"]["sha256"],
            **manifest["selection"]["filters"], "records_sha256": manifest["records"]["sha256"],
            "rows": status["received_rows"], "complete": True, "completed_at": status.get("completed_at")}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--input", required=True)
    result.add_argument("--sha256", required=True, help="SHA-256 of the extract ZIP, distinct from its source archive hash")
    result.add_argument("--endpoint", required=True, help="Explicit Worker origin; no redirects are followed")
    result.add_argument("--token-env", default="CMS_NETWORK_IMPORT_TOKEN")
    result.add_argument("--restart", action="store_true", help="Explicitly discard an incomplete upload and start a new generation; completed extracts remain immutable")
    return result


if __name__ == "__main__":
    options = parser().parse_args()
    try:
        print(json.dumps(upload(options), indent=2))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        token = os.environ.get(options.token_env, "")
        message = str(error).replace(token, "[redacted]") if token else str(error)
        print(f"Upload failed: {message}", file=sys.stderr)
        sys.exit(1)
