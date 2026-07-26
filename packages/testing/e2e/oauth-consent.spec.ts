import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { startWorkspaceBrowserHarness } from "./support/workspace-browser-harness.js";

const resource = "https://mcp.skillplane.dev/mcp";
const evidenceDirectory = resolve(process.cwd(), ".conduct/screenshots/phase-10");

test("@oauth-consent shows explicit permissions and approves a loopback client", async ({
  page,
  context,
}) => {
  const harness = await startWorkspaceBrowserHarness();
  let clientId: string | undefined;
  try {
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
    const redirectUri = "http://localhost:9876/oauth/callback";
    const registration = await page.request.post(
      `${harness.origin}/auth/oauth/register`,
      {
        headers: { "content-type": "application/json" },
        data: {
          client_name: "Codex Review Agent",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "skills:read skills:amend contexts:read",
        },
      },
    );
    expect(registration.status()).toBe(201);
    const registered = (await registration.json()) as {
      readonly client_id: string;
    };
    clientId = registered.client_id;

    const verifier = `e2e-verifier-${"c".repeat(52)}`;
    const authorizeUrl = new URL(`${harness.origin}/auth/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
      scope: "skills:read skills:amend contexts:read",
      state: "e2e-consent-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const authorization = await page.request.get(authorizeUrl.toString(), {
      maxRedirects: 0,
    });
    expect(authorization.status()).toBe(302);
    const consentLocation = authorization.headers()["location"];
    if (!consentLocation) throw new Error("Consent redirect is missing");
    const consent = new URL(consentLocation);
    await page.goto(`${harness.origin}${consent.pathname}${consent.search}`);

    await expect(
      page.getByRole("heading", {
        name: "Allow Codex Review Agent to use Skillplane?",
      }),
    ).toBeVisible();
    await expect(page.getByText("skills:read", { exact: true })).toBeVisible();
    await expect(page.getByText("skills:amend", { exact: true })).toBeVisible();
    await expect(page.getByText("contexts:read", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("note").getByText("localhost:9876", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Continue only if you started a local agent connection."),
    ).toBeVisible();

    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({
      path: resolve(evidenceDirectory, "oauth-consent-loopback-dark.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Use light theme" }).click();
    await page.screenshot({
      path: resolve(evidenceDirectory, "oauth-consent-loopback-light.png"),
      fullPage: true,
    });

    await page.route("http://localhost:9876/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Agent connected</title><h1>Agent connected</h1>",
      });
    });
    await page.getByRole("button", { name: "Allow access" }).click();
    await expect(page).toHaveURL(/localhost:9876\/oauth\/callback/);
    const callback = new URL(page.url());
    expect(callback.searchParams.get("state")).toBe("e2e-consent-state");
    expect(callback.searchParams.get("code")).toMatch(/^spc_/);
  } finally {
    if (clientId) await harness.deleteOAuthClient(clientId);
    await harness.close();
  }
});
