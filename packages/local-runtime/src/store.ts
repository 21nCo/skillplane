import { DatabaseSync } from "node:sqlite";
import { existsSync, chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalizeBundle,
  stableJson,
  type CanonicalBundle,
} from "@skillplane/storage";
import { safeDirectory, readSafe, writeAtomic, hash } from "./files.js";
import { RuntimeError } from "./contracts.js";

export class LocalStore {
  readonly db: DatabaseSync;
  readonly root: string;
  constructor(root: string) {
    this.root = safeDirectory(root);
    const path = join(root, "runtime.sqlite");
    if (
      existsSync(path) &&
      (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    )
      throw new RuntimeError("UNSAFE_FILE");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS skill (id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspace(id), slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, current TEXT, UNIQUE(workspace,slug));
      CREATE TABLE IF NOT EXISTS version (id TEXT PRIMARY KEY, skill TEXT NOT NULL REFERENCES skill(id), digest TEXT NOT NULL, state TEXT NOT NULL, semantic TEXT, base TEXT, bump TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, learning TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS mutation (key TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, payload TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0);
    `);
    if (!this.get("installation")) this.set("installation", randomUUID());
  }
  close(): void {
    this.db.close();
  }
  // Typed deserialization is the boundary of this private metadata registry.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, stableJson(value));
  }
  delete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key=?").run(key);
  }
  entries<T>(prefix: string): [string, T][] {
    return this.db
      .prepare("SELECT key,value FROM kv WHERE substr(key,1,?)=? ORDER BY key")
      .all(prefix.length, prefix)
      .map((r) => [String(r.key), JSON.parse(String(r.value)) as T]);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  // Idempotency responses retain the operation-specific response type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  replay<T>(key: string, request: unknown): T | undefined {
    const row = this.db
      .prepare("SELECT hash,result FROM mutation WHERE key=?")
      .get(key);
    if (!row) return undefined;
    if (row.hash !== hash(stableJson(request)))
      throw new RuntimeError("IDEMPOTENCY_CONFLICT");
    return JSON.parse(String(row.result)) as T;
  }
  remember(key: string, request: unknown, result: unknown): void {
    this.db
      .prepare("INSERT INTO mutation VALUES(?,?,?)")
      .run(key, hash(stableJson(request)), stableJson(result));
  }
  putBundle(bundle: CanonicalBundle): void {
    if (`sha256:${hash(bundle.bytes)}` !== bundle.digest)
      throw new RuntimeError("DIGEST_MISMATCH");
    const path = this.bundlePath(bundle.digest);
    if (existsSync(path)) {
      if (hash(readSafe(path)) !== bundle.digest.slice(7))
        throw new RuntimeError("DIGEST_MISMATCH");
    } else writeAtomic(path, bundle.bytes);
  }
  bundlePath(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new RuntimeError("DIGEST_INVALID");
    return join(this.root, "bundles", digest.slice(7) + ".zip");
  }
  async bundle(digest: string): Promise<CanonicalBundle> {
    const bytes = readSafe(this.bundlePath(digest));
    if (hash(bytes) !== digest.slice(7)) throw new RuntimeError("DIGEST_MISMATCH");
    const bundle = await canonicalizeBundle(bytes);
    if (bundle.digest !== digest) throw new RuntimeError("DIGEST_MISMATCH");
    return bundle;
  }
}
