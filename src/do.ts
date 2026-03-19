import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class FormularyDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        if (Array.isArray(data)) {
            const sample = data[0];
            if (sample && typeof sample === "object") {
                // Basic Drugs Formulary data — NDCs with tier and utilization management
                if ("NDC" in sample || "ndc" in sample) {
                    return {
                        tableName: "formulary_drugs",
                        indexes: [
                            "NDC",
                            "ndc",
                            "FORMULARY_ID",
                            "formulary_id",
                            "TIER_LEVEL_CODE",
                            "tier_level_code",
                            "PRIOR_AUTHORIZATION_YN",
                            "prior_authorization_yn",
                        ],
                    };
                }
                // Plan Info data
                if (
                    ("CONTRACT_ID" in sample || "contract_id" in sample) &&
                    ("PLAN_ID" in sample || "plan_id" in sample)
                ) {
                    return {
                        tableName: "plan_info",
                        indexes: [
                            "CONTRACT_ID",
                            "contract_id",
                            "PLAN_ID",
                            "plan_id",
                            "FORMULARY_ID",
                            "formulary_id",
                            "PLAN_NAME",
                            "plan_name",
                        ],
                    };
                }
                // Beneficiary Cost data
                if ("COST_AMT_PREF" in sample || "cost_amt_pref" in sample || "DAYS_SUPPLY" in sample || "days_supply" in sample) {
                    return {
                        tableName: "beneficiary_cost",
                        indexes: [
                            "FORMULARY_ID",
                            "formulary_id",
                            "TIER" ,
                            "tier",
                            "DAYS_SUPPLY",
                            "days_supply",
                            "COST_TYPE_PREF",
                            "cost_type_pref",
                        ],
                    };
                }
            }
        }

        // Single record (object, not array)
        const obj = data as Record<string, unknown>;
        if (obj.NDC || obj.ndc) {
            return {
                tableName: "formulary_drugs",
                indexes: ["NDC", "ndc", "FORMULARY_ID", "formulary_id"],
            };
        }
        if ((obj.CONTRACT_ID || obj.contract_id) && (obj.PLAN_ID || obj.plan_id)) {
            return {
                tableName: "plan_info",
                indexes: ["CONTRACT_ID", "contract_id", "PLAN_ID", "plan_id"],
            };
        }

        return undefined;
    }
}
