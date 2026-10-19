import type { Pool, PoolClient } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import type { Principal } from "./principal.js";
import { insertPrincipalAudit } from "./mutation-audit.js";
import { withDomainTransaction } from "./transactions.js";
import { hashIdempotentRequest, validateIdempotencyKey } from "./idempotency.js";

export interface SkillGroup {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
interface GroupRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  creation_hash: string;
  revision: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
function record(row: GroupRow): SkillGroup {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export function groupMetadata(name: unknown, description: unknown = "") {
  if (typeof name !== "string" || typeof description !== "string")
    throw new DomainError(
      "VALIDATION_FAILED",
      "Group name and description must be text",
      400,
    );
  const normalized = name.trim().replace(/\s+/gu, " ").normalize("NFC");
  if (!normalized || normalized.length > 120 || description.length > 2000)
    throw new DomainError(
      "VALIDATION_FAILED",
      "Use a group name of 1–120 characters and description up to 2000 characters",
      400,
    );
  return { name: normalized, description: description.trim() };
}
export function groupPage(limit: unknown = 50, cursor: unknown = null) {
  const n = Number(limit);
  if (
    !Number.isInteger(n) ||
    n < 1 ||
    n > 100 ||
    (cursor !== null && (typeof cursor !== "string" || cursor.length > 200))
  )
    throw new DomainError("VALIDATION_FAILED", "Invalid group page", 400);
  return { limit: n, cursor };
}
function writePermission(principal: Principal) {
  authorize(principal, "workspace:update");
}
interface Mutation {
  principal: Principal;
  requestId: string;
  fencingEpoch?: number;
}
export class SkillGroupService {
  constructor(
    private readonly pool: Pool,
    private readonly controlPool: Pool = pool,
  ) {}
  async list(
    principal: Principal,
    options: {
      archived?: boolean;
      limit?: number;
      cursor?: string | null;
      skillId?: string;
      userId?: string;
    } = {},
  ) {
    authorize(principal, "skills:read");
    // Filtering by member reveals that member's groups, so it needs member access.
    if (options.userId !== undefined) authorize(principal, "members:read");
    const page = groupPage(options.limit ?? 50, options.cursor ?? null);
    const result = await this.pool.query<GroupRow>(
      `SELECT g.* FROM skill_groups g WHERE g.workspace_id=$1 AND ($2::boolean OR g.archived_at IS NULL) AND ($3::text IS NULL OR g.id>$3) AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM skill_group_skills a WHERE a.workspace_id=g.workspace_id AND a.group_id=g.id AND a.skill_id=$5)) AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM skill_group_members a WHERE a.workspace_id=g.workspace_id AND a.group_id=g.id AND a.user_id=$6)) ORDER BY g.id LIMIT $4`,
      [
        principal.workspaceId,
        options.archived ?? false,
        page.cursor,
        page.limit + 1,
        options.skillId ?? null,
        options.userId ?? null,
      ],
    );
    return {
      groups: result.rows.slice(0, page.limit).map(record),
      nextCursor:
        result.rows.length > page.limit
          ? (result.rows[page.limit - 1]?.id ?? null)
          : null,
    };
  }
  // Active groups of up to one page of skills in one query, for catalog badges.
  async skillGroups(principal: Principal, skillIds: readonly string[]) {
    authorize(principal, "skills:read");
    const ids = [...new Set(skillIds)];
    if (ids.length > 100 || ids.some((id) => !id || id.length > 200))
      throw new DomainError(
        "VALIDATION_FAILED",
        "Request groups for 1–100 skill identifiers",
        400,
      );
    const r = ids.length
      ? await this.pool.query<{ skill_id: string; id: string; name: string }>(
          "SELECT a.skill_id,g.id,g.name FROM skill_group_skills a JOIN skill_groups g ON g.workspace_id=a.workspace_id AND g.id=a.group_id WHERE a.workspace_id=$1 AND a.skill_id=ANY($2::text[]) AND g.archived_at IS NULL ORDER BY a.skill_id,lower(g.name),g.id",
          [principal.workspaceId, ids],
        )
      : { rows: [] };
    return {
      skills: ids.map((skillId) => ({
        skillId,
        groups: r.rows
          .filter((row) => row.skill_id === skillId)
          .map((row) => ({ id: row.id, name: row.name })),
      })),
    };
  }
  async get(principal: Principal, groupId: string) {
    authorize(principal, "skills:read");
    const r = await this.pool.query<GroupRow>(
      "SELECT * FROM skill_groups WHERE workspace_id=$1 AND id=$2",
      [principal.workspaceId, groupId],
    );
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", "Group was not found", 404);
    return record(r.rows[0]);
  }
  async create(
    options: Mutation & {
      name: unknown;
      description?: unknown;
      idempotencyKey: string;
    },
  ) {
    writePermission(options.principal);
    const data = groupMetadata(options.name, options.description);
    const key = validateIdempotencyKey(options.idempotencyKey);
    const creationHash = await hashIdempotentRequest(data);
    const id = `group:${await hashIdempotentRequest({ workspaceId: options.principal.workspaceId, actor: options.principal.actorId, key })}`;
    return this.mutate(options, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [id]);
      const existing = await client.query<GroupRow>(
        "SELECT * FROM skill_groups WHERE workspace_id=$1 AND id=$2",
        [options.principal.workspaceId, id],
      );
      if (existing.rows[0]) {
        const g = record(existing.rows[0]);
        if (existing.rows[0].creation_hash !== creationHash)
          throw new DomainError(
            "IDEMPOTENCY_KEY_REUSED",
            "The creation key was already used",
            409,
          );
        return g;
      }
      const r = await client.query<GroupRow>(
        "INSERT INTO skill_groups(id,workspace_id,name,description,creation_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING *",
        [id, options.principal.workspaceId, data.name, data.description, creationHash],
      );
      if (!r.rows[0]) {
        const error = Object.assign(new Error("Concurrent group creation"), {
          code: "40001",
        });
        throw error;
      }
      await this.audit(client, options, id, "created", {});
      return record(r.rows[0]);
    });
  }
  async update(
    options: Mutation & {
      groupId: string;
      expectedRevision: number;
      name?: unknown;
      description?: unknown;
      archived: boolean;
    },
  ) {
    writePermission(options.principal);
    if (
      !Number.isSafeInteger(options.expectedRevision) ||
      options.expectedRevision < 1 ||
      typeof options.archived !== "boolean"
    )
      throw new DomainError(
        "VALIDATION_FAILED",
        "A revision and archived state are required",
        400,
      );
    return this.mutate(options, async (client) => {
      const current = await this.lock(client, options.principal, options.groupId);
      if (current.revision !== options.expectedRevision)
        throw new DomainError("CONFLICT", "Group changed; reload before saving", 409);
      // An omitted field keeps its stored value, while null is invalid metadata; a
      // request that changes nothing returns the current group without a new
      // revision or audit record.
      const data = groupMetadata(
        options.name === undefined ? current.name : options.name,
        options.description === undefined ? current.description : options.description,
      );
      const changes = [
        ...(data.name !== current.name ? ["name"] : []),
        ...(data.description !== current.description ? ["description"] : []),
        ...(options.archived !== Boolean(current.archived_at) ? ["archived"] : []),
      ];
      if (!changes.length) return record(current);
      const r = await client.query<GroupRow>(
        "UPDATE skill_groups SET name=$3,description=$4,archived_at=CASE WHEN $5::boolean THEN COALESCE(archived_at,now()) ELSE NULL END,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [
          options.principal.workspaceId,
          options.groupId,
          data.name,
          data.description,
          options.archived,
        ],
      );
      const updated = r.rows[0];
      if (!updated) throw new DomainError("NOT_FOUND", "Group was not found", 404);
      await this.audit(client, options, options.groupId, "updated", {
        archived: options.archived,
        changes,
      });
      return record(updated);
    });
  }
  async association(
    options: Mutation & {
      groupId: string;
      kind: "skill" | "member";
      targetId: string;
      add: boolean;
    },
  ) {
    writePermission(options.principal);
    if (!options.targetId || options.targetId.length > 200)
      throw new DomainError("VALIDATION_FAILED", "A target is required", 400);
    if (options.kind === "member" && options.add) {
      const member = await this.controlPool.query(
        "SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",
        [options.principal.workspaceId, options.targetId],
      );
      if (!member.rowCount)
        throw new DomainError("NOT_FOUND", "Workspace member was not found", 404);
    }
    return this.mutate(options, async (client) => {
      const group = await this.lock(client, options.principal, options.groupId);
      if (group.archived_at)
        throw new DomainError(
          "CONFLICT",
          "Restore the group before changing assignments",
          409,
        );
      if (options.kind === "skill") {
        const r = await client.query<{ kind: string }>(
          "SELECT kind FROM skills WHERE workspace_id=$1 AND id=$2 FOR SHARE",
          [options.principal.workspaceId, options.targetId],
        );
        if (!r.rowCount)
          throw new DomainError("NOT_FOUND", "Workspace skill was not found", 404);
        // Groups hold skills; instructions documents are a separate kind.
        if (options.add && r.rows[0]?.kind !== "skill")
          throw new DomainError(
            "VALIDATION_FAILED",
            "Only skills can be assigned to a skill group",
            400,
            { field: "targetId" },
          );
      }
      const table =
          options.kind === "skill" ? "skill_group_skills" : "skill_group_members",
        column = options.kind === "skill" ? "skill_id" : "user_id";
      const r = await client.query(
        options.add
          ? `INSERT INTO ${table}(workspace_id,group_id,${column}) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING group_id`
          : `DELETE FROM ${table} WHERE workspace_id=$1 AND group_id=$2 AND ${column}=$3 RETURNING group_id`,
        [options.principal.workspaceId, options.groupId, options.targetId],
      );
      if (r.rowCount)
        await this.audit(
          client,
          options,
          options.groupId,
          `${options.kind}.${options.add ? "added" : "removed"}`,
          { targetId: options.targetId },
        );
      return { changed: Boolean(r.rowCount) };
    });
  }
  async skills(
    principal: Principal,
    groupId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ) {
    await this.get(principal, groupId);
    const page = groupPage(options.limit ?? 20, options.cursor ?? null);
    const r = await this.pool.query<{
      id: string;
      name: string;
      slug: string;
      archived_at: Date | null;
    }>(
      "SELECT s.id,s.name,s.slug,s.archived_at FROM skill_group_skills a JOIN skills s ON s.id=a.skill_id AND s.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.group_id=$2 AND ($3::text IS NULL OR s.id>$3) ORDER BY s.id LIMIT $4",
      [principal.workspaceId, groupId, page.cursor, page.limit + 1],
    );
    return {
      skills: r.rows.slice(0, page.limit).map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        archivedAt: s.archived_at?.toISOString() ?? null,
      })),
      nextCursor:
        r.rows.length > page.limit ? (r.rows[page.limit - 1]?.id ?? null) : null,
    };
  }
  async members(
    principal: Principal,
    groupId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ) {
    authorize(principal, "members:read");
    await this.get(principal, groupId);
    const page = groupPage(options.limit ?? 50, options.cursor ?? null);
    const r = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM skill_group_members WHERE workspace_id=$1 AND group_id=$2 AND ($3::text IS NULL OR user_id>$3) ORDER BY user_id LIMIT $4",
      [principal.workspaceId, groupId, page.cursor, page.limit + 1],
    );
    const ids = r.rows.slice(0, page.limit).map((i) => i.user_id);
    const active = await this.controlPool.query<{
      user_id: string;
      role: string;
      display_name: string | null;
      email: string | null;
    }>(
      "SELECT m.user_id,m.role,u.metadata->>'displayName' AS display_name,u.primary_email AS email FROM workspace_memberships m JOIN authfn_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=ANY($2::text[]) ORDER BY m.user_id",
      [principal.workspaceId, ids],
    );
    return {
      members: ids.map((userId) => {
        const i = active.rows.find((row) => row.user_id === userId);
        return {
          userId,
          role: i?.role ?? "removed",
          displayName: i?.display_name ?? null,
          email: i?.email ?? null,
        };
      }),
      nextCursor: r.rows.length > page.limit ? (ids.at(-1) ?? null) : null,
    };
  }
  private async lock(client: PoolClient, principal: Principal, id: string) {
    const r = await client.query<GroupRow>(
      "SELECT * FROM skill_groups WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [principal.workspaceId, id],
    );
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", "Group was not found", 404);
    return r.rows[0];
  }
  private async audit(
    client: PoolClient,
    options: Mutation,
    id: string,
    event: string,
    metadata: Record<string, unknown>,
  ) {
    await insertPrincipalAudit(client, options.principal, {
      eventType: `skill_group.${event}`,
      action: "workspace:update",
      requestId: options.requestId,
      resourceType: "skill_group",
      resourceId: id,
      metadata,
    });
  }
  private async mutate<T>(
    options: Mutation,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDomainTransaction(
        this.pool,
        options.requestId,
        ({ client }) => operation(client),
        { fencingEpoch: options.fencingEpoch },
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        throw new DomainError("CONFLICT", "A group with that name already exists", 409);
      throw error;
    }
  }
}
