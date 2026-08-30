#!/usr/bin/env node

import {
  developmentDatabase,
  developmentIssuer,
  developmentResource,
} from "./lib/development-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";
import { testLocalOAuth } from "./test-local-oauth.mjs";

export async function testDevelopmentOAuth() {
  const workspaceSlugs = (process.env.SKILLPLANE_OAUTH_WORKSPACE_SLUGS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return testLocalOAuth({
    databaseUrl: developmentDatabase().url,
    issuer: developmentIssuer,
    resource: developmentResource,
    workspaceSlugs,
    ...(process.env.SKILLPLANE_OAUTH_NO_BROWSER === "1"
      ? { openBrowser: () => undefined }
      : {}),
  });
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await testDevelopmentOAuth(), null, 2)}\n`);
}
