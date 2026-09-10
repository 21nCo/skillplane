import { authFnApiKeyPlugin } from "@authfn/api-keys";
import { authFnEmailOtpPlugin } from "@authfn/email-otp";
import { authFnMultiRegionPlugin } from "@authfn/multi-region";
import {
  createCoreTables,
  type AuthFnPlugin,
  type AuthFnSchemaDefinition,
  getSchema,
} from "authfn";
import type { Adapter } from "@superfunctions/db";

export interface AuthfnSchemaInput {
  readonly database: Adapter;
  readonly plugins?: readonly AuthFnPlugin[];
}

export function createAuthfnSchema(input: AuthfnSchemaInput): AuthFnSchemaDefinition {
  return getSchema({
    namespace: "authfn",
    plugins: [...(input.plugins ?? [])],
  });
}

export function assertAuthfnCoreSchemaContract(): void {
  const tables = createCoreTables();
  const actual = new Map(tables.map((table) => [table.modelName, table]));
  const expected = {
    users: [
      "createdAt",
      "emailVerifiedAt",
      "id",
      "metadata",
      "primaryEmail",
      "updatedAt",
    ],
    sessions: [
      "createdAt",
      "csrfHash",
      "expiresAt",
      "id",
      "lastAuthenticatedAt",
      "metadata",
      "methods",
      "revokedAt",
      "tokenHash",
      "updatedAt",
      "userId",
    ],
  } as const;

  for (const [model, fields] of Object.entries(expected)) {
    const table = actual.get(model);
    if (!table) {
      throw new Error(`AuthFn schema contract is missing table "${model}"`);
    }
    const actualFields = Object.keys(table.fields).sort();
    if (actualFields.join("\0") !== [...fields].sort().join("\0")) {
      throw new Error(
        `AuthFn schema contract drift for "${model}": ${actualFields.join(", ")}`,
      );
    }
  }
  if (actual.size !== Object.keys(expected).length) {
    throw new Error("AuthFn core introduced an unaccounted-for base table");
  }
}

export function assertAuthfnPluginSchemaContract(): void {
  const plugins = [
    authFnEmailOtpPlugin(),
    authFnApiKeyPlugin(),
    authFnMultiRegionPlugin(),
  ];
  const tables = plugins.flatMap(
    (plugin) =>
      plugin.schema?.({
        namespace: "authfn",
        plugins,
      }) ?? [],
  );
  const actual = new Map(tables.map((table) => [table.modelName, table]));
  const expected = {
    otp_challenges: [
      "attemptCount",
      "codeHash",
      "consumedAt",
      "createdAt",
      "deliveryMetadata",
      "email",
      "expiresAt",
      "id",
      "purpose",
      "updatedAt",
    ],
    api_keys: [
      "createdAt",
      "expiresAt",
      "id",
      "lastUsedAt",
      "metadata",
      "name",
      "revokedAt",
      "scopes",
      "secretHash",
      "updatedAt",
      "userId",
    ],
    region_profiles: [
      "authority",
      "createdAt",
      "domain",
      "id",
      "regionId",
      "updatedAt",
      "userId",
    ],
  } as const;

  for (const [model, fields] of Object.entries(expected)) {
    const table = actual.get(model);
    if (!table) {
      throw new Error(`AuthFn plugin schema contract is missing table "${model}"`);
    }
    const actualFields = Object.keys(table.fields).sort();
    if (actualFields.join("\0") !== [...fields].sort().join("\0")) {
      throw new Error(
        `AuthFn plugin schema contract drift for "${model}": ${actualFields.join(", ")}`,
      );
    }
  }
  if (actual.size !== Object.keys(expected).length) {
    throw new Error("AuthFn plugins introduced an unaccounted-for table");
  }
}
