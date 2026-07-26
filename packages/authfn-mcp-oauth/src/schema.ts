import type { TableSchema } from "@superfunctions/db";

const date = {
  type: "datetime",
  dateValueType: "date",
  dateStorageType: "timestamptz",
} as const;

export function createOAuthSchema(): TableSchema[] {
  return [
    {
      modelName: "oauth_clients",
      fields: {
        clientId: { type: "string", required: true, fieldName: "client_id" },
        clientName: { type: "string", required: true, fieldName: "client_name" },
        source: { type: "string", required: true, fieldName: "source" },
        tokenEndpointAuthMethod: {
          type: "string",
          required: true,
          fieldName: "token_endpoint_auth_method",
        },
        registrationAccessTokenHash: {
          type: "string",
          fieldName: "registration_access_token_hash",
        },
        createdAt: { ...date, required: true, fieldName: "created_at" },
        updatedAt: { ...date, required: true, fieldName: "updated_at" },
      },
      indexes: [
        {
          name: "authfn_oauth_clients_client_id_idx",
          fields: ["clientId"],
          unique: true,
        },
      ],
    },
    {
      modelName: "oauth_client_redirect_uris",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        clientId: { type: "string", required: true, fieldName: "client_id" },
        redirectUri: { type: "string", required: true, fieldName: "redirect_uri" },
      },
      indexes: [
        {
          name: "authfn_oauth_client_redirect_unique",
          fields: ["clientId", "redirectUri"],
          unique: true,
        },
      ],
    },
    {
      modelName: "oauth_consents",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        userId: { type: "string", required: true, fieldName: "user_id" },
        clientId: { type: "string", required: true, fieldName: "client_id" },
        resource: { type: "string", required: true, fieldName: "resource" },
        scopes: { type: "json", required: true, fieldName: "scopes" },
        grantedAt: { ...date, required: true, fieldName: "granted_at" },
        revokedAt: { ...date, fieldName: "revoked_at" },
      },
    },
    {
      modelName: "oauth_authorization_requests",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        requestHash: { type: "string", required: true, fieldName: "request_hash" },
        payload: { type: "json", required: true, fieldName: "payload" },
        userId: { type: "string", fieldName: "user_id" },
        expiresAt: { ...date, required: true, fieldName: "expires_at" },
        consumedAt: { ...date, fieldName: "consumed_at" },
        createdAt: { ...date, required: true, fieldName: "created_at" },
      },
      indexes: [
        {
          name: "authfn_oauth_authorization_requests_hash_idx",
          fields: ["requestHash"],
          unique: true,
        },
      ],
    },
    {
      modelName: "oauth_authorization_codes",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        codeHash: { type: "string", required: true, fieldName: "code_hash" },
        userId: { type: "string", required: true, fieldName: "user_id" },
        clientId: { type: "string", required: true, fieldName: "client_id" },
        redirectUri: { type: "string", required: true, fieldName: "redirect_uri" },
        resource: { type: "string", required: true, fieldName: "resource" },
        scopes: { type: "json", required: true, fieldName: "scopes" },
        codeChallenge: { type: "string", required: true, fieldName: "code_challenge" },
        expiresAt: { ...date, required: true, fieldName: "expires_at" },
        consumedAt: { ...date, fieldName: "consumed_at" },
        createdAt: { ...date, required: true, fieldName: "created_at" },
      },
      indexes: [
        {
          name: "authfn_oauth_authorization_codes_hash_idx",
          fields: ["codeHash"],
          unique: true,
        },
      ],
    },
    {
      modelName: "oauth_access_tokens",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        tokenHash: { type: "string", required: true, fieldName: "token_hash" },
        familyId: { type: "string", required: true, fieldName: "family_id" },
        userId: { type: "string", required: true, fieldName: "user_id" },
        clientId: { type: "string", required: true, fieldName: "client_id" },
        resource: { type: "string", required: true, fieldName: "resource" },
        scopes: { type: "json", required: true, fieldName: "scopes" },
        expiresAt: { ...date, required: true, fieldName: "expires_at" },
        revokedAt: { ...date, fieldName: "revoked_at" },
        createdAt: { ...date, required: true, fieldName: "created_at" },
      },
      indexes: [
        {
          name: "authfn_oauth_access_tokens_hash_idx",
          fields: ["tokenHash"],
          unique: true,
        },
      ],
    },
    {
      modelName: "oauth_refresh_tokens",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        tokenHash: { type: "string", required: true, fieldName: "token_hash" },
        familyId: { type: "string", required: true, fieldName: "family_id" },
        parentId: { type: "string", fieldName: "parent_id" },
        userId: { type: "string", required: true, fieldName: "user_id" },
        clientId: { type: "string", required: true, fieldName: "client_id" },
        resource: { type: "string", required: true, fieldName: "resource" },
        scopes: { type: "json", required: true, fieldName: "scopes" },
        expiresAt: { ...date, required: true, fieldName: "expires_at" },
        consumedAt: { ...date, fieldName: "consumed_at" },
        revokedAt: { ...date, fieldName: "revoked_at" },
        createdAt: { ...date, required: true, fieldName: "created_at" },
      },
      indexes: [
        {
          name: "authfn_oauth_refresh_tokens_hash_idx",
          fields: ["tokenHash"],
          unique: true,
        },
      ],
    },
  ];
}
