import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { harness, importedFixture } from "./network-import-fixture";
import { extractId, hashBytes } from "./network-input";

it("resumes ordered chunks, publishes atomically, and preserves native fee text and bytes", async () => {
  const f = harness(); const source = importedFixture();
  try {
    const started = await f.call("start", source.manifest); const id = started.data.extract_id; const upload = started.data.upload_id;
    const params = { extract_id: id, archive_sha256: source.body.source.sha256, ...source.body.selection.filters };
    expect(id).toBe(extractId(source.manifest));
    await expect(f.read({ method: "GET", path: "/pharmacy-network/fees", params })).rejects.toMatchObject({ status: 409 });
    expect((await f.call(`${id}/chunk`, source.jsonl[0], upload, 1)).status).toBe(409);
    expect((await f.call(`${id}/chunk`, source.jsonl[0], upload, 0)).data).toMatchObject({ next_chunk: 1, received_rows: 1, complete: false });
    expect((await f.call(`${id}/chunk`, source.jsonl[0], upload, 0)).data.replayed).toBe(true);
    expect((await f.call(`${id}/chunk`, source.jsonl[0] + " ", upload, 0)).status).toBe(409);
    expect((await f.call("start", source.manifest)).data).toMatchObject({ upload_id: upload, next_chunk: 1 });
    expect((await f.call(`${id}/commit`, undefined, upload)).status).toBe(409);
    expect((await f.call(`${id}/chunk`, source.jsonl.slice(1).join(""), upload, 1)).status).toBe(200);
    const committed = await f.call(`${id}/commit`, undefined, upload);
    expect(committed.data).toMatchObject({ complete: true, received_rows: 3 });
    expect((await f.call(`${id}/commit`, undefined, upload)).data).toEqual(committed.data);
    expect((await f.call(`${id}/restart`, undefined, upload)).status).toBe(409);
    const result = await f.read({ method: "GET", path: "/pharmacy-network/fees", params: { ...params, PHARMACY_NUMBER: "000000000001", limit: 1 } });
    const data = result.data as any;
    expect(data.results).toEqual([Object.fromEntries(source.columns.map((column, i) => [column, source.values[0][i]]))]);
    expect(data.row_sources).toEqual([{ member: 0, line: 2, raw_base64: source.records[0].raw_base64 }]);
    expect(data).toMatchObject({ total_imported: 3, total_filtered: 2, next_offset: 1, truncated: true });
    expect(data._source).toMatchObject({ manifest_sha256: hashBytes(source.manifest), manifest_text: new TextDecoder().decode(source.manifest),
      transfer: { records_sha256_verified: true }, native_source_verification: { rechecked_by_worker: false } });
    const last = await f.read({ method: "GET", path: "/pharmacy-network/fees", params: { ...params, offset: 2, limit: 1 } });
    expect(last.completeness).toMatchObject({ complete: false });
    expect(last.data).toMatchObject({ next_offset: null });
    for (const changed of [{ archive_sha256: "0".repeat(64) }, { PLAN_ID: "107" }, { SEGMENT_ID: "001" }]) {
      await expect(f.read({ method: "GET", path: "/pharmacy-network/fees", params: { ...params, ...changed } })).rejects.toMatchObject({ status: 409 });
    }
  } finally { f.close(); }
});

it("rejects raw-value corruption, rolls back failed writes and rejects stale upload owners", async () => {
  const f = harness(); const source = importedFixture();
  try {
    const started = (await f.call("start", source.manifest)).data; const id = started.extract_id; const upload = started.upload_id;
    const forged = { ...source.records[0], values: [...source.records[0].values] }; forged.values[5] = "999";
    expect((await f.call(`${id}/chunk`, JSON.stringify(forged) + "\n", upload, 0)).status).toBe(400);
    f.setFailInsert(true);
    expect((await f.call(`${id}/chunk`, source.jsonl[0], upload, 0)).status).toBe(500);
    f.setFailInsert(false);
    expect((await f.call(`${id}/status`)).data).toMatchObject({ next_chunk: 0, received_rows: 0, received_bytes: 0 });
    expect(f.stores.get(id)!.database.prepare("SELECT COUNT(*) AS n FROM _network_chunks").get()?.n).toBe(0);
    const restarted = (await f.call(`${id}/restart`, undefined, upload)).data;
    expect(restarted.upload_id).not.toBe(upload);
    expect((await f.call(`${id}/chunk`, source.jsonl[0], upload, 0)).status).toBe(409);
    expect((await f.call(`${id}/chunk`, source.jsonl.join(""), restarted.upload_id, 0)).status).toBe(200);
    expect((await f.call(`${id}/commit`, undefined, restarted.upload_id)).data.complete).toBe(true);
  } finally { f.close(); }
});

it("never publishes a complete-length upload with the wrong aggregate JSONL hash", async () => {
  const f = harness(); const source = importedFixture(); source.body.records.sha256 = "0".repeat(64);
  try {
    const started = (await f.call("start", JSON.stringify(source.body))).data;
    await f.call(`${started.extract_id}/chunk`, source.jsonl.join(""), started.upload_id, 0);
    expect((await f.call(`${started.extract_id}/commit`, undefined, started.upload_id)).status).toBe(422);
    expect((await f.call(`${started.extract_id}/status`)).data.complete).toBe(false);
  } finally { f.close(); }
});

it("keeps unauthorized, oversized and malformed requests out of storage", async () => {
  const f = harness();
  try {
    expect((await f.call("start", "{}", undefined, undefined, "wrong")).status).toBe(401);
    expect((await f.call("start", " ".repeat(256 * 1024 + 1))).status).toBe(413);
    expect((await f.call("start", "{}")).status).toBe(400);
    expect(f.stores.size).toBe(0);
  } finally { f.close(); }
});

it("publishes an explicitly empty selection without claiming coverage", async () => {
  const f = harness(); const source = importedFixture(0);
  try {
    const started = (await f.call("start", source.manifest)).data;
    expect((await f.call(`${started.extract_id}/commit`, undefined, started.upload_id)).data.complete).toBe(true);
    const result = await f.read({ method: "GET", path: "/pharmacy-network/fees", params: { extract_id: started.extract_id, archive_sha256: source.body.source.sha256, ...source.body.selection.filters } });
    expect(result.data).toMatchObject({ results: [], total_filtered: 0, next_offset: null, truncated: false });
    expect(result.completeness).toMatchObject({ complete: true });
  } finally { f.close(); }
});
