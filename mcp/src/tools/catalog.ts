import {
  McpToolError,
  type SkillsListInput,
  type SkillsListOutput,
  type WorkspaceCatalogItem,
  type WorkspacesListInput,
  type WorkspacesListOutput,
  type WorkspaceSelector,
} from "@skillplane/mcp-schema";
import {
  WORKSPACE_KINDS,
  isWorkspaceRole,
  type Principal,
  type WorkspaceKind,
} from "@skillplane/domain";
import { principalForWorkspace } from "../auth.js";
import { executeReadTool, type McpToolRuntime } from "./shared.js";

interface WorkspaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: string;
  readonly role: string;
  readonly updated_at: Date;
}

interface WorkspaceBoundary {
  readonly updatedAt: string;
  readonly id: string;
}

function workspaceBoundary(
  value: Readonly<Record<string, unknown>>,
): WorkspaceBoundary {
  if (
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.id !== "string" ||
    !value.id
  ) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return { updatedAt: value.updatedAt, id: value.id };
}

function catalogWorkspace(row: WorkspaceRow): WorkspaceCatalogItem {
  if (
    !(WORKSPACE_KINDS as readonly string[]).includes(row.kind) ||
    !isWorkspaceRole(row.role)
  ) {
    throw new McpToolError(
      "INTERNAL_ERROR",
      "The workspace catalog could not be completed",
      { status: 500, retryable: true },
    );
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as WorkspaceKind,
    role: row.role,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function listWorkspaceRows(
  runtime: McpToolRuntime,
  boundary: WorkspaceBoundary | null,
  limit: number,
): Promise<readonly WorkspaceRow[]> {
  if (runtime.identity.kind === "service") {
    const result = await runtime.services.database.pool.query<WorkspaceRow>(
      `SELECT workspace.id, workspace.slug, workspace.name, workspace.kind,
              $2::text AS role, workspace.updated_at
         FROM workspaces workspace
        WHERE workspace.id = $1
          AND (
            $3::timestamptz IS NULL
            OR workspace.updated_at < $3::timestamptz
            OR (workspace.updated_at = $3::timestamptz AND workspace.id > $4::text)
          )
        ORDER BY workspace.updated_at DESC, workspace.id ASC
        LIMIT $5`,
      [
        runtime.identity.workspaceId,
        runtime.identity.role,
        boundary?.updatedAt ?? null,
        boundary?.id ?? null,
        limit + 1,
      ],
    );
    return result.rows;
  }
  const result = await runtime.services.database.pool.query<WorkspaceRow>(
    `SELECT workspace.id, workspace.slug, workspace.name, workspace.kind,
            membership.role, workspace.updated_at
       FROM workspace_memberships membership
       JOIN workspaces workspace ON workspace.id = membership.workspace_id
      WHERE membership.user_id = $1
        AND (
          $2::timestamptz IS NULL
          OR workspace.updated_at < $2::timestamptz
          OR (workspace.updated_at = $2::timestamptz AND workspace.id > $3::text)
        )
      ORDER BY workspace.updated_at DESC, workspace.id ASC
      LIMIT $4`,
    [
      runtime.identity.userId,
      boundary?.updatedAt ?? null,
      boundary?.id ?? null,
      limit + 1,
    ],
  );
  return result.rows;
}

export function workspacesList(runtime: McpToolRuntime, input: WorkspacesListInput) {
  return executeReadTool(
    runtime,
    "workspaces_list",
    input.caller,
    async (execution) => {
      const filters = {
        actorId: runtime.identity.actorId,
        credentialId: runtime.identity.credentialId,
      };
      const boundary = input.cursor
        ? workspaceBoundary(
            await runtime.cursors.decode(input.cursor, "workspaces_list", filters),
          )
        : null;
      const rows = await listWorkspaceRows(runtime, boundary, input.limit);
      const hasNext = rows.length > input.limit;
      const workspaces = rows.slice(0, input.limit).map(catalogWorkspace);
      const pageBoundary = hasNext ? workspaces.at(-1) : undefined;
      const output: WorkspacesListOutput = {
        requestId: execution.requestId,
        workspaces,
        nextCursor: pageBoundary
          ? await runtime.cursors.encode("workspaces_list", filters, {
              updatedAt: pageBoundary.updatedAt,
              id: pageBoundary.id,
            })
          : null,
      };
      return {
        output,
        auditScopes: workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          resourceType: "workspace" as const,
          resourceId: workspace.id,
        })),
        allowEmptyAuditScopes: workspaces.length === 0,
      };
    },
  );
}

