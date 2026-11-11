import { afterEach, expect, it, vi } from "vitest";
import { fetchRange, getObjectSize } from "./zip-directory";
const url = "https://data.cms.gov/fixture.zip";
afterEach(() => vi.unstubAllGlobals());
it("accepts only an exact partial body and Content-Range", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Range": "bytes 4-5/10" } })));
  expect(await fetchRange(url, 4, 5, "fixture", "test")).toEqual(new Uint8Array([1, 2]));
});
it.each([
  [200, "bytes 4-5/10", 2], [206, "bytes 0-1/10", 2], [206, "bytes 4-5/10", 1], [206, "bytes 4-5/10", 3], [206, "bytes 4-5/5", 2],
])("rejects ignored, shifted, truncated or oversized ranges %#", async (status, contentRange, length) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(length), { status, headers: { "Content-Range": contentRange } })));
  await expect(fetchRange(url, 4, 5, "fixture", "test")).rejects.toThrow();
});
it("rejects excessive ranges before network access", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(fetchRange(url, 0, 20 * 1024 * 1024, "fixture", "test")).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("sizes via HEAD or a validated one-byte suffix probe", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { headers: { "Content-Length": "2300000000" } })));
  expect(await getObjectSize(url, "test")).toBe(2300000000);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 405 })).mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 206, headers: { "Content-Range": "bytes 9-9/10" } })));
  expect(await getObjectSize(url, "test")).toBe(10);
});
