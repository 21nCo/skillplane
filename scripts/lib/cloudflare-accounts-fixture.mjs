// Test fixture: a stubbed Cloudflare `GET /accounts` listing and the
// development Cloudflare variables, so no test makes a live Cloudflare call.

export const developmentAccountId = "c801".repeat(8);
export const productionAccountId = "1bef".repeat(8);
export const releaseAccountId = "7e1e".repeat(8);
export const otherAccountId = "0a0b".repeat(8);
export const developmentToken = "development-cloudflare-api-token-material-1234567890";

export const developmentCloudflareVariables = Object.freeze({
  SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: developmentToken,
  CLOUDFLARE_ACCOUNT_ID: developmentAccountId,
  SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: productionAccountId,
});

const accountsUrl = "https://api.cloudflare.com/client/v4/accounts";

// `pages` is a list of account-ID pages; a flat list of IDs is one page.
// Each response carries the documented `result_info` (page, per_page, count,
// total_count) without the undocumented `total_pages`. Every request is
// recorded in `calls`; anything but the account listing throws, so a request
// that should not happen fails the test.
export function accountListing(pages, calls = []) {
  const listed = pages.length > 0 && Array.isArray(pages[0]) ? pages : [pages];
  return async (url, init = {}) => {
    const target = new URL(String(url));
    calls.push({ url: target.href, authorization: init.headers?.Authorization });
    if (`${target.origin}${target.pathname}` !== accountsUrl) {
      throw new Error(`Unexpected request to ${target.origin}${target.pathname}`);
    }
    const page = Number(target.searchParams.get("page") ?? "1");
    const result = (listed[page - 1] ?? []).map((id) => ({
      id,
      name: `account ${id}`,
    }));
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: {
        page,
        per_page: Number(target.searchParams.get("per_page") ?? "20"),
        count: result.length,
        total_count: listed.flat().length,
      },
    });
  };
}

const isolatedVariable =
  /^(?:SKILLPLANE_|CLOUDFLARE_|PUBLIC_POSTHOG_|POSTHOG_|RAILWAY_DATABASE_URL$|GITHUB_ACTIONS$)/u;

// Runs `operation` with only the development Cloudflare variables (plus
// `environment`) from the isolated families and `fetch` as the global fetch,
// then restores both.
export async function withDevelopmentCloudflare(
  { fetch, environment = {} },
  operation,
) {
  const savedEnvironment = { ...process.env };
  const savedFetch = globalThis.fetch;
  for (const name of Object.keys(process.env)) {
    if (isolatedVariable.test(name)) Reflect.deleteProperty(process.env, name);
  }
  for (const [name, value] of Object.entries({
    ...developmentCloudflareVariables,
    ...environment,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  globalThis.fetch = fetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env))
      Reflect.deleteProperty(process.env, name);
    Object.assign(process.env, savedEnvironment);
  }
}
