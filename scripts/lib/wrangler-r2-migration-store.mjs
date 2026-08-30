import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { run } from "./production-deployment.mjs";

const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

function objectKey(value) {
  if (!/^(?:workspaces|public)\/[A-Za-z0-9:_./-]{1,1000}$/u.test(value)) {
    throw new Error("Workspace bundle object key is invalid");
  }
  return value;
}

export function requireBucketName(value, label) {
  if (typeof value !== "string" || !bucketPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** Provider adapter used only by the operator-controlled copy/verify workflow. */
export class WranglerR2MigrationStore {
  constructor(bucket) {
    this.bucket = requireBucketName(bucket, "R2 bucket name");
  }

  async withTemporaryFile(operation) {
    const directory = await mkdtemp(resolve(tmpdir(), "skillplane-workspace-move-"));
    const path = resolve(directory, "bundle.zip");
    try {
      return await operation(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async read(keyOrInput) {
    const key = typeof keyOrInput === "string" ? keyOrInput : keyOrInput?.key;
    return this.withTemporaryFile(async (path) => {
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "r2",
          "object",
          "get",
          `${this.bucket}/${objectKey(key)}`,
          "--file",
          path,
          "--remote",
        ],
        { failureMessage: `Could not read ${this.bucket}/${key}` },
      );
      return new Uint8Array(await readFile(path));
    });
  }

  async put(key, bytes) {
    await this.withTemporaryFile(async (path) => {
      await writeFile(path, bytes, { mode: 0o600 });
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "r2",
          "object",
          "put",
          `${this.bucket}/${objectKey(key)}`,
          "--file",
          path,
          "--content-type",
          "application/zip",
          "--remote",
        ],
        { failureMessage: `Could not write ${this.bucket}/${key}` },
      );
    });
  }

  async putIfAbsent(input) {
    // The destination key embeds the verified digest. Rewriting that exact key
    // during a resumed, single-writer cutover is byte-preserving and idempotent.
    await this.put(input.key, input.bytes);
    return "created";
  }

  delete(key) {
    run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "delete",
        `${this.bucket}/${objectKey(key)}`,
        "--remote",
      ],
      { failureMessage: `Could not delete ${this.bucket}/${key}` },
    );
    return Promise.resolve();
  }
}
