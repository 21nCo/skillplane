import type { PoolClient } from "pg";
import { DomainError } from "./errors.js";
export interface GitSourceLease {
  sourceId: string;
  token: string;
  revision: number;
}
export async function assertGitSourceLease(
  client: PoolClient,
  workspaceId: string,
  lease: GitSourceLease,
) {
  const result = await client.query(
    `SELECT id FROM skill_sources WHERE workspace_id=$1 AND id=$2 AND sync_token=$3 AND revision=$4 AND archived_at IS NULL AND sync_expires_at > clock_timestamp() FOR UPDATE`,
    [workspaceId, lease.sourceId, lease.token, lease.revision],
  );
  if (!result.rowCount)
    throw new DomainError(
      "GIT_SOURCE_LEASE_LOST",
      "Source sync lease was lost; preview again",
      409,
    );
}
export interface GitVersionProvenance {
  sourceId: string;
  runId: string;
  repositoryUrl: string;
  commitSha: string;
  path: string;
}
export async function insertGitVersionProvenance(
  client: PoolClient,
  workspaceId: string,
  versionId: string,
  digest: string,
  provenance: GitVersionProvenance,
) {
  await client.query(
    `INSERT INTO skill_version_git_provenance(version_id,workspace_id,source_id,run_id,repository_url,commit_sha,skill_path,bundle_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      versionId,
      workspaceId,
      provenance.sourceId,
      provenance.runId,
      provenance.repositoryUrl,
      provenance.commitSha,
      provenance.path,
      digest,
    ],
  );
}
