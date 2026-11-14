import { createHash } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

const CONNECTIONS = "/api/v1/me/oauth-connections";

async function authenticate(
  context: BrowserContext,
  harness: WorkspaceBrowserHarness,
): Promise<void> {
  await context.addCookies([
    {
      name: "__Secure-skillplane.session",
      value: harness.sessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "skillplane.csrf",
      value: harness.csrfToken,
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

function mcpInitialize(page: Page, origin: string, token: string) {
  return page.request.post(`${origin}/mcp`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "connected-apps-e2e", version: "1.0.0" },
      },
    },
  });
}

test("@connected-apps authorizes a client, lists it, revokes it, and refuses its MCP token", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const harness = await startWorkspaceBrowserHarness({ mcp: true });
  const resource = `${harness.origin}/mcp`;
  const clientName = "Connected Apps E2E Agent";
  let clientId: string | undefined;
  try {
    await authenticate(context, harness);

    await page.goto(`${harness.origin}/account/connected-apps`);
    await expect(
      page.getByRole("heading", { name: "No connected apps" }),
    ).toBeVisible();

    const redirectUri = "http://localhost:9877/oauth/callback";
    const registration = await page.request.post(
      `${harness.origin}/auth/oauth/register`,
      {
        headers: { "content-type": "application/json" },
        data: {
          client_name: clientName,
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "skills:read contexts:read",
        },
      },
    );
    expect(registration.status()).toBe(201);
    clientId = ((await registration.json()) as { readonly client_id: string })
      .client_id;

    const verifier = `connected-apps-verifier-${"d".repeat(48)}`;
    const authorizeUrl = new URL(`${harness.origin}/auth/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      scope: "skills:read contexts:read",
      state: "connected-apps-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const authorization = await page.request.get(authorizeUrl.toString(), {
      maxRedirects: 0,
    });
    expect(authorization.status()).toBe(302);
    const consentLocation = authorization.headers()["location"];
    if (!consentLocation) throw new Error("Consent redirect is missing");
    await page.goto(consentLocation);

    // The consent page's revocation promise links to the management page
    // without abandoning the authorization in this tab.
    const revokeLink = page.getByRole("link", { name: /revoke this connection/u });
    await expect(revokeLink).toHaveAttribute("href", "/account/connected-apps");
    await expect(revokeLink).toHaveAttribute("target", "_blank");

    await page.route("http://localhost:9877/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Agent connected</title><h1>Agent connected</h1>",
      });
    });
    await page.getByRole("button", { name: "Allow access" }).click();
    await expect(page).toHaveURL(/localhost:9877\/oauth\/callback/u);
    const code = new URL(page.url()).searchParams.get("code");
    if (!code) throw new Error("Authorization code is missing");

    const tokenResponse = await page.request.post(
      `${harness.origin}/auth/oauth/token`,
      {
        form: {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          redirect_uri: redirectUri,
          resource,
          code_verifier: verifier,
        },
      },
    );
    expect(tokenResponse.status()).toBe(200);
    const accessToken = (
      (await tokenResponse.json()) as { readonly access_token: string }
    ).access_token;
    expect((await mcpInitialize(page, harness.origin, accessToken)).status()).toBe(200);

    // Reach the page the way a user does: through the account menu.
    await page.goto(`${harness.origin}/workspaces`);
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: /Connected apps/u }).click();
    await expect(page).toHaveURL(`${harness.origin}/account/connected-apps`);

    const row = page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: clientName, level: 3 }),
    });
    await expect(row).toBeVisible();
    await expect(row.getByText(clientId, { exact: true })).toBeVisible();
    await expect(row.getByText(resource, { exact: true })).toBeVisible();
    await expect(row.getByText("skills:read", { exact: true })).toBeVisible();
    await expect(row.getByText("contexts:read", { exact: true })).toBeVisible();
    // The code exchange above issued a token, so the time is known.
    await expect(row.getByText("Not recorded")).toHaveCount(0);

    await row.getByRole("button", { name: `Revoke ${clientName}` }).click();
    const dialog = page.getByRole("dialog", { name: `Revoke ${clientName}?` });
    await expect(dialog).toBeVisible();
    const revoked = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname.startsWith(`${CONNECTIONS}/`),
    );
    await dialog.getByRole("button", { name: "Revoke access" }).click();
    expect((await revoked).status()).toBe(204);

    await expect(
      page.getByRole("heading", { name: "No connected apps" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Connected apps", level: 1 }),
    ).toBeFocused();
    await expect(
      page.getByRole("status").filter({ hasText: "Revoked access for" }),
    ).toHaveText(`Revoked access for ${clientName}.`);

    // The server, not only the page, no longer lists it.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "No connected apps" }),
    ).toBeVisible();

    const refused = await mcpInitialize(page, harness.origin, accessToken);
    expect(refused.status()).toBe(401);
  } finally {
    if (clientId) await harness.deleteOAuthClient(clientId);
    await harness.close();
  }
});

const fixtures = [
  {
    consentId: "ocn_fixture_review",
    clientId: "spclient_fixture_review",
    clientName: "Review agent",
    resource: "https://mcp.example.test/mcp",
    scopes: ["skills:read", "skills:amend"],
    grantedAt: "2026-11-12T09:30:00.000Z",
    lastTokenIssuedAt: "2026-11-13T16:05:00.000Z",
  },
  {
    consentId: "ocn_fixture_docs",
    clientId: "spclient_fixture_docs",
    clientName: "spclient_fixture_docs",
    resource: "https://mcp.example.test/mcp",
    scopes: ["contexts:read"],
    grantedAt: "2026-11-10T08:00:00.000Z",
    lastTokenIssuedAt: null,
  },
] as const;

function envelope(status: number, body: unknown) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

test("@connected-apps shows load failures and restores a revoke the API refuses", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const harness = await startWorkspaceBrowserHarness();
  try {
    await authenticate(context, harness);
    let listFails = true;
    await page.route(`**${CONNECTIONS}`, async (route: Route) => {
      await route.fulfill(
        listFails
          ? envelope(500, {
              ok: false,
              error: {
                code: "INTERNAL_ERROR",
                message: "Skillplane could not list connections",
                requestId: "req_fixture",
              },
            })
          : envelope(200, {
              ok: true,
              data: { connections: fixtures },
              meta: { requestId: "req_fixture" },
            }),
      );
    });
    const deleteStatuses: number[] = [500, 204];
    const deleted: string[] = [];
    await page.route(`**${CONNECTIONS}/*`, async (route: Route) => {
      deleted.push(new URL(route.request().url()).pathname);
      const status = deleteStatuses.shift() ?? 204;
      await route.fulfill(
        status === 204
          ? { status: 204 }
          : envelope(status, {
              ok: false,
              error: {
                code: "INTERNAL_ERROR",
                message: "Skillplane could not complete the request",
                requestId: "req_fixture",
              },
            }),
      );
    });

    await page.goto(`${harness.origin}/account/connected-apps`);
    const failure = page.getByRole("alert").filter({
      hasText: "Connected apps could not be loaded",
    });
    await expect(failure).toContainText("Skillplane could not list connections");
    listFails = false;
    await failure.getByRole("button", { name: "Retry" }).click();

    const reviewRevoke = page.getByRole("button", { name: "Revoke Review agent" });
    await expect(reviewRevoke).toBeVisible();
    // A client without a registered name shows its ID once, as the name.
    await expect(page.getByText("spclient_fixture_docs", { exact: true })).toHaveCount(
      1,
    );
    await expect(page.getByText("Not recorded")).toHaveCount(1);

    // A refused revoke puts the row back where it was and says so.
    await reviewRevoke.click();
    await page
      .getByRole("dialog", { name: "Revoke Review agent?" })
      .getByRole("button", { name: "Revoke access" })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      "Review agent is still connected. Skillplane could not complete the request",
    );
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      "Review agent",
      "spclient_fixture_docs",
    ]);
    await expect(reviewRevoke).toBeFocused();

    // Cancelling sends nothing and returns focus to the row's button.
    await reviewRevoke.click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(reviewRevoke).toBeFocused();
    expect(deleted).toEqual([`${CONNECTIONS}/ocn_fixture_review`]);

    // A successful revoke removes the row and moves focus to the next one.
    await reviewRevoke.click();
    await page
      .getByRole("dialog", { name: "Revoke Review agent?" })
      .getByRole("button", { name: "Revoke access" })
      .click();
    await expect(page.getByRole("heading", { name: "Review agent" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Revoke spclient_fixture_docs" }),
    ).toBeFocused();
    await expect(page.getByRole("alert")).toHaveCount(0);
    // The row hides before the DELETE is sent, so wait for the request itself
    // and for the announcement that only follows the API's confirmation.
    await expect
      .poll(() => deleted)
      .toEqual([
        `${CONNECTIONS}/ocn_fixture_review`,
        `${CONNECTIONS}/ocn_fixture_review`,
      ]);
    await expect(page.getByRole("status")).toHaveText(
      "Revoked access for Review agent.",
    );
  } finally {
    await harness.close();
  }
});
