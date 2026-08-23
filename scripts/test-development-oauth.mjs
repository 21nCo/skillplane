#!/usr/bin/env node

import {
  developmentIssuer,
  developmentResource,
} from "./lib/development-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";
import { testLocalOAuth } from "./test-local-oauth.mjs";

export async function testDevelopmentOAuth() {
  return testLocalOAuth({
    issuer: developmentIssuer,
    resource: developmentResource,
  });
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await testDevelopmentOAuth(), null, 2)}\n`);
}
