# Pharmacy-network extraction

`extract_network.py` is a Python 3.10+ standard-library reader for the complete
monthly CMS ZIP. It scans every advertised pharmacy-network part and extracts all
rows for one **exact** `CONTRACT_ID`, `PLAN_ID`, `SEGMENT_ID` combination. It handles
both stored and deflated outer members without materializing the multi-gigabyte
TXT files. `upload_network.py` transfers a verified artifact to the existing
Worker storage for immutable, archive-pinned MCP fee queries.

Use MCP `api.get("/pharmacy-network/archive")` to discover the selected release,
native partition names, sizes and advertised CRC32 values. Carry `release_url`
and `expected_snapshot_sha256` for repeat discovery. Discovery does not download
network contents or verify their CRC32, and its metadata hash is not an archive
checksum. Download the exact advertised ZIP and compute its complete SHA-256.
Keep the catalog selection and download receipt alongside the source artifact.

```text
python3 servers/cms-formulary-mcp-server/scripts/extract_network.py \
  --input /path/to/complete-monthly.zip \
  --output /path/to/new-plan-extract.zip \
  --source-url EXACT_ADVERTISED_CMS_ZIP_URL \
  --sha256 COMPLETE_ARCHIVE_SHA256 \
  --contract-id H0028 --plan-id 007 --segment-id 000
```

The example plan key is an observed native key, not a recommendation. Replace it
with the full key from the selected release's Plan Information file. Matching is
case-sensitive and exact; there is no substring matching or numeric conversion.
Leading zeros remain significant. Empty results do not establish a coverage
denial or suppressed-plan status. These are dispensing fees, separate from
negotiated drug prices and patient cost sharing.

## Integrity and resource bounds

The required SHA-256 pins the entire input archive before processing and is
rechecked afterwards. Source URL is recorded as operator-supplied evidence; the
offline utility does not fetch the catalog or attest that CMS published a digest.
Each nested ZIP and TXT is fully read and gets a SHA-256, exact byte count and
verified ZIP CRC32. Missing/duplicate/noncontiguous parts, inconsistent member
date labels, ambiguous fee headers, malformed rows, unsupported compression,
encrypted members, corruption and exceeded limits fail the extraction.

RAM use for row data stays bounded by streaming chunks and one record; a nested
ZIP is temporarily spooled to disk for central-directory access. Source ZIP
directory metadata is read by Python's `zipfile`. Defaults are 8 GiB for the
source archive, 1 GiB per inner ZIP, 8 GiB per TXT, 512 MiB of selected JSONL and
65,536 bytes per source line. The four byte ceilings are explicit CLI options.
An output-limit failure never publishes a partial extract. Temporary files live
beside the output and are cleaned up after success or failure.

The final ZIP is published with an exclusive hard link after all validation. It
never overwrites an existing file, directory or symlink, including one created
during extraction. A failed run leaves no completed output artifact.

## Artifact format

`manifest.json` records the source pin, exact selection, each member's metadata,
complete source row/blank-line counts, matching row count, native header order and
raw header bytes, all byte hashes/CRC checks, and the exact `records.jsonl` hash.
`complete_matching_rows` means every matching row in every network member of that
local archive was retained. It does not mean every plan or a later CMS release
was included, or that an archived plan remains current.

Each JSONL record contains:

- `member`: zero-based index into the manifest's `members` array.
- `line`: one-based physical source line, including the header.
- `values`: native string fields, in that member's `text.columns` order.
- `raw_base64`: exact original line bytes, including its original line ending.

