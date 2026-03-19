import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const CMS_BASE = "https://data.cms.gov";

export interface FormularyFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
    baseUrl?: string;
}

/**
 * Fetch from the CMS data API.
 */
export async function formularyFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: FormularyFetchOptions,
): Promise<Response> {
    const baseUrl = opts?.baseUrl ?? CMS_BASE;
    const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts?.headers ?? {}),
    };

    return restFetch(baseUrl, path, params, {
        ...opts,
        headers,
        retryOn: [429, 500, 502, 503],
        retries: opts?.retries ?? 3,
        timeout: opts?.timeout ?? 30_000,
        userAgent: "cms-formulary-mcp-server/1.0 (bio-mcp)",
    });
}
