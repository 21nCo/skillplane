import { assertStorageIdentifier } from "./paths.js";
import { sha256Hex } from "./validate.js";

export type StorageErrorCode =
  "R2_WRITE_FAILED" | "R2_READ_FAILED" | "R2_OBJECT_MISMATCH" | "R2_CLEANUP_FAILED";

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded?: Date;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResultLike {
  readonly objects: readonly R2ObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
    },
  ): Promise<R2ObjectLike | null>;
  delete(keys: string | readonly string[]): Promise<void>;
  list(options?: {
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<R2ListResultLike>;
}

export interface R2DigestCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

export interface StoredBundle {
  readonly key: string;
  readonly digest: `sha256:${string}`;
  readonly byteSize: number;
  readonly etag: string;
}

export interface CleanupResult {
  readonly scanned: number;
  readonly deleted: readonly string[];
  readonly preserved: readonly string[];
}

export function bundleObjectKey(
  workspaceId: string,
  skillId: string,
  digest: `sha256:${string}`,
): string {
  const digestHex = digest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(digestHex)) {
    throw new StorageError("R2_WRITE_FAILED", "Bundle digest is invalid");
  }
  return `workspaces/${assertStorageIdentifier(
    workspaceId,
    "Workspace ID",
  )}/skills/${assertStorageIdentifier(
    skillId,
    "Skill ID",
  )}/bundles/sha256/${digestHex}.zip`;
}

export class R2BundleRepository {
  constructor(
    private readonly bucket: R2BucketLike,
    private readonly digestCache?: R2DigestCacheLike,
  ) {}

  private cacheRequest(digest: `sha256:${string}`): Request {
    return new Request(
      `https://immutable-bundles.skillplane.invalid/${digest.replace(
        "sha256:",
        "",
      )}.zip`,
    );
  }

  private async readDigestCache(
    digest: `sha256:${string}`,
  ): Promise<Uint8Array | null> {
    if (!this.digestCache) return null;
    const request = this.cacheRequest(digest);
    try {
      const cached = await this.digestCache.match(request);
      if (!cached) return null;
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (`sha256:${await sha256Hex(bytes)}` === digest) return bytes;
      await this.digestCache.delete(request);
      return null;
    } catch {
      return null;
    }
  }

