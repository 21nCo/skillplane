import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { root, run } from "./production-deployment.mjs";

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
    const value = await this.readIfPresent(key);
    if (!value) throw new Error(`Could not read ${this.bucket}/${key}`);
    return value;
  }

  async readIfPresent(key) {
    return this.withTemporaryFile(async (path) => {
      const result = spawnSync(
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
        {
          cwd: root,
          env: process.env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        if (/not found|does not exist|NoSuchKey|10007/iu.test(output)) return null;
        throw new Error(`Could not read ${this.bucket}/${key}`);
      }
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
    const existing = await this.readIfPresent(input.key);
    if (existing) {
      if (
        existing.byteLength !== input.bytes.byteLength ||
        existing.some((byte, index) => byte !== input.bytes[index])
      ) {
        throw new Error(`R2_MIGRATION_OBJECT_CONFLICT:${input.key}`);
      }
      return "exists";
    }
    await this.put(input.key, input.bytes);
    return "created";
  }

  async delete(key) {
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
  }
}
