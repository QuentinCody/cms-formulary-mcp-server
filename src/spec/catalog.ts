import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const formularyCatalog: ApiCatalog = {
    name: "CMS Part D Formulary",
    baseUrl: "https://data.cms.gov",
    version: "2025",
    auth: "none",
    endpointCount: 3,
    notes:
        "- CMS Part D Formulary Public Use Files provide Medicare drug plan coverage data\n" +
        "- Three datasets: Plan Info, Basic Drugs (Formulary), and Beneficiary Cost\n" +
        "- Data sourced from CMS monthly bulk ZIP (nested ZIP, pipe-delimited TXT). Cached 24h.\n" +
        "- All query params are case-insensitive substring filters against field values\n" +
        "- Pagination: use limit (default 100) and offset (0-based) params\n" +
        "- Field names are UPPERCASE (e.g., NDC, CONTRACT_ID, PLAN_ID)\n" +
        "- Tier Level Codes: 1=Preferred Generic, 2=Generic, 3=Preferred Brand, 4=Non-Preferred Drug, 5=Specialty Tier\n" +
        "- Utilization Management Indicators: Y=Yes, N=No for:\n" +
        "  PRIOR_AUTHORIZATION_YN — prior authorization required\n" +
        "  STEP_THERAPY_YN — step therapy required (must try cheaper drugs first)\n" +
        "  QUANTITY_LIMIT_YN — quantity limit applies\n" +
        "- CONTRACT_ID + PLAN_ID uniquely identify a Medicare Part D plan\n" +
        "- FORMULARY_ID links plans to their drug formularies\n" +
        "- NDC (National Drug Code) is the 11-digit drug product identifier\n" +
        "- To find drugs in a plan: first get FORMULARY_ID from /plans, then query /formulary with that FORMULARY_ID",
    endpoints: [
        {
            method: "GET",
            path: "/plans",
            summary: "Search Part D plan information — plan names, contract IDs, formulary IDs, and organization details",
            category: "plans",
            queryParams: [
                { name: "CONTRACT_ID", type: "string", required: false, description: "Medicare contract ID (e.g., H0543)" },
                { name: "PLAN_ID", type: "string", required: false, description: "Plan ID within contract (e.g., 001)" },
                { name: "FORMULARY_ID", type: "string", required: false, description: "Formulary ID (links to drug coverage data)" },
                { name: "PLAN_NAME", type: "string", required: false, description: "Plan name (partial match supported)" },
                { name: "ORG_NAME", type: "string", required: false, description: "Organization/sponsor name" },
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
                { name: "NDC", type: "string", required: false, description: "11-digit National Drug Code (e.g., 00071015523)" },
                { name: "FORMULARY_ID", type: "string", required: false, description: "Formulary ID (get from /plans endpoint)" },
                { name: "TIER_LEVEL_CODE", type: "number", required: false, description: "Tier level: 1=Pref Generic, 2=Generic, 3=Pref Brand, 4=Non-Pref, 5=Specialty" },
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
                { name: "FORMULARY_ID", type: "string", required: false, description: "Formulary ID (get from /plans endpoint)" },
                { name: "TIER", type: "number", required: false, description: "Tier level (1-5)" },
                { name: "DAYS_SUPPLY", type: "number", required: false, description: "Days supply period (e.g., 30, 60, 90)" },
                { name: "COST_TYPE_PREF", type: "string", required: false, description: "Cost type for preferred pharmacy (e.g., Copay, Coinsurance)" },
                { name: "COST_AMT_PREF", type: "string", required: false, description: "Cost amount for preferred pharmacy" },
                { name: "COST_TYPE_NONPREF", type: "string", required: false, description: "Cost type for non-preferred pharmacy" },
                { name: "COST_AMT_NONPREF", type: "string", required: false, description: "Cost amount for non-preferred pharmacy" },
                { name: "limit", type: "number", required: false, description: "Max results (default 100)" },
                { name: "offset", type: "number", required: false, description: "Offset for pagination (0-based)" },
            ],
        },
    ],
};
