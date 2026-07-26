import type { SkillRetrieveInput, SkillRetrieveOutput } from "@skillplane/mcp-schema";
import { McpToolError } from "@skillplane/mcp-schema";
import {
  canonicalizeBundle,
  stableJson,
  type CanonicalBundle,
} from "@skillplane/storage";
import {
  contextOutput,
  resolveContext,
  resolveSkill,
  resolveVersion,
  type ResolvedVersion,
} from "./resolve.js";
import { executeReadTool, type McpToolRuntime } from "./shared.js";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

export async function loadExactCanonicalBundle(
  runtime: McpToolRuntime,
  version: ResolvedVersion,
): Promise<CanonicalBundle> {
  const stored = await runtime.services.bundleStorage.getCanonicalBundle(
    version.objectKey,
    version.digest,
  );
  const canonical = await canonicalizeBundle(stored.bytes);
  if (
    canonical.digest !== version.digest ||
    !equalBytes(canonical.bytes, stored.bytes) ||
    stableJson(canonical.manifest) !== stableJson(version.manifest)
  ) {
    throw new McpToolError(
      "R2_OBJECT_MISMATCH",
      "The stored skill bundle failed exact digest validation",
      { status: 503, retryable: true },
    );
  }
  return canonical;
}

function decodeInstructions(bytes: Uint8Array | undefined): string {
  if (!bytes) {
    throw new McpToolError(
      "R2_OBJECT_MISMATCH",
      "The stored skill bundle is missing its instructions",
      { status: 503, retryable: true },
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new McpToolError(
      "R2_OBJECT_MISMATCH",
      "The stored skill instructions are not valid UTF-8",
      { status: 503, retryable: true },
    );
  }
}

export function skillRetrieve(runtime: McpToolRuntime, input: SkillRetrieveInput) {
  return executeReadTool(runtime, "skill_retrieve", input.caller, async (execution) => {
    let skill = await resolveSkill(runtime, execution, input.skill, {
      action: "skills:read",
      allowPublic: true,
    });
    const version = await resolveVersion(runtime, execution, skill, input.version);
    let selectedContext: SkillRetrieveOutput["context"] = null;
    if (input.context) {
      skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:read",
        allowPublic: false,
      });
      const context = await resolveContext(
        runtime,
        execution,
        skill,
        input.context.selector,
      );
      selectedContext = await contextOutput(runtime, context, {
        knowledge: input.context.knowledge,
        includeNotes: input.context.includeNotes,
      });
    }
    const bundle = await loadExactCanonicalBundle(runtime, version);
    const output: SkillRetrieveOutput = {
      requestId: execution.requestId,
      skill: {
        id: skill.id,
        workspaceId: skill.workspaceId,
        workspaceSlug: skill.workspaceSlug,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        tags: [...skill.tags],
        visibility: skill.visibility,
      },
      version: {
        id: version.id,
        revision: version.revision,
        semanticVersion: version.semanticVersion,
        state: version.state,
        digest: version.digest,
        byteSize: version.byteSize,
        manifest: {
          ...bundle.manifest,
          files: bundle.manifest.files.map((file) => ({ ...file })),
        },
        createdAt: version.createdAt,
        publishedAt: version.publishedAt,
      },
      instructions: decodeInstructions(bundle.files.get("SKILL.md")),
      files: bundle.manifest.files.map((file) => ({ ...file })),
      context: selectedContext,
    };
    return { output };
  });
}
