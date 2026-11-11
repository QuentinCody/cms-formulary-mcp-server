import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { harness, importedFixture } from "./network-import-fixture";
import { hashBytes, importBody, nativeLine } from "./network-input";

it("isolates imports by exact manifest and validates counts for every archive part", async () => {
  const f = harness(); const source = importedFixture();
  const other = structuredClone(source.body);
  other.source.sha256 = "c".repeat(64);
  const second = structuredClone(other.members[0]);
  second.outer.name = second.outer.name.replace("part 1", "part 2");
  second.text.name = second.text.name.replace("part 1", "part 2");
  second.text.matched_rows = 1; other.members[0].text.matched_rows = 2;
  other.members.push(second);
  try {
    const first = (await f.call("start", source.manifest)).data;
    const next = (await f.call("start", JSON.stringify(other))).data;
    expect(first.extract_id).not.toBe(next.extract_id);
    for (const state of [first, next]) expect((await f.call(`${state.extract_id}/chunk`, source.jsonl.join(""), state.upload_id, 0)).status).toBe(200);
    expect((await f.call(`${next.extract_id}/commit`, undefined, next.upload_id)).status).toBe(422);
    expect((await f.call(`${first.extract_id}/commit`, undefined, first.upload_id)).data.complete).toBe(true);
    expect((await f.call(`${next.extract_id}/status`)).data.complete).toBe(false);
    const repeated = await Promise.all([f.call("start", source.manifest), f.call("start", source.manifest)]);
    expect(repeated[0].data).toEqual(repeated[1].data);
    expect(repeated[0].data.complete).toBe(true);
  } finally { f.close(); }
});

it("continues byte-limited pages without dropping native rows or raw line evidence", async () => {
  const f = harness(); const source = importedFixture(20, "x".repeat(60000));
  try {
    const state = (await f.call("start", source.manifest)).data;
    for (let index = 0; index < source.jsonl.length; index++) expect((await f.call(`${state.extract_id}/chunk`, source.jsonl[index], state.upload_id, index)).status).toBe(200);
    expect((await f.call(`${state.extract_id}/commit`, undefined, state.upload_id)).data.complete).toBe(true);
    let offset = 0; const raw: string[] = []; let pages = 0;
    do {
      const result = await f.read({ method: "GET", path: "/pharmacy-network/fees", params: {
        extract_id: state.extract_id, archive_sha256: source.body.source.sha256, ...source.body.selection.filters, limit: 1000, offset,
      } });
      const page = result.data as any;
      expect(result.completeness?.complete).toBe(false);
      expect(page.results.length).toBeGreaterThan(0);
      raw.push(...page.row_sources.map((row: { raw_base64: string }) => row.raw_base64));
      offset = page.next_offset; pages++;
    } while (offset !== null);
    expect(pages).toBeGreaterThan(1);
    expect(raw).toEqual(source.records.map(row => row.raw_base64));
  } finally { f.close(); }
});

it("preserves raw UTF-8 BOM identity and rejects raw record reordering", async () => {
  const f = harness(); const source = importedFixture();
  const manifest = Buffer.concat([Buffer.from([239, 187, 191]), source.manifest]);
  try {
    const state = (await f.call("start", manifest)).data;
    expect(state.extract_id).toBe(`cms_network_${hashBytes(manifest)}`);
    expect((await f.call(`${state.extract_id}/chunk`, source.jsonl[1], state.upload_id, 0)).status).toBe(200);
    expect((await f.call(`${state.extract_id}/chunk`, source.jsonl[0], state.upload_id, 1)).status).toBe(400);
    expect((await f.call(`${state.extract_id}/status`)).data.received_rows).toBe(1);
    expect(nativeLine(new Uint8Array([0xd3, 0xe1, 0x80, 13, 10]), "cp1252")).toBe("Óá€");
    expect(() => nativeLine(new Uint8Array([0x81]), "cp1252")).toThrow();
    expect(() => nativeLine(new Uint8Array([0xff]), "utf-8")).toThrow();
  } finally { f.close(); }
});

it("rejects unsafe manifests and unconfigured imports before opening storage", async () => {
  const f = harness(); const off = harness(""); const source = importedFixture();
  try {
    expect((await off.call("start", source.manifest)).status).toBe(503);
    const mutations = [
      (body: typeof source.body) => { body.members[0].text.columns[1] = "contract_id"; },
      (body: typeof source.body) => { body.members[0].text.raw_header_base64 = Buffer.from("wrong").toString("base64"); },
      (body: typeof source.body) => { body.members[0].outer.name = "pharmacy networks file  20260930 part 2.zip"; },
      (body: typeof source.body) => { body.source.url = "https://data.cms.gov.evil.test/archive.zip"; },
      (body: typeof source.body) => { body.records.bytes = 512 * 1024 * 1024 + 1; },
    ];
    for (const mutate of mutations) {
      const body = structuredClone(source.body); mutate(body);
      expect((await f.call("start", JSON.stringify(body))).status).toBe(400);
    }
    expect(f.stores.size + off.stores.size).toBe(0);
  } finally { f.close(); off.close(); }
});

it("bounds actual streaming bytes and cancels stalled bodies", async () => {
  const cancelled = vi.fn();
  const oversized = new Request("http://fixture", { method: "POST", body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel: cancelled,
  }), duplex: "half" } as RequestInit);
  await expect(importBody(oversized, 10)).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    const cancel = vi.fn();
    const stalled = new Request("http://fixture", { method: "POST", body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
    const pending = expect(importBody(stalled)).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(10001); await pending;
    expect(cancel).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
