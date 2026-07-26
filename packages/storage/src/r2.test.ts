import { describe, expect, it } from "vitest";
import { R2BundleRepository, type R2BucketLike } from "./r2.js";
import { sha256Hex } from "./validate.js";

interface FakeRecord {
  bytes: Uint8Array;
  uploaded: Date;
  metadata: Readonly<Record<string, string>>;
}

function createBucket(): R2BucketLike & {
  readonly records: Map<string, FakeRecord>;
  failList: boolean;
} {
  const records = new Map<string, FakeRecord>();
  return {
    records,
    failList: false,
    async head(key) {
      const record = records.get(key);
      return record
        ? {
            key,
            size: record.bytes.length,
            etag: `etag-${record.bytes.length}`,
            uploaded: record.uploaded,
            customMetadata: record.metadata,
          }
        : null;
    },
    async get(key) {
      const record = records.get(key);
      return record
        ? {
            key,
            size: record.bytes.length,
            etag: `etag-${record.bytes.length}`,
            uploaded: record.uploaded,
            customMetadata: record.metadata,
            async arrayBuffer() {
              return record.bytes.slice().buffer;
            },
          }
        : null;
    },
    async put(key, value, options) {
      if (records.has(key) && options?.onlyIf?.etagDoesNotMatch === "*") return null;
      const copy = value.slice();
      const record = {
        bytes: copy,
        uploaded: new Date("2026-07-20T00:00:00Z"),
        metadata: options?.customMetadata ?? {},
      };
      records.set(key, record);
      return {
        key,
        size: copy.length,
        etag: `etag-${copy.length}`,
        uploaded: record.uploaded,
        customMetadata: record.metadata,
      };
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) records.delete(key);
    },
    async list(options) {
      if (this.failList) throw new Error("unavailable");
      const objects = [...records.entries()]
        .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
        .map(([key, record]) => ({
          key,
          size: record.bytes.length,
          etag: `etag-${record.bytes.length}`,
          uploaded: record.uploaded,
          customMetadata: record.metadata,
        }));
      return { objects, truncated: false };
    },
  };
}

describe("R2 bundle repository", () => {
  it("reuses digest-verified cached bytes only after confirming R2 availability", async () => {
    const bucket = createBucket();
    let bodyReads = 0;
    const originalGet = bucket.get.bind(bucket);
    bucket.get = async (key) => {
      bodyReads += 1;
      return originalGet(key);
    };
    const cached = new Map<string, Response>();
    const cache = {
      async match(request: Request) {
        return cached.get(request.url)?.clone();
      },
      async put(request: Request, response: Response) {
        cached.set(request.url, response.clone());
      },
      async delete(request: Request) {
        return cached.delete(request.url);
      },
    };
    const repository = new R2BundleRepository(bucket, cache);
    const bytes = new TextEncoder().encode("immutable cached bundle");
    const digest = `sha256:${await sha256Hex(bytes)}` as const;
    const stored = await repository.putCanonicalBundle(
      "ws_cache",
      "skill_cache",
      digest,
      bytes,
    );

    expect((await repository.getCanonicalBundle(stored.key, digest)).bytes).toEqual(
      bytes,
    );
    expect((await repository.getCanonicalBundle(stored.key, digest)).bytes).toEqual(
      bytes,
    );
    expect(bodyReads).toBe(1);
    expect(cached.size).toBe(1);

    bucket.records.delete(stored.key);
    await expect(
      repository.getCanonicalBundle(stored.key, digest),
    ).rejects.toMatchObject({ code: "R2_READ_FAILED" });
  });

  it("writes a content address once and refuses mismatched bytes", async () => {
    const bucket = createBucket();
    const repository = new R2BundleRepository(bucket);
    const bytes = new TextEncoder().encode("canonical");
    const digest = `sha256:${await sha256Hex(bytes)}` as const;
    const first = await repository.putCanonicalBundle("ws_a", "skill_a", digest, bytes);
    const second = await repository.putCanonicalBundle(
      "ws_a",
      "skill_a",
      digest,
      bytes,
    );
    expect(second.key).toBe(first.key);
    expect(bucket.records.size).toBe(1);

    await expect(
      repository.putCanonicalBundle(
        "ws_a",
        "skill_a",
        digest,
        new TextEncoder().encode("different"),
      ),
    ).rejects.toMatchObject({
      code: "R2_OBJECT_MISMATCH",
    });
    expect(new TextDecoder().decode(bucket.records.get(first.key)?.bytes)).toBe(
      "canonical",
    );
  });

  it("deletes only old unreferenced objects and fails closed on uncertainty", async () => {
    const bucket = createBucket();
    const repository = new R2BundleRepository(bucket);
    const bytesA = new TextEncoder().encode("A");
    const bytesB = new TextEncoder().encode("B");
    const digestA = `sha256:${await sha256Hex(bytesA)}` as const;
    const digestB = `sha256:${await sha256Hex(bytesB)}` as const;
    const a = await repository.putCanonicalBundle("ws_a", "skill_a", digestA, bytesA);
    const b = await repository.putCanonicalBundle("ws_a", "skill_b", digestB, bytesB);

    const result = await repository.cleanupOrphans({
      olderThan: new Date("2026-07-21T00:00:00Z"),
      referencedKeys: async () => new Set([a.key]),
    });
    expect(result.deleted).toEqual([b.key]);
    expect(bucket.records.has(a.key)).toBe(true);

    await expect(
      repository.cleanupOrphans({
        olderThan: new Date("2026-07-21T00:00:00Z"),
        referencedKeys: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({
      code: "R2_CLEANUP_FAILED",
    });
    expect(bucket.records.has(a.key)).toBe(true);
  });
});
