import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const utc = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const githubInstallations = pgTable(
  "github_installations",
  {
    installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    repositorySelection: text("repository_selection").notNull(),
    suspendedAt: utc("suspended_at"),
    removedAt: utc("removed_at"),
    boundBy: text("bound_by").notNull(),
    checkedAt: utc("checked_at").notNull().defaultNow(),
    createdAt: utc("created_at").notNull().defaultNow(),
    updatedAt: utc("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("github_installations_workspace_id_installation_id_key").on(
      t.workspaceId,
      t.installationId,
    ),
    check("github_installations_installation_id_check", sql`${t.installationId} > 0`),
    check(
      "github_installations_account_login_check",
      sql`char_length(${t.accountLogin}) BETWEEN 1 AND 100`,
    ),
    check(
      "github_installations_account_type_check",
      sql`${t.accountType} IN ('User', 'Organization', 'Enterprise')`,
    ),
    check(
      "github_installations_repository_selection_check",
      sql`${t.repositorySelection} IN ('all', 'selected')`,
    ),
  ],
);

export const githubInstallationStates = pgTable(
  "github_installation_states",
  {
    nonce: text("nonce").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    expiresAt: utc("expires_at").notNull(),
    consumedAt: utc("consumed_at").notNull().defaultNow(),
  },
  (t) => [
    index("github_installation_states_expiry_idx").on(t.workspaceId, t.expiresAt),
    check(
      "github_installation_states_nonce_check",
      sql`${t.nonce} ~ '^[A-Za-z0-9_-]{22,64}$'`,
    ),
  ],
);

export const githubInstallationSchema = {
  github_installations: githubInstallations,
  github_installation_states: githubInstallationStates,
};
