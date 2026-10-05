#!/usr/bin/env -S node --experimental-strip-types

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertExactSkillplaneMcpToolInventory } from "../mcp/src/tool-catalog.ts";
import {
  isMain,
  productionResource,
  requireEnvironment,
} from "./lib/production-deployment.mjs";

function callerDeclaration() {
  return {
    agentId: requireEnvironment("SKILLPLANE_PRODUCTION_AGENT_ID"),
    agentName: requireEnvironment("SKILLPLANE_PRODUCTION_AGENT_NAME"),
    modelProvider: requireEnvironment("SKILLPLANE_PRODUCTION_MODEL_PROVIDER"),
    modelName: requireEnvironment("SKILLPLANE_PRODUCTION_MODEL_NAME"),
    modelVersion: requireEnvironment("SKILLPLANE_PRODUCTION_MODEL_VERSION"),
    clientName: "Skillplane production verification",
    clientVersion: "1.0.0",
    runId: `run:production:${crypto.randomUUID()}`,
    sessionId: `session:production:${crypto.randomUUID()}`,
    conversationId: `conversation:production:${crypto.randomUUID()}`,
  };
}

function parseStructured(result) {
  if (result.isError === true) {
    throw new Error("The production MCP tool returned an error result");
  }
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error("The production MCP tool omitted structured content");
  }
  return result.structuredContent;
}

export async function testProductionMcp() {
  const token = requireEnvironment("SKILLPLANE_PRODUCTION_MCP_ACCESS_TOKEN", {
    minimumLength: 32,
  });
  if (token.startsWith("spk_")) {
    throw new Error(
      "SKILLPLANE_PRODUCTION_MCP_ACCESS_TOKEN must be an OAuth access token, not a service-principal credential",
    );
  }
  const caller = callerDeclaration();
  const transport = new StreamableHTTPClientTransport(new URL(productionResource), {
    requestInit: {
      headers: { authorization: `Bearer ${token}` },
    },
  });
  const client = new Client({
    name: "skillplane-production-verifier",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const protocolVersion = transport.protocolVersion;
    if (!protocolVersion?.startsWith("2025-")) {
      throw new Error("The production MCP server negotiated an unexpected protocol");
    }
    const server = client.getServerVersion();
    if (
      server?.name !== "skillplane" ||
      server.title !== "Skillplane" ||
      server.version !== "1.0.0" ||
      server.websiteUrl !== "https://skillplane.dev" ||
      !server.icons?.some(
        (icon) =>
          icon.src === "https://mcp.skillplane.dev/icon-512.png" &&
          icon.mimeType === "image/png" &&
          icon.sizes?.includes("512x512"),
      )
    ) {
      throw new Error("The production MCP server identity is inconsistent");
    }
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).toSorted();
    assertExactSkillplaneMcpToolInventory(names);
    const discovered = parseStructured(
      await client.callTool({
        name: "workspaces_list",
        arguments: {
          cursor: null,
          limit: 100,
          caller,
        },
      }),
    );
    if (
      !Array.isArray(discovered.workspaces) ||
      discovered.workspaces.length === 0 ||
      !("nextCursor" in discovered)
    ) {
      throw new Error("The production workspaces_list output is invalid");
    }
    const configuredWorkspaceId =
      process.env.SKILLPLANE_PRODUCTION_WORKSPACE_ID?.trim();
    const selectedWorkspace = configuredWorkspaceId
      ? discovered.workspaces.find(
          (workspace) => workspace?.id === configuredWorkspaceId,
        )
      : discovered.workspaces[0];
    if (!selectedWorkspace || typeof selectedWorkspace.id !== "string") {
      throw new Error("The configured production workspace was not discovered");
    }
    const workspaceId = selectedWorkspace.id;
    const catalog = parseStructured(
      await client.callTool({
        name: "skills_list",
        arguments: {
          workspace: { id: workspaceId },
          visibility: ["private", "workspace", "public"],
          state: "active",
          cursor: null,
          limit: 100,
          caller,
        },
      }),
    );
    if (!Array.isArray(catalog.skills) || !("nextCursor" in catalog)) {
      throw new Error("The production skills_list output is invalid");
    }
    const search = parseStructured(
      await client.callTool({
        name: "skills_search",
        arguments: {
          query: "skill",
          workspaceId,
          visibility: ["private", "workspace", "public"],
          tags: [],
          cursor: null,
          limit: 1,
          caller,
        },
      }),
    );
    if (!Array.isArray(search.skills) || !("nextCursor" in search)) {
      throw new Error("The production skills_search output is invalid");
    }
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      resource: productionResource,
      credential: "oauth-access-token",
      audienceVerifiedByServer: true,
      protocolVersion,
      server,
      toolCount: names.length,
      tools: names,
      discovery: {
        workspaceCount: discovered.workspaces.length,
        selectedWorkspaceId: workspaceId,
        paginationContract: true,
      },
      catalog: {
        resultCount: catalog.skills.length,
        paginationContract: true,
        queryRequired: false,
      },
      contextLifecycle: {
        discovery: names.includes("contexts_list"),
        creation: names.includes("context_create"),
        metadataConcurrency: names.includes("context_update"),
        archiveRestore:
          names.includes("context_archive") && names.includes("context_restore"),
        knowledgeHistory: names.includes("context_knowledge_history"),
      },
      skillLifecycle: {
        creation: names.includes("skill_create"),
        visibility: names.includes("skill_visibility_update"),
        archiveRestore:
          names.includes("skill_archive") && names.includes("skill_restore"),
        candidateReview:
          names.includes("skill_candidates_list") &&
          names.includes("skill_candidate_approve") &&
          names.includes("skill_candidate_reject"),
        amendmentPolicy:
          names.includes("skill_amendment_policy_get") &&
          names.includes("skill_amendment_policy_update"),
        versionDiff: names.includes("skill_versions_diff"),
      },
      composition: {
        usageReport: names.includes("skill_usage_report"),
        resolve: names.includes("skill_resolve"),
        executionReport: names.includes("skill_execution_report"),
        candidateCreate: names.includes("skill_composition_candidate_create"),
        dependencyUpgrade:
          names.includes("skill_dependency_upgrades_get") &&
          names.includes("skill_dependency_upgrade"),
        versionLifecycle: names.includes("skill_version_lifecycle_update"),
        verification:
          names.includes("skill_verification_plan_get") &&
          names.includes("skill_verification_run_start") &&
          names.includes("skill_verification_run_get") &&
          names.includes("skill_verification_evidence_add") &&
          names.includes("skill_verification_run_complete"),
      },
      search: {
        workspaceId,
        resultCount: search.skills.length,
        paginationContract: true,
      },
      auditAttribution: {
        callerFields: Object.keys(caller).sort(),
        userIdentity: "derived-from-verified-oauth-token",
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await testProductionMcp(), null, 2)}\n`);
}
