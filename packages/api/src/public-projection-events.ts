import { validateBundleArchive } from "@skillplane/storage";
import type { ApiServices } from "./context.js";
import type { Principal, SkillRecord } from "@skillplane/domain";

function routingEpoch(request: Request): number {
  const value = Number(request.headers.get("x-skillplane-routing-epoch") ?? "1");
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("WORKSPACE_ROUTING_EPOCH_INVALID");
  }
  return value;
}

async function enqueue(
  services: ApiServices,
  workspaceId: string,
  eventType: "public_skill.published" | "public_skill.unpublished",
  payload: Readonly<Record<string, unknown>>,
  epoch: number,
): Promise<void> {
  const client = await services.database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workspaceId]);
    await client.query(
      `INSERT INTO regional_projection_outbox
         (id, workspace_id, event_type, payload, fencing_epoch, sequence)
       SELECT $1, $2, $3, $4::jsonb, $5, COALESCE(MAX(sequence), 0) + 1
         FROM regional_projection_outbox
        WHERE workspace_id = $2`,
      [
        `regional-projection:${crypto.randomUUID()}`,
        workspaceId,
        eventType,
        JSON.stringify(payload),
        epoch,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Projects public visibility/archive lifecycle changes through the regional outbox. */
export async function enqueueSkillProjectionChange(input: {
  readonly services: ApiServices;
  readonly request: Request;
  readonly principal: Principal;
  readonly skill: SkillRecord;
}): Promise<void> {
  const versionId = input.skill.currentPublishedVersionId;
  if (!versionId) return;
  const epoch = routingEpoch(input.request);
  if (input.skill.visibility !== "public" || input.skill.archivedAt) {
    await enqueue(
      input.services,
      input.principal.workspaceId,
      "public_skill.unpublished",
      {
        workspaceId: input.principal.workspaceId,
        skillId: input.skill.id,
        versionId,
      },
      epoch,
    );
    return;
  }
  const versions = await input.services.skillVersionService.list({
    skillId: input.skill.id,
    principal: input.principal,
    limit: 100,
  });
  const published = versions.filter(
    (version) => version.status === "published" && version.semanticVersion,
  );
  if (!published.some((candidate) => candidate.id === versionId)) {
    throw new Error("PUBLICATION_CURRENT_VERSION_MISSING");
  }
  for (const version of [...published].reverse()) {
    if (!version.semanticVersion) throw new Error("PUBLICATION_SEMVER_MISSING");
    const stored = await input.services.bundleStorage.getCanonicalBundle(
      version.objectKey,
      version.digest,
    );
    const bundle = await validateBundleArchive(stored.bytes);
    const markdown = bundle.files.get("SKILL.md");
    if (!markdown) throw new Error("PUBLICATION_SKILL_MD_MISSING");
    const searchText = new TextDecoder("utf-8", { fatal: true }).decode(markdown);
    await enqueue(
      input.services,
      input.principal.workspaceId,
      "public_skill.published",
      {
        workspaceId: input.principal.workspaceId,
        skillId: input.skill.id,
        skillSlug: input.skill.slug,
        versionId: version.id,
        semanticVersion: version.semanticVersion,
        sourceObjectKey: version.objectKey,
        digest: version.digest,
        searchText,
        document: { skill: input.skill, version },
      },
      epoch,
    );
  }
}
