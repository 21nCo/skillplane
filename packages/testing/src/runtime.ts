import type { ObjectStorageBinding, RuntimeBindings } from "@skillplane/config";

interface TestStoredObject {
  readonly bytes: Uint8Array;
  readonly uploaded: Date;
  readonly customMetadata: Readonly<Record<string, string>>;
  readonly contentType?: string;
  readonly etag: string;
}

export class TestObjectStorage implements ObjectStorageBinding {
  readonly #objects = new Map<string, TestStoredObject>();
  #etagSequence = 0;
  failNextPut = false;
  failReads = false;
  failListing = false;
  headCalls = 0;
  getCalls = 0;

  inventory(): readonly {
    readonly key: string;
    readonly byteSize: number;
    readonly uploaded: Date;
  }[] {
    return [...this.#objects.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        byteSize: value.bytes.byteLength,
        uploaded: value.uploaded,
      }));
  }

  raw(key: string): Uint8Array | null {
    return this.#objects.get(key)?.bytes.slice() ?? null;
  }

  head(key: string) {
    this.headCalls += 1;
    if (this.failReads) return Promise.reject(new Error("fixture R2 read failure"));
    const object = this.#objects.get(key);
    return Promise.resolve(
      object
        ? {
            key,
            size: object.bytes.byteLength,
            etag: object.etag,
            uploaded: object.uploaded,
            customMetadata: object.customMetadata,
          }
        : null,
    );
  }

  get(key: string) {
    this.getCalls += 1;
    if (this.failReads) return Promise.reject(new Error("fixture R2 read failure"));
    const object = this.#objects.get(key);
    return Promise.resolve(
      object
        ? {
            key,
            size: object.bytes.byteLength,
            etag: object.etag,
            uploaded: object.uploaded,
            customMetadata: object.customMetadata,
            arrayBuffer: () => Promise.resolve(object.bytes.slice().buffer),
          }
        : null,
    );
  }

  put(
    key: string,
    value: Uint8Array,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
    },
  ) {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error("fixture R2 write failure"));
    }
    if (this.#objects.has(key) && options?.onlyIf?.etagDoesNotMatch === "*") {
      return Promise.resolve(null);
    }
    const copy = value.slice();
    const stored: TestStoredObject = {
      bytes: copy,
      uploaded: new Date(),
      customMetadata: options?.customMetadata ?? {},
      ...(options?.httpMetadata?.contentType
        ? { contentType: options.httpMetadata.contentType }
        : {}),
      etag: `test-etag-${String(++this.#etagSequence)}`,
    };
    this.#objects.set(key, stored);
    return Promise.resolve({
      key,
      size: copy.byteLength,
      etag: stored.etag,
      uploaded: stored.uploaded,
      customMetadata: stored.customMetadata,
    });
  }

  delete(keys: string | readonly string[]): Promise<void> {
    for (const key of typeof keys === "string" ? [keys] : keys) {
      this.#objects.delete(key);
    }
    return Promise.resolve();
  }

  list(options?: {
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) {
    if (this.failListing) {
      return Promise.reject(new Error("fixture R2 listing failure"));
    }
    const offset = options?.cursor ? Number(options.cursor) : 0;
    const limit = options?.limit ?? 1_000;
    const values = [...this.#objects.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const page = values.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return Promise.resolve({
      objects: page.map(([key, object]) => ({
        key,
        size: object.bytes.byteLength,
        etag: object.etag,
        uploaded: object.uploaded,
        customMetadata: object.customMetadata,
      })),
      truncated: nextOffset < values.length,
      ...(nextOffset < values.length ? { cursor: String(nextOffset) } : {}),
    });
  }
}

export function createTestRuntimeBindings(
  overrides: Partial<RuntimeBindings> = {},
): RuntimeBindings {
  return {
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane_test",
    SKILL_BUNDLES: new TestObjectStorage(),
    ...overrides,
  };
}