  private async writeDigestCache(
    digest: `sha256:${string}`,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!this.digestCache) return;
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    await this.digestCache
      .put(
        this.cacheRequest(digest),
        new Response(body, {
          headers: {
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Type": "application/zip",
          },
        }),
      )
      .catch(() => undefined);
  }

  private async verifyExisting(
    key: string,
    digest: `sha256:${string}`,
    expectedBytes?: Uint8Array,
  ): Promise<StoredBundle> {
    let object: R2ObjectBodyLike | null;
    try {
      object = await this.bucket.get(key);
    } catch {
      throw new StorageError("R2_READ_FAILED", "Bundle object could not be read");
    }
    if (!object) {
      throw new StorageError("R2_READ_FAILED", "Bundle object was not found");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const actualDigest = `sha256:${await sha256Hex(bytes)}`;
    if (
      actualDigest !== digest ||
      (expectedBytes &&
        (expectedBytes.byteLength !== bytes.byteLength ||
          expectedBytes.some((byte, index) => byte !== bytes[index])))
    ) {
      throw new StorageError(
        "R2_OBJECT_MISMATCH",
        "Existing bundle object does not match its content address",
      );
    }
    return {
      key,
      digest,
      byteSize: bytes.byteLength,
      etag: object.etag,
    };
  }

  async putCanonicalBundle(
    workspaceId: string,
    skillId: string,
    digest: `sha256:${string}`,
    bytes: Uint8Array,
  ): Promise<StoredBundle> {
    const key = bundleObjectKey(workspaceId, skillId, digest);
    try {
      if (`sha256:${await sha256Hex(bytes)}` !== digest) {
        throw new StorageError(
          "R2_OBJECT_MISMATCH",
          "Bundle bytes do not match their proposed content address",
        );
      }
      const existing = await this.bucket.head(key);
      if (existing) return await this.verifyExisting(key, digest, bytes);
      const created = await this.bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/zip" },
        customMetadata: {
          digest,
          mediaType: "application/zip",
        },
      });
      if (!created) return await this.verifyExisting(key, digest, bytes);
      return {
        key,
        digest,
        byteSize: bytes.byteLength,
        etag: created.etag,
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("R2_WRITE_FAILED", "Bundle object could not be written");
    }
  }

  async getCanonicalBundle(
    key: string,
    expectedDigest: `sha256:${string}`,
  ): Promise<{ readonly object: StoredBundle; readonly bytes: Uint8Array }> {
    let head: R2ObjectLike | null;
    try {
      head = await this.bucket.head(key);
    } catch {
      throw new StorageError("R2_READ_FAILED", "Bundle object could not be read");
    }
    if (!head) {
      throw new StorageError("R2_READ_FAILED", "Bundle object was not found");
    }
    const cached = await this.readDigestCache(expectedDigest);
    if (cached) {
      return {
        object: {
          key,
          digest: expectedDigest,
          byteSize: cached.byteLength,
          etag: head.etag,
        },
        bytes: cached,
      };
    }
    let object: R2ObjectBodyLike | null;
    try {
      object = await this.bucket.get(key);
    } catch {
      throw new StorageError("R2_READ_FAILED", "Bundle object could not be read");
    }
    if (!object) {
      throw new StorageError("R2_READ_FAILED", "Bundle object was not found");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const digest = `sha256:${await sha256Hex(bytes)}`;
    if (digest !== expectedDigest) {
      throw new StorageError(
        "R2_OBJECT_MISMATCH",
        "Bundle object failed digest verification",
      );
    }
    await this.writeDigestCache(expectedDigest, bytes);
    return {
      object: {
        key,
        digest: expectedDigest,
        byteSize: bytes.byteLength,
        etag: object.etag,
      },
      bytes,
    };
  }

  async deleteIfUnreferenced(
    key: string,
    isReferenced: (key: string) => Promise<boolean>,
  ): Promise<boolean> {
    let referenced: boolean;
    try {
      referenced = await isReferenced(key);
    } catch {
      throw new StorageError(
        "R2_CLEANUP_FAILED",
        "Reference state could not be verified; object was preserved",
      );
    }
    if (referenced) return false;
    try {
      await this.bucket.delete(key);
      return true;
    } catch {
      throw new StorageError("R2_CLEANUP_FAILED", "Orphan object could not be deleted");
    }
  }

  async cleanupOrphans(options: {
    readonly prefix?: string;
    readonly olderThan: Date;
    readonly referencedKeys: () => Promise<ReadonlySet<string>>;
  }): Promise<CleanupResult> {
    const objects: R2ObjectLike[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await this.bucket.list({
          ...(options.prefix ? { prefix: options.prefix } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 1000,
        });
        objects.push(...page.objects);
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && !cursor) {
          throw new Error("Truncated R2 listing did not return a cursor");
        }
      } while (cursor);
    } catch {
      throw new StorageError(
        "R2_CLEANUP_FAILED",
        "Object inventory could not be completed; no objects were deleted",
      );
    }

    let referenced: ReadonlySet<string>;
    try {
      referenced = await options.referencedKeys();
    } catch {
      throw new StorageError(
        "R2_CLEANUP_FAILED",
        "Reference inventory could not be completed; no objects were deleted",
      );
    }
    const deletable = objects
      .filter(
        (object) =>
          object.uploaded !== undefined &&
          object.uploaded < options.olderThan &&
          !referenced.has(object.key),
      )
      .map((object) => object.key)
      .sort();
    try {
      for (let offset = 0; offset < deletable.length; offset += 1000) {
        await this.bucket.delete(deletable.slice(offset, offset + 1000));
      }
    } catch {
      throw new StorageError("R2_CLEANUP_FAILED", "Orphan deletion did not complete");
    }
    return {
      scanned: objects.length,
      deleted: deletable,
      preserved: objects
        .map((object) => object.key)
        .filter((key) => !deletable.includes(key))
        .sort(),
    };
  }
}
