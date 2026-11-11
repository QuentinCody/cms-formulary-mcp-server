import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";
import { snapshotEndpoints, snapshotNotes, snapshotParams, snapshotWorkflows, sourceEncodingParam } from "./snapshots";
import { networkEndpoints } from "./network";

export const formularyCatalog: ApiCatalog = {
    name: "CMS Part D Formulary",
    baseUrl: "https://data.cms.gov",
    version: "2026",
    auth: "none",
    endpointCount: 9,
    workflows: snapshotWorkflows,
    notes:
        "- CMS Part D Formulary Public Use Files provide Medicare drug plan coverage data\n" +
        "- Data tables: Plan Info, Basic Drugs, Beneficiary Cost, and Insulin Beneficiary Cost\n" +
        "- Data sourced from CMS monthly bulk ZIP (nested ZIP, pipe-delimited TXT). Stream-filtered for every page.\n" +
        "- All query params are case-insensitive substring filters against field values\n" +
        "- Pagination: use limit (default 100) and offset (0-based) params\n" +
        "- Field names preserve source casing (e.g., NDC, CONTRACT_ID, coin_amt_pref_insln)\n" +
        "- TIER_LEVEL_VALUE is a native cost-share tier; do not infer a universal tier name from its number\n" +
        "- Utilization Management Indicators: Y=Yes, N=No for:\n" +
        "  PRIOR_AUTHORIZATION_YN — prior authorization required\n" +
        "  STEP_THERAPY_YN — step therapy required (must try cheaper drugs first)\n" +
        "  QUANTITY_LIMIT_YN — quantity limit applies\n" +
        "- CONTRACT_ID + PLAN_ID + SEGMENT_ID identify a Medicare Part D plan\n" +
        "- FORMULARY_ID links plans to their drug formularies\n" +
        "- NDC (National Drug Code) is the 11-digit drug product identifier\n" +
        "- To find drugs in a plan: first get FORMULARY_ID from /plans, then query /formulary with that FORMULARY_ID\n" +
        "- /formulary requires at least one native field filter; other tables allow unfiltered bounded pages.\n" +
        "- limit/size is 1–1000; offset selects matching rows across the complete source, including beyond row 1000.\n" +
        "- total_filtered counts all matches; next_offset continues the page; truncated marks a partial result.\n" +
        "- Native headers retain their original case (insulin amounts are lowercase), values retain padding and numeric precision.\n" +
        "- Filter keys and substring values are case-insensitive; unknown columns fail explicitly.\n" +
        "- source_encoding defaults to windows-1252; select utf-8 explicitly when appropriate. _source carries TXT SHA-256 and nested CRC checks.\n" + snapshotNotes,
    endpoints: [
        ...snapshotEndpoints,
        ...networkEndpoints,
        {
            method: "GET", path: "/pharmacy-network/archive", category: "pharmacy-network",
            summary: "Discover every network ZIP partition in the selected monthly archive for offline extraction. Returns native names, sizes, offsets and unverified advertised CRC32; does not query fees.",
            queryParams: snapshotParams,
        },
        {
            method: "GET",
            path: "/plans",
            summary: "Search Part D plan information — plan names, contract IDs, formulary IDs, and organization details",
            category: "plans",
            queryParams: [
                ...snapshotParams, sourceEncodingParam,
                { name: "CONTRACT_ID", type: "string", required: false, description: "Medicare contract ID (e.g., H0543)" },
                { name: "PLAN_ID", type: "string", required: false, description: "Plan ID within contract (e.g., 001)" },
                { name: "SEGMENT_ID", type: "string", required: false, description: "Plan segment ID; retain as part of plan identity" },
                { name: "FORMULARY_ID", type: "string", required: false, description: "Formulary ID (links to drug coverage data)" },
                { name: "PLAN_NAME", type: "string", required: false, description: "Plan name (partial match supported)" },
                { name: "CONTRACT_NAME", type: "string", required: false, description: "Organization contract name" },
                { name: "limit", type: "number", required: false, description: "Max results (default 100)" },
                { name: "offset", type: "number", required: false, description: "Offset for pagination (0-based)" },
            ],
        },
        {
            method: "GET",
            path: "/formulary",
            summary: "Look up drug formulary coverage — NDCs, tier levels, prior auth, step therapy, and quantity limits",
            category: "formulary",
            queryParams: [
                ...snapshotParams, sourceEncodingParam,
                { name: "NDC", type: "string", required: false, description: "11-digit National Drug Code (e.g., 00071015523)" },
                { name: "FORMULARY_ID", type: "string", required: false, description: "Formulary ID (get from /plans endpoint)" },
                { name: "TIER_LEVEL_VALUE", type: "string", required: false, description: "Native cost-share tier; meaning depends on plan benefit design" },
                { name: "SELECTED_DRUG_YN", type: "string", required: false, description: "Native flag identifying drugs selected for negotiation" },
                { name: "PRIOR_AUTHORIZATION_YN", type: "string", required: false, description: "Prior auth required (Y or N)" },
                { name: "STEP_THERAPY_YN", type: "string", required: false, description: "Step therapy required (Y or N)" },
                { name: "QUANTITY_LIMIT_YN", type: "string", required: false, description: "Quantity limit applies (Y or N)" },
                { name: "limit", type: "number", required: false, description: "Max results (default 100)" },
                { name: "offset", type: "number", required: false, description: "Offset for pagination (0-based)" },
            ],
        },
        {
            method: "GET",
            path: "/costs",
            summary: "Get beneficiary cost-sharing information — copays/coinsurance by tier, days supply, and pharmacy type",
            category: "costs",
            queryParams: [
                ...snapshotParams, sourceEncodingParam,
                { name: "CONTRACT_ID", type: "string", required: false, description: "Contract ID from the selected plan row" },
                { name: "PLAN_ID", type: "string", required: false, description: "Plan ID from the selected plan row" },
                { name: "SEGMENT_ID", type: "string", required: false, description: "Segment ID from the selected plan row" },
                { name: "TIER", type: "string", required: false, description: "Native cost-share tier value" },
                { name: "DAYS_SUPPLY", type: "string", required: false, description: "Native code: 1=30 days, 2=90 days, 3=other, 4=60 days" },
                { name: "COST_TYPE_PREF", type: "string", required: false, description: "Native code: 0=not offered, 1=copay, 2=coinsurance" },
                { name: "COST_AMT_PREF", type: "string", required: false, description: "Cost amount for preferred pharmacy" },
                { name: "COST_TYPE_NONPREF", type: "string", required: false, description: "Native code for standard retail: 0=not offered, 1=copay, 2=coinsurance" },
                { name: "COST_AMT_NONPREF", type: "string", required: false, description: "Cost amount for non-preferred pharmacy" },
                { name: "limit", type: "number", required: false, description: "Max results (default 100)" },
                { name: "offset", type: "number", required: false, description: "Offset for pagination (0-based)" },
            ],
        },
    ],
};
