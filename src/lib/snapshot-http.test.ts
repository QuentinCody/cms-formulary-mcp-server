import { afterEach, expect, it, vi } from "vitest";
import { boundedFetch, catalogJson, snapshotHash } from "./snapshot-http";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("bounds actual body bytes even when Content-Length lies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oversized", { headers: { "Content-Length": "1" } })));
  await expect(boundedFetch("https://data.cms.gov/test", {}, 3)).rejects.toMatchObject({ status: 502 });
});
it("checks response headers before reading a potentially multi-GB full-body response", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 200 })));
  await expect(boundedFetch("https://data.cms.gov/test", {}, 3, () => { throw new Error("range required"); })).rejects.toThrow("range required");
  expect(cancel).toHaveBeenCalled();
});
it.each(["headers", "body"])("bounds stalled %s", async phase => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", phase === "headers" ? vi.fn(() => new Promise(() => {})) : vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))));
  const result = expect(boundedFetch("https://data.cms.gov/test", {}, 10)).rejects.toMatchObject({ status: 504 });
  await vi.advanceTimersByTimeAsync(15001); await result;
});
it("rejects invalid catalog JSON and non-CMS URLs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>error</html>")));
  await expect(catalogJson("/data.json")).rejects.toMatchObject({ status: 502 });
  await expect(boundedFetch("https://evil.example/file", {}, 1)).rejects.toMatchObject({ status: 400 });
});
it("hashes metadata independently of property order", async () => {
  expect(await snapshotHash({ b: [1, 2], a: 0 })).toBe(await snapshotHash({ a: 0, b: [1, 2] }));
});
it("accepts a current-size catalog above the old 16 MiB ceiling", async () => {
  const catalog = { description: "x".repeat(17 * 1024 * 1024), dataset: [] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(catalog)));
  expect((await catalogJson("/data.json")).description).toBe(catalog.description);
});
