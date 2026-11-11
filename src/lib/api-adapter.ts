import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { getFormularyMatches, type FormularyFileType } from "./http";
import { discoverSnapshots, selectSnapshot, snapshotControls, type SnapshotSelection } from "./snapshots";
import { fail } from "./snapshot-http";
import { pageControls, sourceEncoding } from "./formulary-query";
import { describeNetworkArchive } from "./network-archive";
import { readNetwork, type NetworkNamespace } from "./network-read";

function resolveFileType(path: string): FormularyFileType {
    if (path === "plans" || path === "monthly") return "plans";
    if (path === "formulary" || path === "quarterly") return "formulary";
    if (path === "costs") return "costs";
    if (path === "insulin-costs") return "insulin-costs";
    throw Object.assign(
        new Error(`Unknown path: /${path}. Use /plans, /formulary, /costs, or /insulin-costs.`),
        { status: 400, data: { validPaths: ["/plans", "/formulary", "/costs", "/insulin-costs"] } },
    );
}

/** Stream every source table, retaining only the requested matching page. */
async function fetchRows(fileType: FormularyFileType, params: Record<string, unknown>, selection: SnapshotSelection) {
    const { matched, total, records: results, source } = await getFormularyMatches(params, selection, fileType);
    const { offset, limit } = pageControls(params);
    const complete = offset === 0 && results.length === matched;
    return {
        status: 200 as const,
        completeness: { complete, returned: results.length, total_available: matched,
            ...(!complete ? { truncation: { reason: "page_limit" as const, detail: "This response contains one page of the filtered source rows." } } : {}) },
        data: { total_unfiltered: total, total_filtered: matched, returned: results.length,
            truncated: !complete, offset, limit, next_offset: offset + results.length < matched ? offset + results.length : null,
            results, _snapshot: selection, _source: source, release_url: selection.snapshot.url, snapshot_sha256: selection.snapshot_sha256 },
    };
}

export function createFormularyApiFetch(namespace?: NetworkNamespace): ApiFetchFn {
    return async (request) => {
        if (request.method !== "GET" || request.body !== undefined) fail("Formulary supports bodyless GET requests only", 405);
        const path = request.path.replace(/^\/+/, "").split("?")[0];
        if (path === "pharmacy-network/extract" || path === "pharmacy-network/fees") {
            return readNetwork(namespace, path, request.params ?? {});
        }
        const { selection: controls, filters: params } = snapshotControls(request.params ?? {});
        if (path === "snapshots") {
            if (Object.values(request.params ?? {}).some(value => value !== undefined)) fail("/snapshots accepts no parameters");
            return { status: 200, data: await discoverSnapshots() };
        }
        if (path === "snapshot") {
            if (Object.keys(params).length) fail("/snapshot accepts only snapshot selection controls");
            return { status: 200, data: await selectSnapshot(controls) };
        }
        if (path === "pharmacy-network/archive") {
            if (Object.keys(params).length) fail("/pharmacy-network/archive accepts only snapshot selection controls");
            return { status: 200, data: await describeNetworkArchive(await selectSnapshot(controls)) };
        }
        const fileType = resolveFileType(path);
        pageControls(params);
        sourceEncoding(params);
        const selection = await selectSnapshot(controls);
        return fetchRows(fileType, params, selection);
    };
}
