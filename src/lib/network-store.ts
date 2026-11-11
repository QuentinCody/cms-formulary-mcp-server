import { createHash } from "node:crypto";
import { extractId, hashBytes, importJson } from "./network-input";
import { validateManifest, type NetworkManifest } from "./network-manifest";
import { validateRecords } from "./network-records";
import { fail } from "./snapshot-http";

export interface NetworkSql {
  exec(query: string, ...bindings: Array<string | number | ArrayBuffer | null>): {
    toArray(): Record<string, unknown>[];
    [Symbol.iterator](): Iterator<Record<string, unknown>>;
  };
}
export interface NetworkState {
  manifest_text: string; upload_id: string; next_chunk: number; received_bytes: number;
  received_rows: number; last_member: number; last_line: number; completed_at: string | null;
}

export class NetworkStore {
  constructor(public sql: NetworkSql, private transaction: <T>(work: () => T) => T) {
    sql.exec("CREATE TABLE IF NOT EXISTS _network_state (id INTEGER PRIMARY KEY CHECK(id=1), manifest_text TEXT NOT NULL, upload_id TEXT NOT NULL, next_chunk INTEGER NOT NULL, received_bytes INTEGER NOT NULL, received_rows INTEGER NOT NULL, last_member INTEGER NOT NULL, last_line INTEGER NOT NULL, completed_at TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS _network_chunks (chunk_index INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, payload BLOB NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS _network_rows (sequence INTEGER PRIMARY KEY, member INTEGER NOT NULL, source_line INTEGER NOT NULL, pharmacy TEXT NOT NULL, values_json TEXT NOT NULL, raw_base64 TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS _network_pharmacy ON _network_rows(pharmacy, sequence)");
  }

  state(): NetworkState {
    const row = this.sql.exec("SELECT * FROM _network_state WHERE id=1").toArray()[0];
    if (!row) fail("Network extract has not been imported", 404);
    return row as unknown as NetworkState;
  }

  manifest(state = this.state()): NetworkManifest {
    return validateManifest(importJson(new TextEncoder().encode(state.manifest_text)));
  }

  status(state = this.state()) {
    return { success: true, extract_id: extractId(state.manifest_text), upload_id: state.upload_id,
      next_chunk: state.next_chunk, received_bytes: state.received_bytes, received_rows: state.received_rows,
      complete: state.completed_at !== null, completed_at: state.completed_at };
  }

  start(bytes: Uint8Array) {
    validateManifest(importJson(bytes));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return this.transaction(() => {
      const current = this.sql.exec("SELECT manifest_text FROM _network_state WHERE id=1").toArray()[0];
      if (current && current.manifest_text !== text) fail("Different manifest already occupies this extract", 409);
      if (!current) this.sql.exec("INSERT INTO _network_state VALUES (1, ?, ?, 0, 0, 0, -1, 0, NULL)", text, crypto.randomUUID());
      return this.status();
    });
  }

  private owned(upload: string) {
    const state = this.state();
    if (!upload || state.upload_id !== upload) fail("Stale or missing network upload ID", 409);
    return state;
  }

  chunk(index: number, bytes: Uint8Array, upload: string) {
    const sha = hashBytes(bytes);
    return this.transaction(() => {
      const state = this.owned(upload);
      if (index < state.next_chunk) {
        const previous = this.sql.exec("SELECT sha256 FROM _network_chunks WHERE chunk_index=?", index).toArray()[0];
        if (previous?.sha256 !== sha) fail("Chunk replay differs from stored bytes", 409);
        return { ...this.status(state), replayed: true };
      }
      if (state.completed_at || index !== state.next_chunk) fail("Completed extract or out-of-order chunk", 409);
      const manifest = this.manifest(state);
      const rows = validateRecords(bytes, manifest, { member: state.last_member, line: state.last_line });
      if (state.received_bytes + bytes.length > manifest.records.bytes || state.received_rows + rows.length > manifest.records.rows) fail("Uploaded records exceed the declared extract", 422);
      this.sql.exec("INSERT INTO _network_chunks VALUES (?, ?, ?)", index, sha, bytes.slice().buffer);
      for (const [offset, row] of rows.entries()) {
        const columns = manifest.members[row.member].text.columns;
        this.sql.exec("INSERT INTO _network_rows VALUES (?, ?, ?, ?, ?, ?)", state.received_rows + offset, row.member, row.line,
          row.values[columns.indexOf("PHARMACY_NUMBER")], JSON.stringify(row.values), row.raw_base64);
      }
      const last = rows[rows.length - 1];
      if (!last) fail("Empty upload chunks are not accepted");
      this.sql.exec("UPDATE _network_state SET next_chunk=next_chunk+1, received_bytes=received_bytes+?, received_rows=received_rows+?, last_member=?, last_line=? WHERE id=1", bytes.length, rows.length, last.member, last.line);
      return this.status();
    });
  }

  commit(upload: string) {
    return this.transaction(() => {
      const state = this.owned(upload);
      if (state.completed_at) return this.status(state);
      const manifest = this.manifest(state);
      if (state.received_bytes !== manifest.records.bytes || state.received_rows !== manifest.records.rows) fail("Network upload is incomplete", 409);
      const hash = createHash("sha256");
      let chunks = 0;
      for (const row of this.sql.exec("SELECT chunk_index, payload FROM _network_chunks ORDER BY chunk_index")) {
        if (row.chunk_index !== chunks++) fail("Missing stored network chunk", 409);
        const payload = row.payload;
        if (payload instanceof ArrayBuffer) hash.update(new Uint8Array(payload));
        else if (ArrayBuffer.isView(payload)) hash.update(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
        else fail("Invalid stored network bytes", 500);
      }
      if (hash.digest("hex") !== manifest.records.sha256 || chunks !== state.next_chunk) fail("Uploaded JSONL hash does not match the manifest; restart the incomplete upload", 422);
      const counts = new Map(this.sql.exec("SELECT member, COUNT(*) AS n FROM _network_rows GROUP BY member").toArray().map(row => [row.member, row.n]));
      if (manifest.members.some((member, index) => (counts.get(index) ?? 0) !== member.text.matched_rows)) fail("Per-member matching row totals disagree", 422);
      this.sql.exec("UPDATE _network_state SET completed_at=? WHERE id=1", new Date().toISOString());
      return this.status();
    });
  }

  restart(upload: string) {
    return this.transaction(() => {
      const state = this.owned(upload);
      if (state.completed_at) fail("Completed network extracts are immutable", 409);
      this.sql.exec("DELETE FROM _network_rows");
      this.sql.exec("DELETE FROM _network_chunks");
      this.sql.exec("UPDATE _network_state SET upload_id=?, next_chunk=0, received_bytes=0, received_rows=0, last_member=-1, last_line=0 WHERE id=1", crypto.randomUUID());
      return this.status();
    });
  }
}
