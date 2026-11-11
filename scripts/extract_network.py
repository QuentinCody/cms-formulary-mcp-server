#!/usr/bin/env python3
"""Extract every pharmacy-network row for one exact plan from a pinned local CMS archive.

Uses Python's standard library, bounded RAM and one temporary nested ZIP on disk.
Publishes a new ZIP containing manifest.json and byte-preserving records.jsonl.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlparse
import zipfile

from network_archive import digest, network_members, spool_inner, text_member, member_metadata
from network_rows import RecordWriter, scan_rows


def validate(args):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", args.sha256):
        raise ValueError("--sha256 must pin the complete source archive")
    url = urlparse(args.source_url)
    if url.scheme != "https" or url.netloc != "data.cms.gov" or url.query or url.fragment:
        raise ValueError("--source-url must be an exact HTTPS data.cms.gov archive URL")
    if not url.path.lower().endswith(".zip"):
        raise ValueError("--source-url must identify the selected ZIP")
    if not re.fullmatch(r"[A-Z]\d{4}", args.contract_id):
        raise ValueError("--contract-id must be the exact five-character native ID")
    if any(not re.fullmatch(r"\d{3}", value) for value in (args.plan_id, args.segment_id)):
        raise ValueError("--plan-id and --segment-id must retain three native digits")
    if min(args.max_archive_bytes, args.max_inner_bytes, args.max_text_bytes, args.max_output_bytes) < 1:
        raise ValueError("All byte limits must be positive")
    if os.path.lexists(args.output):
        raise ValueError("Output exists; choose a new artifact path")
    if args.encoding not in ("cp1252", "utf-8"):
        raise ValueError("Unsupported explicit source encoding")


def extract_part(archive, info, temporary, writer, index, filters, args):
    inner_path = temporary / "inner.zip"
    outer = spool_inner(archive, info, inner_path, args.max_inner_bytes)
    try:
        with zipfile.ZipFile(inner_path) as inner:
            txt = text_member(inner, info, args.max_text_bytes)
            with inner.open(txt) as stream:
                text = scan_rows(stream, writer, index, filters, args.encoding, args.max_text_bytes)
            if text["bytes"] != txt.file_size:
                raise ValueError("Incomplete native TXT")
            result = {"outer": outer, "text": {**member_metadata(txt), **text, "crc32_verified": True}}
    finally:
        inner_path.unlink()
    print(json.dumps({"member": index, "name": info.filename,
                      "source_rows": text["rows"], "matched_rows": text["matched_rows"]}), file=sys.stderr, flush=True)
    return result


def build(args):
    validate(args)
    output = Path(args.output)
    filters = {"CONTRACT_ID": args.contract_id, "PLAN_ID": args.plan_id, "SEGMENT_ID": args.segment_id}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".cms-network-", dir=output.parent) as directory:
        temporary = Path(directory)
        with Path(args.input).open("rb") as artifact:
            original = digest(artifact, args.max_archive_bytes)
            if original["sha256"] != args.sha256.lower():
                raise ValueError("Archive SHA-256 mismatch")
            artifact.seek(0)
            with zipfile.ZipFile(artifact) as archive, (temporary / "records.jsonl").open("xb") as stream:
                selected = network_members(archive)
                writer = RecordWriter(stream, args.max_output_bytes)
                members = [extract_part(archive, info, temporary, writer, index, filters, args)
                           for index, info in enumerate(selected)]
            artifact.seek(0)
            if digest(artifact, args.max_archive_bytes) != original:
                raise ValueError("Source archive changed during extraction")
        manifest = {
            "schema": "cms-pharmacy-network-extract", "version": 1,
            "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source": {"url": args.source_url, "filename": Path(args.input).name, **original,
                       "sha256_verified": True, "provider_published_checksum": False},
            "selection": {"match": "exact native text", "filters": filters},
            "members": members, "records": {"file": "records.jsonl", **writer.receipt()},
            "complete_matching_rows": True, "all_network_members_scanned": True,
            "interpretation": "Selected-drug dispensing fees remain native text, distinct from negotiated drug prices or patient cost sharing. No coverage or suppression inference from zero matches.",
        }
        bundle = temporary / "extract.zip"
        with zipfile.ZipFile(bundle, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as packed:
            packed.write(temporary / "records.jsonl", "records.jsonl")
            packed.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        # Same-filesystem hard link publishes only the validated artifact, atomically
        # failing for every existing path (including symlinks); it never replaces one.
        os.link(bundle, output)
        return manifest


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, help="Complete local CMS monthly ZIP")
    p.add_argument("--output", required=True, help="New extract ZIP; never overwritten")
    p.add_argument("--source-url", required=True, help="Exact advertised archive URL; recorded, not fetched")
    p.add_argument("--sha256", required=True, help="SHA-256 of the entire local archive")
    p.add_argument("--contract-id", required=True)
    p.add_argument("--plan-id", required=True)
    p.add_argument("--segment-id", required=True)
    p.add_argument("--encoding", choices=("cp1252", "utf-8"), default="cp1252")
    p.add_argument("--max-archive-bytes", type=int, default=8 * 1024 ** 3)
    p.add_argument("--max-inner-bytes", type=int, default=1024 ** 3)
    p.add_argument("--max-text-bytes", type=int, default=8 * 1024 ** 3)
    p.add_argument("--max-output-bytes", type=int, default=512 * 1024 ** 2)
    return p


if __name__ == "__main__":
    try:
        print(json.dumps(build(parser().parse_args()), ensure_ascii=False, indent=2))
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(f"Extraction failed: {error}", file=sys.stderr)
        sys.exit(1)
