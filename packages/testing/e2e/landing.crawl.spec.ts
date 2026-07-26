import { expect, test } from "@playwright/test";
import {
  startLandingBrowserHarness,
  type LandingBrowserHarness,
} from "./support/landing-browser-harness.js";

let harness: LandingBrowserHarness;

test.beforeAll(async () => {
  harness = await startLandingBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@landing-crawl exposes canonical crawl surfaces and only public skill URLs", async ({
  page,
  request,
}) => {
  const publicPath = `/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}`;
  for (const path of ["/", "/skills", publicPath]) {
    const response = await request.get(`${harness.origin}${path}`);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["cache-control"]).toContain("must-revalidate");
  }

  await page.goto(harness.origin);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://skillplane.dev/",
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    /Skillplane/u,
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://skillplane.dev/social-card.svg",
  );
  const internalLinks = await page.locator('a[href^="/"]').evaluateAll((anchors) =>
    [
      ...new Set(
        anchors
          .map((anchor) => (anchor as HTMLAnchorElement).getAttribute("href"))
          .filter((href): href is string => Boolean(href))
          .map((href) => href.split("#", 1)[0] || "/"),
      ),
    ].filter((href) => !href.startsWith("/api/")),
  );
  for (const link of internalLinks) {
    expect((await request.get(`${harness.origin}${link}`)).status(), link).toBe(200);
  }

  const robots = await request.get(`${harness.origin}/robots.txt`);
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toContain("Disallow: /api/");
  expect(await (await request.get(`${harness.origin}/robots.txt`)).text()).toContain(
    "Sitemap: https://skillplane.dev/sitemap.xml",
  );

  const sitemap = await request.get(`${harness.origin}/sitemap.xml`);
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const sitemapText = await sitemap.text();
  expect(sitemapText).toContain(
    `https://skillplane.dev/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}`,
  );
  expect(sitemapText).toContain(harness.secondPublicSkillSlug);
  expect(sitemapText).not.toContain(harness.privateSkillSlug);

  const hidden = await request.get(
    `${harness.origin}/skills/${harness.workspaceSlug}/${harness.privateSkillSlug}`,
  );
  expect(hidden.status()).toBe(404);
  expect(await hidden.text()).not.toContain("Private operational guidance");
});
