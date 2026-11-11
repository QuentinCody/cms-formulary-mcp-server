# CMS Formulary MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream CMS Formulary API in natural language. It is part of the [Bio MCP](../../README.md) monorepo.

## Connect

Configured production endpoint (the changes documented below have only been validated locally):

```
https://cms-formulary-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "cms-formulary": {
      "command": "npx",
      "args": ["mcp-remote", "https://cms-formulary-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8853/mcp` (start it with `./scripts/dev-servers.sh cms-formulary`):

```json
{
  "mcpServers": {
    "cms-formulary-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8853/mcp"]
    }
  }
}
```

## Tools

- `formulary_search` — discover available API operations and snapshot recipes
- `formulary_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `formulary_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `formulary_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

All four tools also register an `mcp_`-prefixed alias.

## Monthly snapshots

`/snapshots` returns advertised ZIP distributions and full native dataset metadata. `/snapshot` selects one release and returns its metadata hash. Selection controls are also available on `/plans`, `/formulary`, `/costs` and `/insulin-costs`:

- `snapshot_month`: `YYYY-MM`, derived from the catalog distribution title.
- `benefit_year`: four-digit contract year from the archive filename.
- `release_url`: exact advertised URL, useful for resolving multiple releases in one month.
- `expected_snapshot_sha256`: optional guard against changed selection metadata.

Discovery reads `/data.json` using the documented DCAT-US 3.0 series/release
structure, retaining legacy 1.1 support. Only HTTP 404/410 triggers a request
to `/v1-1-data.json`; malformed metadata and other failures remain errors.
[CMS confirms](https://data.cms.gov/api-docs) the September 29, 2026 launch and
March 31, 2027 compatibility-catalog retirement.

For 3.0, the default follows the selected series' `last.@id` to its release
record, then selects its advertised ZIP. Native series and linked releases
remain in `metadata`; each snapshot carries `release_metadata` and
`latest_in_series`. Duplicate identities and multiple candidate ZIPs require
resolution. A missing latest reference, or a latest release outside the
requested benefit year, requires an explicit `release_url`. The provider's
[FAQ 1.7](https://data.cms.gov/sites/default/files/2026-09/e5bb2f9f-313c-4943-8705-69bc21b8ec42/api-faq-1-7.txt)
documents this ZIP-discovery path. The parser checks CMS's documented
structure rather than certifying full DCAT conformance.

Legacy 1.1 defaults still use the latest catalog distribution-title date,
independent of array order. Undated or ambiguous choices require explicit
selection. There is no automatic February-2026 or frozen-offset fallback.

Each data response retains existing row/count fields and adds `_snapshot`, including native metadata, selected distribution and separate date fields. The [CMS catalog's September example](https://catalog.data.gov/dataset/monthly-prescription-drug-plan-formulary-and-pharmacy-network-information) labels the release September 23 while its filename ends in `20260916`; both are retained. October snapshots may describe the following benefit year. Unknown dates remain null.

Native release `temporal` coverage and `issued` values are retained separately;
neither substitutes for `snapshot_month`. If a 3.0 distribution omits the date
label, use its exact URL for historical selection. The metadata guard covers
the series and linked release records, including changes to the latest pointer.

Complete Code Mode, search and SQL/schema responses now stage above 30 KiB,
measured in UTF-8 bytes. The existing Durable Object preserves the complete
response in `payloads`; the outer citation hashes that envelope. Both aliases
and V8 execution remain available, and staging failure returns an explicit error.

The metadata hash is not an archive checksum, and reads are not atomic or
immutable snapshots. Every data route streams the selected TXT anew, preserving
native field casing, padding, empty strings and leading zeros. `limit` (or `size`)
is an integer from 1 to 1,000; `offset` selects subsequent matching rows without
an overall 1,000-match cap. Basic formulary reads require a column filter.
Filters match case-insensitive substrings; unknown columns fail explicitly.
`next_offset`, `truncated` and response completeness identify partial pages,
including the final page of a larger result.

`source_encoding` defaults to `windows-1252`, matching the observed non-UTF-8
plan text. Explicit `utf-8` uses strict decoding. `_source` records archive URL
and byte size, fetched range, outer/TXT member names, complete selected-member
SHA-256 values, byte counts and verified ZIP member CRC32. It does not claim a
checksum of the entire archive. The full native metadata remains in `_snapshot`;
flat `release_url` and `snapshot_sha256` survive staging for recipe continuation.

ZIP reads require exact HTTP 206 ranges and enforce actual-body limits of 16 MiB
per range. Nested ZIP inflation is bounded to 16 MiB; streamed text to 128 MiB,
with a 65,536-character record limit. Network reads have a 15-second deadline.
Catalog reads allow 24 MiB: the October 3 native DCAT catalog was 17,699,965 bytes,
which exceeded the previous 16 MiB cap. Native data fields stage as SQLite TEXT;
full metadata can be recovered through `payloads` and ordered `content_chunks`.

## 2026 fields and interpretation

The [2026 methodology](https://data.cms.gov/sites/default/files/2025-10/8f1d8b42-bfd1-4f9c-b86d-b92af0c6f3d5/Methodology-PUF-2026.pdf) identifies plans using contract, plan and segment IDs; suppressed plans appear only in the plan file. PUF snapshots can differ from current Medicare Plan Finder. Keep missing downstream records distinct from a coverage denial.

The [2026 record layout](https://data.cms.gov/sites/default/files/2025-10/0564eb37-402d-4110-bd98-2d5399dc30e7/PUFRecordLayout-2026.pdf) uses `TIER_LEVEL_VALUE` and `SELECTED_DRUG_YN` in the basic formulary file. Cost rows join on `CONTRACT_ID`, `PLAN_ID`, `SEGMENT_ID`; `DAYS_SUPPLY` is a code (1=30, 2=90, 3=other, 4=60 days). Cost-type codes distinguish copay and coinsurance; numeric tiers do not have universal names. The catalog now reflects these native fields rather than the older incorrect guidance.

`/insulin-costs` preserves all native copay/coinsurance fields and blank tiers
without conversion or a patient cost calculation. The observed September member
uses lowercase `coin_amt_*_insln` headers, which remain lowercase in output.

`/pharmacy-network/archive` discovers the selected archive's complete network
partition metadata. It retains native names, sizes, offsets and advertised CRC32
without claiming that discovery read or verified the member bodies. The
[offline extractor](scripts/README.md) scans all parts of a checksum-pinned local
archive and publishes all rows for an exact plan key, with original bytes,
field strings and complete member SHA-256/CRC evidence. The authenticated uploader
imports that artifact into existing storage. `/pharmacy-network/extract` exposes
its source evidence, and `/pharmacy-network/fees` returns native fees for its exact
plan and optional exact pharmacy number. Both require the immutable `extract_id`
and whole `archive_sha256`; fee reads also require all three native plan keys.
Only complete imports are readable. Retry/resume and explicit incomplete-upload
restart are supported; completed extracts cannot be replaced.
Operator writes require the existing Worker to have `CMS_NETWORK_IMPORT_TOKEN`
configured; the uploader reads its token from the environment. No write operation
is exposed as an MCP tool. Setup and byte limits are documented in the
[operator guide](scripts/README.md).

The observed source uses `SELECTED_DISPENSING_FEE_30/60/90`, differing from the
record-layout PDF's `SELECTED_DRUG_DISPENSING_FEE_*` labels. The reader preserves
the actual headers. Six native TXT members total 22,380,518,074 bytes and
306,634,467 rows; one plan extraction retains 55,049 rows. This is a separate
large-file path, with no personal cost or negotiated-price calculation.

The Worker verifies the full JSONL transfer hash, member row counts and every
decoded raw field before publication. Source-archive hashes and scans remain
explicitly labelled offline extractor attestations. Each response retains the
parsed and raw manifest, original row bytes and member/line references.
`offset`/`limit` pages at most 1,000 rows and 2 MiB of row data; follow
`next_offset`. Full evidence can stage even a single-row response. Native SQL
fields remain TEXT. See the [operator protocol and examples](scripts/README.md).

The server's 155 tests and the extractor/uploader's 15 Python tests pass. The
local Worker imported 55,049 native rows; 56 fully recovered MCP pages match all
1,045,931 source cells and original line bytes. See the
[acceptance tracker](../../docs/plans/2026-09-26-upstream-api-implementation.md)
for source pins, transport/citation checks and remaining production limitations.

## Local acceptance — October 3, 2026

Native catalog selection retained the complete series/release metadata, the
September 23 release label and September 16 archive filename date separately.
The selected ZIP's member filenames end in September 30. Independent Python ZIP
and text reads verified all selected member hashes and these complete counts:

| Route | Source rows | TXT bytes |
| --- | ---: | ---: |
| `/plans` | 112,294 | 13,689,499 |
| `/costs` | 172,549 | 10,149,436 |
| `/insulin-costs` | 43,045 | 2,365,343 |
| `/formulary` | 1,129,364 | 59,052,703 |

The actual local Worker matched 13 independently selected pages: 4,109 rows and
64,694 source cells, including offsets above 1,000 and final pages. Every selected
cell also matched through staged SQL. Both published recipes matched another 50
native rows. Both tool aliases passed errors and full recovery of a 60,000-byte
Unicode SQL value. Across those runs, 4,213 recorded MCP calls passed citation
checks; 18 required complete staged recovery. Maximum structured/whole responses
were 14,700/14,945 bytes. The standard live harness passes 9 checks; its generic
staging check skips, covered by the dedicated recovery tests.

The 571 focused staging/server tests, TypeScript, lint and dry-run Worker build
pass. `pnpm run check:affected` passes; full `pnpm test` passes **13,135 tests**
with **109 skipped**.

Evidence scripts are in `scratch/2026-10-03-cms-formulary/`; native artifacts and
reports are in `/tmp/cms-formulary-native/` and `/tmp/cms-formulary-*`. These local
checks qualify the observed release, not every historical archive or production.

## Development

```bash
./scripts/dev-servers.sh cms-formulary            # run locally (port 8853)
pnpm --filter cms-formulary-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from CMS Part D formulary PUF and stays under the terms of that source: US public domain.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
