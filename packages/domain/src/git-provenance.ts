import type { PoolClient } from "pg";
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
