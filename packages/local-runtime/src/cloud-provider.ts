import type { UsageEvent } from "./analytics.js";
import { requireValue } from "./contracts.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { canonicalizeBundleFiles, skillJsonSchema } from "@skillplane/storage";
import {
  skillRetrieveOutputSchema,
  skillAssetRetrieveOutputSchema,
  skillsListOutputSchema,
  skillVersionsListOutputSchema,
  skillCreateOutputSchema,
  skillAmendOutputSchema,
  skillCandidatesListOutputSchema,
  skillUsageReportOutputSchema,
  type CallerDeclaration,
} from "@skillplane/mcp-schema";
import {
  workspaceKey,
  declaredCaller,
  RuntimeError,
  type WorkspaceProvider,
  type WorkspaceRef,
  type SkillInfo,
  type VersionInfo,
  type Snapshot,
  type CreateRequest,
  type AmendRequest,
} from "./contracts.js";
import { type Profiles } from "./profiles.js";
import { hash } from "./files.js";
export interface CloudTransport {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  download(url: string, max: number): Promise<Uint8Array>;
}
export class McpTransport implements CloudTransport {
  constructor(
    readonly endpoint: string,
    readonly token: () => Promise<string>,
  ) {}
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = new Client({ name: "skillplane-cli", version: "0.1.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.endpoint), {
          requestInit: {
            headers: { Authorization: `Bearer ${await this.token()}` },
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          },
        }) as unknown as Transport,
      );
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 15000,
      });
      if (result.isError)
        throw new RuntimeError(
          "CLOUD_REQUEST_REJECTED",
          JSON.stringify(result.structuredContent ?? result.content),
        );
      if (result.structuredContent) return result.structuredContent;
      const content = result.content as {
        type: string;
        text?: string;
      }[];
      const text = content.find((c) => c.type === "text")?.text;
      if (!text) throw new RuntimeError("CLOUD_RESPONSE_INVALID");
      return JSON.parse(text) as unknown;
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError(
        "CLOUD_UNAVAILABLE",
        "Cloud connection failed or credentials expired",
      );
    } finally {
      await client.close();
    }
  }
  async download(url: string, max: number): Promise<Uint8Array> {
    if (new URL(url).origin !== new URL(this.endpoint).origin)
      throw new RuntimeError("DOWNLOAD_ORIGIN_INVALID");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${await this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body) throw new RuntimeError("CLOUD_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) throw new RuntimeError("ASSET_TOO_LARGE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
}
export class CloudWorkspaceProvider implements WorkspaceProvider {
  constructor(
    readonly workspace: Extract<
      WorkspaceRef,
      {
        provider: "cloud";
      }
    >,
    readonly transport: CloudTransport,
    readonly caller: CallerDeclaration = declaredCaller(),
  ) {}
  static fromProfiles(
    workspace: Extract<
      WorkspaceRef,
      {
        provider: "cloud";
      }
    >,
    profiles: Profiles,
    caller = declaredCaller(),
  ): CloudWorkspaceProvider {
    const profile = profiles.get(workspace.profile, workspace.endpoint);
    return new CloudWorkspaceProvider(
      workspace,
      new McpTransport(workspace.endpoint, () =>
        profiles.secrets.get(profile.credentialRef),
      ),
      caller,
    );
  }
  private call(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.transport.call(name, { ...args, caller: this.caller });
  }
  async list(): Promise<SkillInfo[]> {
    const items: SkillInfo[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = skillsListOutputSchema.parse(
        await this.call("skills_list", {
          workspace: { id: this.workspace.id },
          limit: 100,
          cursor,
        }),
      );
      if (
        page.workspace.id !== this.workspace.id ||
        page.skills.some((s) => s.workspaceId !== this.workspace.id)
      )
        throw new RuntimeError("WORKSPACE_MISMATCH");
      items.push(
        ...page.skills.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.summary,
        })),
      );
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new RuntimeError("PAGINATION_INVALID");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async versions(skillId: string): Promise<VersionInfo[]> {
    // Check membership in this exact workspace before ID-only MCP operations.
    if (!(await this.list()).some((s) => s.id === skillId))
      throw new RuntimeError("SKILL_NOT_FOUND");
    const items: VersionInfo[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = skillVersionsListOutputSchema.parse(
        await this.call("skill_versions_list", {
          skill: { id: skillId },
          limit: 100,
          cursor,
        }),
      );
      if (page.skillId !== skillId) throw new RuntimeError("SKILL_MISMATCH");
      items.push(...page.versions);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new RuntimeError("PAGINATION_INVALID");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async retrieve(skillId: string, versionId?: string): Promise<Snapshot> {
    const output = skillRetrieveOutputSchema.parse(
      await this.call("skill_retrieve", {
        skill: { id: skillId },
        version: versionId
          ? { selector: "versionId", versionId }
          : { selector: "current" },
      }),
    );
    if (
      output.skill.workspaceId !== this.workspace.id ||
      output.skill.id !== skillId ||
      (versionId && output.version.id !== versionId)
    )
      throw new RuntimeError("WORKSPACE_MISMATCH");
    const files = new Map<string, Uint8Array>([
      ["SKILL.md", Buffer.from(output.instructions)],
    ]);
    for (const descriptor of output.files) {
      if (descriptor.path === "SKILL.md") continue;
      const asset = skillAssetRetrieveOutputSchema.parse(
        await this.call("skill_asset_retrieve", {
          skill: { id: skillId },
          version: { selector: "versionId", versionId: output.version.id },
          path: descriptor.path,
        }),
      );
      if (
        asset.skillId !== skillId ||
        asset.versionId !== output.version.id ||
        asset.path !== descriptor.path ||
        asset.bundleDigest !== output.version.digest
      )
        throw new RuntimeError("ASSET_IDENTITY_MISMATCH");
      const bytes =
        asset.delivery === "text"
          ? Buffer.from(requireValue(asset.text))
          : asset.delivery === "base64"
            ? Buffer.from(requireValue(asset.base64), "base64")
            : await this.transport.download(
                requireValue(asset.url),
                Math.min(descriptor.byteSize, 5 * 1024 * 1024),
              );
      if (hash(bytes) !== descriptor.sha256 || bytes.length !== descriptor.byteSize)
        throw new RuntimeError("DIGEST_MISMATCH");
      files.set(descriptor.path, bytes);
    }
    const immutableSkill = skillJsonSchema.parse(
      JSON.parse(new TextDecoder().decode(files.get("skill.json"))),
    );
    const bundle = await canonicalizeBundleFiles({ skill: immutableSkill, files });
    if (bundle.digest !== output.version.digest)
      throw new RuntimeError("DIGEST_MISMATCH");
    return {
      workspace: this.workspace,
      skill: output.skill,
      version: output.version,
      bundle,
    };
  }
  async reportUsage(event: UsageEvent): Promise<string> {
    if (
      event.workspace !== workspaceKey(this.workspace) ||
      event.type === "skill_success_verified"
    )
      throw new RuntimeError("USAGE_SCOPE_INVALID");
    if (!(await this.list()).some((skill) => skill.id === event.skillId))
      throw new RuntimeError("SKILL_NOT_FOUND");
    const {
      id,
      timestamp,
      type,
      installationId,
      agent,
      model,
      sessionId,
      delivery,
      freshness,
    } = event;
    const output = skillUsageReportOutputSchema.parse(
      await this.call("skill_usage_report", {
        skill: { id: event.skillId },
        versionId: event.versionId,
        event: {
          id,
          timestamp,
          type,
          installationId,
          agent,
          model,
          sessionId,
          delivery,
          freshness,
        },
      }),
    );
    if (output.acceptedId !== id) throw new RuntimeError("ANALYTICS_ACK_INVALID");
    return id;
  }
  async create(request: CreateRequest): Promise<{
    skillId: string;
    versionId: string;
  }> {
    const output = skillCreateOutputSchema.parse(
      await this.call("skill_create", {
        ...request,
        workspace: { id: this.workspace.id },
      }),
    );
    if (output.skill.workspaceId !== this.workspace.id)
      throw new RuntimeError("WORKSPACE_MISMATCH");
    return { skillId: output.skill.id, versionId: output.version.id };
  }
  async amend(request: AmendRequest): Promise<{
    skillId: string;
    versionId: string;
  }> {
    await this.retrieve(request.skillId, request.baseVersionId);
    const output = skillAmendOutputSchema.parse(
      await this.call("skill_amend", request),
    );
    if (
      output.skillId !== request.skillId ||
      output.baseVersionId !== request.baseVersionId
    )
      throw new RuntimeError("SKILL_MISMATCH");
    return { skillId: output.skillId, versionId: output.candidate.id };
  }
  async candidates(skillId: string): Promise<unknown> {
    if (!(await this.list()).some((s) => s.id === skillId))
      throw new RuntimeError("SKILL_NOT_FOUND");
    let cursor: string | null = null;
    const items = [];
    const seen = new Set<string>();
    do {
      const page = skillCandidatesListOutputSchema.parse(
        await this.call("skill_candidates_list", {
          skill: { id: skillId },
          limit: 100,
          cursor,
        }),
      );
      items.push(...page.candidates);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new RuntimeError("PAGINATION_INVALID");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async decide(
    skillId: string,
    reviewId: string,
    expectedUpdatedAt: string,
    approve: boolean,
    reason: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (!(await this.list()).some((s) => s.id === skillId))
      throw new RuntimeError("SKILL_NOT_FOUND");
    return this.call(approve ? "skill_candidate_approve" : "skill_candidate_reject", {
      skill: { id: skillId },
      reviewId,
      expectedUpdatedAt,
      reason,
      idempotencyKey,
    });
  }
}
