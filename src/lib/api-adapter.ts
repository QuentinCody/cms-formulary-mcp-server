import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { getFormularyData, type FormularyFileType } from "./http";

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
export function createFormularyApiFetch(): ApiFetchFn {
    return async (request) => {
        const path = request.path.replace(/^\/+/, "").split("?")[0];
        const params = request.params ?? {};

        let fileType: FormularyFileType;

        if (path === "plans" || path === "monthly") {
            fileType = "plans";
        } else if (path === "formulary" || path === "quarterly") {
            fileType = "formulary";
        } else if (path === "costs") {
            fileType = "costs";
        } else {
            throw Object.assign(
                new Error(
                    `Unknown path: /${path}. Use /plans, /formulary, or /costs.`,
                ),
                {
                    status: 400,
                    data: { validPaths: ["/plans", "/formulary", "/costs"] },
                },
            );
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