Duplicate rows, empty values, precision and padding are retained. No field is
renamed or coerced. The observed source uses `SELECTED_DISPENSING_FEE_30/60/90`,
while the [2026 record layout](https://data.cms.gov/sites/default/files/2025-10/0564eb37-402d-4110-bd98-2d5399dc30e7/PUFRecordLayout-2026.pdf)
uses `SELECTED_DRUG_DISPENSING_FEE_*`. The reader accepts either complete family,
preserves the actual headers and rejects ambiguity. Default encoding is `cp1252`;
`--encoding utf-8` strictly decodes selected rows as UTF-8. Raw bytes and complete
member hashes remain available regardless of the selected text representation.

## Authenticated resumable import

The target Worker must already have `CMS_NETWORK_IMPORT_TOKEN` configured in its
secret environment. Import HTTP routes are disabled with HTTP 503 when it is
absent. Supply that token to the uploader through an environment variable; it is
never a command-line argument. Use an explicit target Worker origin and the
SHA-256 of the **extract ZIP**, distinct from the manifest's source-archive hash:

```text
python3 servers/cms-formulary-mcp-server/scripts/upload_network.py \
  --input /path/to/new-plan-extract.zip \
  --sha256 COMPLETE_EXTRACT_ZIP_SHA256 \
  --endpoint https://TARGET_WORKER_ORIGIN
```

`--token-env NAME` selects another token environment variable. HTTPS is required
except for local loopback testing. Redirects are rejected. The uploader verifies
the entire artifact and JSONL before starting HTTP requests and rechecks the
artifact before commit. A successful receipt supplies `extract_id`,
`archive_sha256` and the exact plan keys for MCP reads.

Rerun the same command after interruption: the server acknowledges the exact
stored byte position and next chunk. Replayed chunks must have identical bytes.
`--restart` explicitly discards only this manifest's incomplete upload and rotates
its upload ID; stale upload IDs fail. A completed import is immutable and reruns
return its original receipt. Different raw manifests occupy separate extract
IDs, with no implicit latest-release pointer or replacement of another plan.

Operator protocol (all requests require `Authorization: Bearer <token>`):

| Method and path | Body / headers |
| --- | --- |
| `POST /pharmacy-network/import/start` | Exact raw `manifest.json`, up to 256 KiB |
| `GET /pharmacy-network/import/<extract_id>/status` | No body |
| `POST /pharmacy-network/import/<extract_id>/chunk` | Complete newline-terminated JSONL records, up to 512 KiB; `X-Network-Upload-ID` and zero-based `X-Network-Chunk-Index` |
| `POST /pharmacy-network/import/<extract_id>/commit` | No body; `X-Network-Upload-ID` |
| `POST /pharmacy-network/import/<extract_id>/restart` | No body; current `X-Network-Upload-ID` |

The server limits actual bytes read and gives each body a 10-second deadline.
It validates native headers, exact plan keys, ordered member/line positions,
decoded raw fields, per-member row counts and the complete transferred JSONL
digest before publication. Its cp1252 decoding matches Python's strict codec,
including undefined-byte rejection. An incomplete import is unavailable to MCP
readers. Storage uses the existing `FormularyDataDO` binding; no new backend is
required.

The Worker independently verifies the transfer and native row representation.
The source archive/TXT hashes and full-source scan remain **authenticated offline
extractor attestations**: the Worker does not reread the multi-gigabyte archive.
The API marks `native_source_verification.rechecked_by_worker: false` and retains
both the parsed manifest and its exact raw text for verification.

## MCP reads

`GET /pharmacy-network/extract` requires `extract_id` and `archive_sha256` and
returns the full imported source evidence. `GET /pharmacy-network/fees` additionally
requires `CONTRACT_ID`, `PLAN_ID`, `SEGMENT_ID`; `PHARMACY_NUMBER` is an optional
exact filter. Native rows and raw line evidence retain source order and duplicates.
`offset` and `limit` (1–1,000, default 100) page matching rows; each page also stops
at 2 MiB of row data. Follow `next_offset` until null. Only a page containing the
entire selection from offset zero is complete; a final page of a larger result
remains partial.

Both `formulary_execute` aliases support these routes. Full source evidence can
trigger staging even for one row. Return the staging envelope, then inspect its
schema or query the native `results` table through `formulary_query_data`:

```javascript
const page = await api.get("/pharmacy-network/fees", {
  extract_id: "cms_network_<raw-manifest-sha256>",
  archive_sha256: "<complete-source-archive-sha256>",
  CONTRACT_ID: "H0028", PLAN_ID: "007", SEGMENT_ID: "000",
  offset: 0, limit: 1000
});
return page;
```

Staged `payloads` and ordered `content_chunks` preserve the complete response,
including `_source`, `row_sources`, counts and continuation. Native fee columns
are SQLite TEXT. No floating-point conversion or patient cost calculation is
applied. Imports cover only their explicit plan and archived release; they do not
establish current plan availability or coverage.

## Tests and native acceptance

```bash
python3 -m unittest discover -s servers/cms-formulary-mcp-server/scripts -p 'test_*.py'
```

October 3 native acceptance scans all six parts: 306,634,467 rows and
22,380,518,074 TXT bytes. Independent Info-ZIP/libarchive decompression and an
`awk` filter match every part's counts, all 55,049 selected rows, 1,045,931 cells
and original selected line bytes. Fifteen Python tests cover both outer compression
modes, nested CRC corruption, wrong pins, source mutation, output races, limits,
schema errors, duplicate rows, empty matches, BOM/Unicode, raw-byte retention,
uploader integrity checks and interrupted-transfer resumption.
The [implementation tracker](../../../docs/plans/2026-09-26-upstream-api-implementation.md)
records artifact hashes, per-part counts and the separate live MCP discovery checks.
