export function globalPublishedBundleKey(input: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly digest: `sha256:${string}`;
}): string {
  const safe = (value: string, label: string): string => {
    if (!/^[A-Za-z0-9:_-]{1,180}$/u.test(value)) {
      throw new Error(`PUBLICATION_${label.toUpperCase()}_INVALID`);
    }
    return value;
  };
  const digest = input.digest.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("PUBLICATION_DIGEST_INVALID");
  }
  return [
    "public",
    "workspaces",
    safe(input.workspaceId, "workspace"),
    "skills",
    safe(input.skillId, "skill"),
    "versions",
    safe(input.versionId, "version"),
    "sha256",
    `${digest}.zip`,
  ].join("/");
}

export interface ImmutablePublicationStore {
  putIfAbsent(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<"created" | "exists">;
  read(input: {
    readonly key: string;
    readonly digest: `sha256:${string}`;
  }): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export interface ImmutableObjectBucket {
  head(key: string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    bytes: Uint8Array,
    options: {
      readonly onlyIf: { readonly etagDoesNotMatch: string };
      readonly httpMetadata: { readonly contentType: string };
      readonly customMetadata: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** Adapts a private R2-compatible bucket to the immutable projection contract. */
export function createImmutableObjectPublicationStore(
  bucket: ImmutableObjectBucket,
): ImmutablePublicationStore {
  return {
    async putIfAbsent(input) {
      if (await bucket.head(input.key)) return "exists";
      const created = await bucket.put(input.key, input.bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/zip" },
        customMetadata: { ...input.metadata, digest: input.digest },
      });
      return created ? "created" : "exists";
    },
    async read(input) {
      const object = await bucket.get(input.key);
      if (!object) throw new Error("PUBLICATION_OBJECT_NOT_FOUND");
      return new Uint8Array(await object.arrayBuffer());
    },
    delete: (key) => bucket.delete(key),
  };
}

export interface PublicProjectionDirectory {
  publish(input: {
    readonly workspaceId: string;
    readonly workspaceSlug: string;
    readonly skillId: string;
    readonly skillSlug: string;
    readonly versionId: string;
    readonly currentVersionId: string;
    readonly semanticVersion: string;
    readonly digest: `sha256:${string}`;
    readonly objectKey: string;
    readonly projectionSequence: number;
    readonly publishedAt?: string;
    readonly document?: Readonly<Record<string, unknown>>;
    readonly searchText?: string;
  }): Promise<void>;
  unpublish(input: {
    readonly workspaceId: string;
    readonly skillId: string;
    readonly versionId: string;
    readonly projectionSequence: number;
  }): Promise<void>;
}

interface ProjectionSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Durable global metadata projection; object visibility is updated only after digest verification. */
export class PostgresPublicProjectionDirectory implements PublicProjectionDirectory {
  constructor(private readonly database: ProjectionSqlClient) {}

  async publish(input: Parameters<PublicProjectionDirectory["publish"]>[0]) {
    await this.database.query(
      `WITH accepted_head AS (
         INSERT INTO public_skill_projection_heads
           (workspace_id, skill_id, current_version_id, state,
            projection_sequence, updated_at)
         VALUES ($1, $3, $6, 'published', $10, now())
         ON CONFLICT (workspace_id, skill_id)
         DO UPDATE SET current_version_id = EXCLUDED.current_version_id,
                       state = 'published',
                       projection_sequence = EXCLUDED.projection_sequence,
                       updated_at = now()
         WHERE public_skill_projection_heads.projection_sequence <=
               EXCLUDED.projection_sequence
         RETURNING workspace_id
       )
       INSERT INTO public_skill_projections
         (workspace_id, workspace_slug, skill_id, skill_slug, version_id,
          semantic_version, digest, object_key, projection_sequence, document,
          search_text, state, published_at, unpublished_at, updated_at)
       SELECT $1, $2, $3, $4, $5, $7, $8, $9, $10, $11::jsonb, $12,
              'published', COALESCE($13::timestamptz, now()), NULL, now()
         FROM accepted_head
       ON CONFLICT (workspace_id, skill_id, version_id)
       DO UPDATE SET workspace_slug = EXCLUDED.workspace_slug,
                     skill_slug = EXCLUDED.skill_slug,
                     semantic_version = EXCLUDED.semantic_version,
                     digest = EXCLUDED.digest,
                     object_key = EXCLUDED.object_key,
                     projection_sequence = EXCLUDED.projection_sequence,
                     document = EXCLUDED.document,
                     search_text = EXCLUDED.search_text,
                     published_at = EXCLUDED.published_at,
                     state = 'published', unpublished_at = NULL,
                     updated_at = now()
       WHERE public_skill_projections.projection_sequence <=
             EXCLUDED.projection_sequence`,
      [
        input.workspaceId,
        input.workspaceSlug,
        input.skillId,
        input.skillSlug,
        input.versionId,
        input.currentVersionId,
        input.semanticVersion,
        input.digest,
        input.objectKey,
        input.projectionSequence,
        JSON.stringify(input.document ?? {}),
        input.searchText ?? "",
        input.publishedAt ?? null,
      ],
    );
  }

  async unpublish(input: Parameters<PublicProjectionDirectory["unpublish"]>[0]) {
    await this.database.query(
      `WITH accepted_head AS (
         INSERT INTO public_skill_projection_heads
           (workspace_id, skill_id, current_version_id, state,
            projection_sequence, updated_at)
         VALUES ($1, $2, $3, 'unpublished', $4, now())
         ON CONFLICT (workspace_id, skill_id)
         DO UPDATE SET current_version_id = EXCLUDED.current_version_id,
                       state = 'unpublished',
                       projection_sequence = EXCLUDED.projection_sequence,
                       updated_at = now()
         WHERE public_skill_projection_heads.projection_sequence <=
               EXCLUDED.projection_sequence
         RETURNING workspace_id
       )
       UPDATE public_skill_projections
          SET state = 'unpublished', projection_sequence = $4,
              unpublished_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND skill_id = $2
          AND state = 'published' AND projection_sequence <= $4
          AND EXISTS (SELECT 1 FROM accepted_head)`,
      [input.workspaceId, input.skillId, input.versionId, input.projectionSequence],
    );
  }
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Copies an immutable regional bundle before atomically exposing its global projection. */
export async function publishGlobalProjection(input: {
  readonly source: ImmutablePublicationStore;
  readonly destination: ImmutablePublicationStore;
  readonly directory: PublicProjectionDirectory;
  readonly sourceKey: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly skillId: string;
  readonly skillSlug: string;
  readonly versionId: string;
  readonly currentVersionId: string;
  readonly semanticVersion: string;
  readonly digest: `sha256:${string}`;
  readonly projectionSequence: number;
  readonly publishedAt?: string;
  readonly document?: Readonly<Record<string, unknown>>;
  readonly searchText?: string;
}): Promise<string> {
  const bytes = await input.source.read({ key: input.sourceKey, digest: input.digest });
  if ((await sha256(bytes)) !== input.digest) {
    throw new Error("PUBLICATION_SOURCE_DIGEST_MISMATCH");
  }
  const objectKey = globalPublishedBundleKey(input);
  await input.destination.putIfAbsent({
    key: objectKey,
    bytes,
    digest: input.digest,
    metadata: {
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      versionId: input.versionId,
      digest: input.digest,
    },
  });
  const verified = await input.destination.read({
    key: objectKey,
    digest: input.digest,
  });
  if ((await sha256(verified)) !== input.digest) {
    throw new Error("PUBLICATION_DESTINATION_DIGEST_MISMATCH");
  }
  await input.directory.publish({
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    skillId: input.skillId,
    skillSlug: input.skillSlug,
    versionId: input.versionId,
    currentVersionId: input.currentVersionId,
    semanticVersion: input.semanticVersion,
    digest: input.digest,
    objectKey,
    projectionSequence: input.projectionSequence,
    ...(input.publishedAt !== undefined ? { publishedAt: input.publishedAt } : {}),
    ...(input.document ? { document: input.document } : {}),
    ...(input.searchText !== undefined ? { searchText: input.searchText } : {}),
  });
  return objectKey;
}
