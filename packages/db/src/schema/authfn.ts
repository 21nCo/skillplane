import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const authfnUsers = pgTable(
  "authfn_users",
  {
    id: text("id").primaryKey(),
    primaryEmail: text("primary_email"),
    emailVerifiedAt: utcTimestamp("email_verified_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [uniqueIndex("idx_authfn_users_primary_email").on(table.primaryEmail)],
);

export const authfnSessions = pgTable(
  "authfn_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authfnUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfHash: text("csrf_hash"),
    methods: jsonb("methods").$type<string[]>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    revokedAt: utcTimestamp("revoked_at"),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
    lastAuthenticatedAt: utcTimestamp("last_authenticated_at"),
  },
  (table) => [
    index("idx_authfn_sessions_expires_at").on(table.expiresAt),
    uniqueIndex("idx_authfn_sessions_token_hash").on(table.tokenHash),
    index("idx_authfn_sessions_user_id_created_at").on(table.userId, table.createdAt),
  ],
);

export const authfnOtpChallenges = pgTable(
  "authfn_otp_challenges",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    deliveryMetadata: jsonb("delivery_metadata").$type<Record<string, unknown>>(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    consumedAt: utcTimestamp("consumed_at"),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    index("idx_authfn_otp_challenges_email_purpose_created_at").on(
      table.email,
      table.purpose,
      table.createdAt,
    ),
    index("idx_authfn_otp_challenges_expires_at").on(table.expiresAt),
    check(
      "authfn_otp_challenges_purpose",
      sql`${table.purpose} IN ('verify-email', 'sign-in', 'sign-up', 'reset-password')`,
    ),
    check(
      "authfn_otp_challenges_email_normalized",
      sql`${table.email} = lower(${table.email})`,
    ),
    check("authfn_otp_challenges_code_hash", sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check("authfn_otp_challenges_attempt_count", sql`${table.attemptCount} >= 0`),
    check(
      "authfn_otp_challenges_delivery_metadata_object",
      sql`${table.deliveryMetadata} IS NULL OR jsonb_typeof(${table.deliveryMetadata}) = 'object'`,
    ),
  ],
);

export const authfnApiKeys = pgTable(
  "authfn_api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => authfnUsers.id, {
      onDelete: "cascade",
    }),
    name: text("name"),
    secretHash: text("secret_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    expiresAt: utcTimestamp("expires_at"),
    revokedAt: utcTimestamp("revoked_at"),
    lastUsedAt: utcTimestamp("last_used_at"),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_authfn_api_keys_secret_hash").on(table.secretHash),
    index("idx_authfn_api_keys_user_id_created_at").on(table.userId, table.createdAt),
    check("authfn_api_keys_secret_hash", sql`${table.secretHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "authfn_api_keys_scopes_array",
      sql`${table.scopes} IS NULL OR jsonb_typeof(${table.scopes}) = 'array'`,
    ),
    check(
      "authfn_api_keys_metadata_object",
      sql`${table.metadata} IS NULL OR jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  ],
);

export const authfnRegionProfiles = pgTable(
  "authfn_region_profiles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => authfnUsers.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    authority: text("authority").notNull(),
    domain: text("domain"),
    createdAt: utcTimestamp("created_at").notNull(),
    updatedAt: utcTimestamp("updated_at").notNull(),
  },
  (table) => [
    index("idx_authfn_region_profiles_region_id").on(table.regionId),
    uniqueIndex("idx_authfn_region_profiles_user_id").on(table.userId),
  ],
);

export const authfnSchema = {
  authfn_users: authfnUsers,
  authfn_sessions: authfnSessions,
  authfn_otp_challenges: authfnOtpChallenges,
  authfn_api_keys: authfnApiKeys,
  authfn_region_profiles: authfnRegionProfiles,
};
