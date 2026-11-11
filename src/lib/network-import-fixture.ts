/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { FormularyDataDO } from "../do";
import { hashBytes } from "./network-input";
import { routeNetworkImport } from "./network-route";
import { createFormularyApiFetch } from "./api-adapter";

export function harness(token = "local-fixture-token") {
  const fixture = networkNamespace();
  const env = { FORMULARY_DATA_DO: fixture.namespace, CMS_NETWORK_IMPORT_TOKEN: token };
  const call = async (path: string, body?: Uint8Array | string, upload?: string, index?: number, auth = token) => {
    const headers = new Headers({ authorization: `Bearer ${auth}` });
    if (upload) headers.set("x-network-upload-id", upload);
    if (index !== undefined) headers.set("x-network-chunk-index", String(index));
    const response = await routeNetworkImport(new Request(`http://fixture/pharmacy-network/import/${path}`, {
      method: path.endsWith("/status") ? "GET" : "POST", headers, body,
    }), env);
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  return { ...fixture, call, read: createFormularyApiFetch(fixture.namespace) };
}

export function importedFixture(count = 3, note = " Óá ") {
  const columns = ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "PHARMACY_NUMBER", "NOTE", "SELECTED_DISPENSING_FEE_30", "SELECTED_DISPENSING_FEE_60", "SELECTED_DISPENSING_FEE_90"];
  const values = Array.from({ length: count }, (_, index) => ["H0028", "007", "000", index % 2 ? "000000000002" : "000000000001", note, " .3000 ", "0", "0.30"]);
  const records = values.map((row, index) => ({ member: 0, line: index + 2, values: row, raw_base64: Buffer.from(row.join("|") + "\r\n").toString("base64") }));
  const jsonl = records.map(row => JSON.stringify(row) + "\n");
  const txt = columns.join("|") + "\r\n" + values.map(row => row.join("|") + "\r\n").join("");
  const body = {
    schema: "cms-pharmacy-network-extract", version: 1,
    source: { url: "https://data.cms.gov/2026_20260916.zip", sha256: "a".repeat(64), bytes: 1234, sha256_verified: true },
    selection: { match: "exact native text", filters: { CONTRACT_ID: "H0028", PLAN_ID: "007", SEGMENT_ID: "000" } },
    complete_matching_rows: true, all_network_members_scanned: true,
    members: [{ outer: { name: "pharmacy networks file  20260930 part 1.zip", sha256: "b".repeat(64), bytes: 500, crc32: 1, crc32_verified: true },
      text: { name: "pharmacy networks file  20260930 part 1.txt", sha256: hashBytes(txt), bytes: Buffer.byteLength(txt), crc32: 2, crc32_verified: true,
        rows: count, matched_rows: count, blank_lines: 0, encoding: "utf-8", columns,
        raw_header_base64: Buffer.from(columns.join("|") + "\r\n").toString("base64") } }],
    records: { file: "records.jsonl", rows: count, bytes: Buffer.byteLength(jsonl.join("")), sha256: hashBytes(jsonl.join("")) },
  };
  return { body, jsonl, values, records, columns, manifest: new TextEncoder().encode(JSON.stringify(body, null, 2) + "\n") };
}

export function networkNamespace() {
  const stores = new Map<string, { database: DatabaseSync; instance: FormularyDataDO; ready: Promise<void> }>();
  let failInsert = false;
  const namespace = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => {
    let store = stores.get(name);
    if (!store) {
      const database = new DatabaseSync(":memory:");
      const sql = { exec: (query: string, ...bindings: Array<SQLInputValue | ArrayBuffer>) => {
        if (failInsert && query.startsWith("INSERT INTO _network_rows")) throw new Error("simulated database failure");
        const rows = database.prepare(query).all(...bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
        const iterator = rows[Symbol.iterator]();
        return { toArray: () => rows, one: () => rows[0], next: () => iterator.next(), [Symbol.iterator]: () => iterator };
      } };
      const transactionSync = <T>(work: () => T): T => {
        database.exec("BEGIN");
        try { const result = work(); database.exec("COMMIT"); return result; }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      };
      let ready = Promise.resolve();
      const ctx = { storage: { sql, transactionSync }, blockConcurrencyWhile: (work: () => Promise<void>) => { ready = work(); return ready; } };
      const instance = new FormularyDataDO(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
      store = { database, instance, ready }; stores.set(name, store);
    }
    await store.ready; return store.instance.fetch(request);
  } }) } as unknown as DurableObjectNamespace;
  return { namespace, stores, setFailInsert: (value: boolean) => { failInsert = value; }, close: () => { for (const store of stores.values()) store.database.close(); } };
}
