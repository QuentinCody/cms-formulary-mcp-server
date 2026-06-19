import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { getFormularyData, getFormularyMatches, type FormularyFileType } from "./http";

/**
 * Case-insensitive substring filter.
 */
function matchesFilter(
    records: Record<string, string>[],
    params: Record<string, unknown>,
): Record<string, string>[] {
    const filters = Object.entries(params).filter(
        ([key, val]) =>
            key !== "limit" &&
            key !== "offset" &&
            key !== "size" &&
            val !== undefined &&
            val !== "",
    );

    if (filters.length === 0) return records;

    return records.filter((record) =>
        filters.every(([key, val]) => {
            const fieldValue = record[key];
            if (fieldValue === undefined) return false;
            return fieldValue
                .toLowerCase()
                .includes(String(val).toLowerCase());
        }),
    );
}

function paginate(
    records: Record<string, string>[],
    params: Record<string, unknown>,
): Record<string, string>[] {
    const offset = Number(params.offset) || 0;
    const limit = Number(params.limit ?? params.size) || 100;
    return records.slice(offset, offset + limit);
}

/**
 * CMS Part D Formulary API adapter.
 *
 * Routes:
 *   GET /plans      — Plan information (contract, plan name, formulary ID, premium, deductible)
 *   GET /formulary  — Basic drugs formulary (NDC, tier, PA/ST/QL indicators, RXCUI)
 *   GET /costs      — Beneficiary cost sharing (tier, days supply, copay/coinsurance)
 *
 * Data sourced from CMS monthly bulk ZIP (nested ZIP, pipe-delimited TXT).
 * All query params are case-insensitive substring filters.
 * Special params: limit/size, offset.
 */
function resolveFileType(path: string): FormularyFileType {
    if (path === "plans" || path === "monthly") return "plans";
    if (path === "formulary" || path === "quarterly") return "formulary";
    if (path === "costs") return "costs";
    throw Object.assign(
        new Error(`Unknown path: /${path}. Use /plans, /formulary, or /costs.`),
        { status: 400, data: { validPaths: ["/plans", "/formulary", "/costs"] } },
    );
}

/**
 * Formulary branch: stream-filter the 58MB file (never bulk-loaded).
 * getFormularyMatches applies filters per-line and caps matched records.
 */
async function fetchFormulary(params: Record<string, unknown>) {
    const { matched, total, records } = await getFormularyMatches(params);
    const offset = Number(params.offset) || 0;
    const limit = Number(params.limit ?? params.size) || 100;
    const results = records.slice(offset, offset + limit);
    return {
        status: 200 as const,
        data: {
            total_unfiltered: total,
            total_filtered: matched,
            returned: results.length,
            truncated: matched > records.length,
            offset,
            limit,
            results,
        },
    };
}

export function createFormularyApiFetch(): ApiFetchFn {
    return async (request) => {
        const path = request.path.replace(/^\/+/, "").split("?")[0];
        const params = request.params ?? {};
        const fileType = resolveFileType(path);

        if (fileType === "formulary") {
            return fetchFormulary(params);
        }

        const allData = await getFormularyData(fileType);
        const filtered = matchesFilter(allData, params);
        const results = paginate(filtered, params);

        return {
            status: 200,
            data: {
                total_unfiltered: allData.length,
                total_filtered: filtered.length,
                returned: results.length,
                offset: Number(params.offset) || 0,
                limit: Number(params.limit ?? params.size) || 100,
                results,
            },
        };
    };
}
