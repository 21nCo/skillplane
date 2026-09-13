import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, resolve, parse, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RuntimeError } from "./contracts.js";

export const hash = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
/** Resolve a directory path while rejecting unsafe ownership and symlink traversal. */
export function safeDirectory(path: string): string {
  path = resolve(path);
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      // lstat detects dangling symlinks which existsSync follows.
      try {
        lstatSync(current);
        throw new RuntimeError("SYMLINK_FORBIDDEN");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new RuntimeError("SYMLINK_FORBIDDEN");
    // Local installation paths must not be replaceable by other OS users.
    // A root-owned sticky temporary directory protects the caller-owned child.
    const uid = process.getuid?.();
    if (
      uid !== undefined &&
      ((stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000)))
    )
      throw new RuntimeError(
        "UNSAFE_DIRECTORY",
        "Projection ancestors must be owned by this user or root and not writable by other users",
      );
  }
  return path;
}
export function readSafe(path: string, max = 30 * 1024 * 1024): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new RuntimeError("UNSAFE_FILE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writeAtomic(path: string, data: string | Uint8Array): void {
  const parent = safeDirectory(dirname(path));
  if (existsSync(path) && !lstatSync(path).isFile())
    throw new RuntimeError("UNSAFE_FILE");
  const temp = join(parent, `.skillplane-write-${randomUUID()}`);
  try {
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    syncDirectory(parent);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new RuntimeError("SYMLINK_FORBIDDEN");
      if (entry.isDirectory()) walk(join(dir, entry.name), name + "/");
      else if (entry.isFile()) result[name] = hash(readSafe(join(dir, entry.name)));
      else throw new RuntimeError("UNSAFE_FILE");
    }
  };
  if (lstatSync(root).isSymbolicLink()) throw new RuntimeError("SYMLINK_FORBIDDEN");
  walk(root, "");
  return result;
}
