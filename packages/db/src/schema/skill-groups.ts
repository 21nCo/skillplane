import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
  uniqueIndex,
  foreignKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { skills } from "./domain.js";
const utc = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const skillGroups = pgTable(
  "skill_groups",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    creationHash: text("creation_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    archivedAt: utc("archived_at"),
    createdAt: utc("created_at").notNull().defaultNow(),
    updatedAt: utc("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_groups_workspace_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("skill_groups_workspace_name_unique").on(
      t.workspaceId,
      sql`lower(${t.name})`,
    ),
    check("skill_groups_name_check", sql`length(${t.name}) BETWEEN 1 AND 120`),
    check("skill_groups_description_check", sql`length(${t.description}) <= 2000`),
    check("skill_groups_revision_check", sql`${t.revision} > 0`),
  ],
);
export const skillGroupSkills = pgTable(
  "skill_group_skills",
  {
    workspaceId: text("workspace_id").notNull(),
    groupId: text("group_id").notNull(),
    skillId: text("skill_id").notNull(),
    createdAt: utc("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.skillId] }),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [skillGroups.workspaceId, skillGroups.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.skillId],
      foreignColumns: [skills.workspaceId, skills.id],
    }),
    index("skill_group_skills_skill_idx").on(t.workspaceId, t.skillId, t.groupId),
  ],
);
export const skillGroupMembers = pgTable(
  "skill_group_members",
  {
    workspaceId: text("workspace_id").notNull(),
    groupId: text("group_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: utc("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [skillGroups.workspaceId, skillGroups.id],
    }),
    index("skill_group_members_user_idx").on(t.workspaceId, t.userId, t.groupId),
  ],
);
export const skillGroupSchema = {
  skill_groups: skillGroups,
  skill_group_skills: skillGroupSkills,
  skill_group_members: skillGroupMembers,
};
