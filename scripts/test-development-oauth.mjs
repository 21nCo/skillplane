#!/usr/bin/env node

import {
  developmentIssuer,
  developmentResource,
} from "./lib/development-deployment.mjs";
import { developmentTopologyDatabases } from "./lib/development-topology-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";
import { testLocalOAuth } from "./test-local-oauth.mjs";

export function developmentOAuthConfiguration(options = {}) {
  const workspaceSlugs =
    options.workspaceSlugs ??
    (process.env.SKILLPLANE_OAUTH_WORKSPACE_SLUGS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const databases = options.databases ?? developmentTopologyDatabases();
  return {
    databaseUrl: databases.control.url,
    issuer: developmentIssuer,
    resource: developmentResource,
    workspaceSlugs,
    ...(process.env.SKILLPLANE_OAUTH_NO_BROWSER === "1"
      ? { openBrowser: () => undefined }
      : {}),
  };
}

export async function testDevelopmentOAuth(options = {}) {
  const verify = options.verify ?? testLocalOAuth;
  return verify(developmentOAuthConfiguration(options));
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await testDevelopmentOAuth(), null, 2)}\n`);
}
