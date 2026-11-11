import { authorizedImport, extractId, importBody, importError, importJson, integer, MANIFEST_LIMIT, record, validExtractId } from "./network-input";
import { validateManifest } from "./network-manifest";
import { readNetworkStore, type NetworkNamespace } from "./network-read";
import type { NetworkStore } from "./network-store";
import { fail } from "./snapshot-http";

export interface NetworkImportEnv {
  FORMULARY_DATA_DO: NetworkNamespace;
  CMS_NETWORK_IMPORT_TOKEN?: string;
}

/** Authenticated operator transfer into existing DOs; no public import tool. */
export async function routeNetworkImport(request: Request, env: NetworkImportEnv): Promise<Response> {
  try {
    if (!env.CMS_NETWORK_IMPORT_TOKEN) fail("CMS_NETWORK_IMPORT_TOKEN is not configured", 503);
    if (!authorizedImport(request, env.CMS_NETWORK_IMPORT_TOKEN)) fail("Unauthorized network import", 401);
    const url = new URL(request.url);
    if (url.search) fail("Network import routes do not accept query parameters");
    let id: string;
    let action: string;
    let body: Uint8Array | undefined;
    if (url.pathname === "/pharmacy-network/import/start" && request.method === "POST") {
      body = await importBody(request, MANIFEST_LIMIT);
      validateManifest(importJson(body)); id = extractId(body); action = "start";
    } else {
      const match = /^\/pharmacy-network\/import\/(cms_network_[a-f0-9]{64})\/(status|chunk|commit|restart)$/.exec(url.pathname);
      if (!match || !validExtractId(match[1])) fail("Unknown network import route", 404);
      [id, action] = [match[1], match[2]];
      if (request.method !== (action === "status" ? "GET" : "POST")) fail("Unsupported import method", 405);
      body = await importBody(request);
      if (action !== "chunk" && body.length) fail("Only chunk requests accept a body");
    }
    const headers = new Headers();
    for (const name of ["x-network-upload-id", "x-network-chunk-index"]) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    const stub = env.FORMULARY_DATA_DO.get(env.FORMULARY_DATA_DO.idFromName(id));
    return await stub.fetch(new Request(`http://network/network-import/${action}`, {
      method: action === "status" ? "GET" : "POST", headers, ...(action === "status" ? {} : { body }),
    }));
  } catch (error) { return importError(error); }
}

export async function handleNetworkRequest(request: Request, store: NetworkStore): Promise<Response> {
  try {
    const action = new URL(request.url).pathname.slice("/network-import/".length);
    if (action === "status" && request.method === "GET") return Response.json(store.status());
    if (request.method !== "POST") fail("Unsupported network storage method", 405);
    const bytes = await importBody(request, action === "start" ? MANIFEST_LIMIT : undefined);
    const upload = request.headers.get("x-network-upload-id") ?? "";
    if (action === "start") return Response.json(store.start(bytes));
    if (action === "extract" || action === "fees") return Response.json(readNetworkStore(store, record(importJson(bytes)), action === "fees"));
    if (action === "chunk") {
      const value = request.headers.get("x-network-chunk-index");
      if (!value || !/^(0|[1-9]\d*)$/.test(value)) fail("Missing integer chunk index");
      return Response.json(store.chunk(integer(Number(value)), bytes, upload));
    }
    if (bytes.length) fail("Commit/restart requests must have an empty body");
    if (action === "commit") return Response.json(store.commit(upload));
    if (action === "restart") return Response.json(store.restart(upload));
    fail("Unknown network storage route", 404);
  } catch (error) { return importError(error); }
}
