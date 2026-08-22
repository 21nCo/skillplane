#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  developmentIssuer,
  developmentResource,
} from "./lib/development-deployment.mjs";
import { testLocalOAuth } from "./test-local-oauth.mjs";

export async function testDevelopmentOAuth() {
  return testLocalOAuth({
    issuer: developmentIssuer,
    resource: developmentResource,
  });
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await testDevelopmentOAuth(), null, 2)}\n`);
}