async function resolveWorkspace(
  runtime: McpToolRuntime,
  selector: WorkspaceSelector,
): Promise<WorkspaceRow> {
  const byId = "id" in selector;
  const result = await runtime.services.database.pool.query<WorkspaceRow>(
    `SELECT id, slug, name, kind, 'viewer'::text AS role, updated_at
       FROM workspaces
      WHERE ${byId ? "id = $1" : "slug = $1"}
      LIMIT 1`,
    [byId ? selector.id : selector.slug],
  );
  const workspace = result.rows[0];
  if (!workspace) throw new Error("WORKSPACE_FORBIDDEN");
  return workspace;
}

function requirePrincipal(principal: Principal | null): Principal {
  if (!principal) throw new Error("WORKSPACE_FORBIDDEN");
  return principal;
}

function domainCursor(value: Readonly<Record<string, unknown>>): string {
  if (typeof value.pageCursor !== "string" || !value.pageCursor) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return value.pageCursor;
}

export function skillsList(runtime: McpToolRuntime, input: SkillsListInput) {
  return executeReadTool(runtime, "skills_list", input.caller, async (execution) => {
    const workspace = await resolveWorkspace(runtime, input.workspace);
    execution.setScope({
      workspaceId: workspace.id,
      resourceType: "workspace",
      resourceId: workspace.id,
    });
    const principal = requirePrincipal(
      await principalForWorkspace(
        runtime.services,
        runtime.identity,
        workspace.id,
        "skills:read",
      ),
    );
    const filters = {
      workspaceId: workspace.id,
      state: input.state,
      visibility: [...input.visibility].sort(),
      actorId: runtime.identity.actorId,
      credentialId: runtime.identity.credentialId,
    };
    const cursor = input.cursor
      ? domainCursor(await runtime.cursors.decode(input.cursor, "skills_list", filters))
      : null;
    const page = await runtime.services.skillService.listPage({
      workspaceId: workspace.id,
      principal,
      archive: input.state,
      visibility: input.visibility,
      cursor,
      limit: input.limit,
    });
    const workspaceKind = catalogWorkspace(workspace).kind;
    const skills: SkillsListOutput["skills"] = page.skills.map((skill) => {
      if (
        (skill.currentPublishedVersionId === null) !==
        (skill.currentSemanticVersion === null)
      ) {
        throw new McpToolError(
          "INTERNAL_ERROR",
          "The skill catalog could not be completed",
          { status: 500, retryable: true },
        );
      }
      return {
        id: skill.id,
        workspaceId: skill.workspaceId,
        workspaceSlug: workspace.slug,
        slug: skill.slug,
        name: skill.name,
        summary: skill.description,
        tags: [...skill.tags],
        visibility: skill.visibility,
        currentVersion:
          skill.currentPublishedVersionId && skill.currentSemanticVersion
            ? {
                id: skill.currentPublishedVersionId,
                semanticVersion: skill.currentSemanticVersion,
              }
            : null,
        archivedAt: skill.archivedAt,
        updatedAt: skill.updatedAt,
      };
    });
    const output: SkillsListOutput = {
      requestId: execution.requestId,
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        kind: workspaceKind,
      },
      skills,
      nextCursor: page.nextCursor
        ? await runtime.cursors.encode("skills_list", filters, {
            pageCursor: page.nextCursor,
          })
        : null,
    };
    return { output };
  });
}
