import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { formularyFetch } from "./http";

/**
 * CMS Data API dataset IDs for Part D Formulary Public Use Files.
 * These are the stable dataset identifiers used in the CMS data API.
 * Updated periodically — these correspond to the current year's files.
 */
const DATASET_IDS = {
    /** Part D Plan Information */
    planInfo: "f8249ef1-28b9-4c67-9a02-2e2f4b03c0da",
    /** Basic Drugs — Formulary File (NDCs, tiers, PA/ST/QL) */
    basicDrugs: "6a3b78e3-acc0-426c-8e12-1b2e1512a183",
    /** Beneficiary Cost — cost-sharing info by tier and days supply */
    beneficiaryCost: "77e8c0d3-4576-4acc-bdcc-5f53715d3a61",
};

/**
 * Convert clean query params to CMS data API filter syntax.
 * CMS uses filter[FieldName]=value for field-level filtering.
 */
function toCmsParams(params?: Record<string, unknown>): Record<string, unknown> {
    if (!params) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        // Pagination params pass through directly
        if (key === "size" || key === "offset") {
            out[key] = value;
        }
        // keyword is a CMS full-text search parameter
        else if (key === "keyword") {
            out["keyword"] = value;
        }
        // Already in filter[] syntax — pass through
        else if (key.startsWith("filter[")) {
            out[key] = value;
        }
        // Convert field-name params to CMS filter syntax
        else {
            out[`filter[${key}]`] = value;
        }
    }
    return out;
}

export function createFormularyApiFetch(): ApiFetchFn {
    return async (request) => {
        const path = request.path;
        let datasetId: string;

        // Route clean paths to the correct CMS dataset
        if (path === "/plans" || path.startsWith("/plans?")) {
            datasetId = DATASET_IDS.planInfo;
        } else if (path === "/formulary" || path.startsWith("/formulary?")) {
            datasetId = DATASET_IDS.basicDrugs;
        } else if (path === "/costs" || path.startsWith("/costs?")) {
            datasetId = DATASET_IDS.beneficiaryCost;
        } else {
            const error = new Error(
                `Unknown path: ${path}. Use /plans, /formulary, or /costs.`,
            ) as Error & { status: number; data: unknown };
            error.status = 400;
            error.data = { validPaths: ["/plans", "/formulary", "/costs"] };
            throw error;
        }

        const apiPath = `/data-api/v1/dataset/${datasetId}/data`;
        const cmsParams = toCmsParams(request.params);

        // Default to a reasonable page size if none specified
        if (!cmsParams.size) {
            cmsParams.size = 100;
        }

        const response = await formularyFetch(apiPath, cmsParams);

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(
                `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
            ) as Error & { status: number; data: unknown };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }

        const data = await response.json();
        return { status: response.status, data };
    };
}
