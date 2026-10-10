import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";

const assignmentPattern =
  /^(?<prefix>\s*(?:export\s+)?)(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u;

function validateAssignment(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`Invalid local Worker variable name: ${name}`);
  }
  if (typeof value !== "string" || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} must be a single-line string`);
  }
}

export function readWorkerDevelopmentVariables(source) {
  const assignments = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = assignmentPattern.exec(line);
    if (!match?.groups) continue;
    const { name, value } = match.groups;
    if (assignments.has(name)) {
      throw new Error(`${name} is assigned more than once`);
    }
    assignments.set(name, value);
  }
  return assignments;
}

export function mergeWorkerDevelopmentVariables(source, updates) {
  const normalized = Object.entries(updates);
  for (const [name, value] of normalized) {
    validateAssignment(name, value);
  }

  const pending = new Map(normalized);
  const managedNames = new Set(pending.keys());
  const seen = new Set();
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source ? source.split(/\r?\n/u) : [];
  const hadTrailingNewline = source.endsWith("\n");
  if (hadTrailingNewline) lines.pop();

  const merged = lines.map((line) => {
    const match = assignmentPattern.exec(line);
    if (!match?.groups || !managedNames.has(match.groups.name)) return line;
    const { name, prefix } = match.groups;
    if (seen.has(name)) {
      throw new Error(`${name} is assigned more than once`);
    }
    seen.add(name);
    const value = pending.get(name);
    pending.delete(name);
    return `${prefix}${name}=${value}`;
  });

  if (pending.size > 0 && merged.length > 0 && merged.at(-1)?.trim() !== "") {
    merged.push("");
  }
  for (const [name, value] of pending) {
    merged.push(`${name}=${value}`);
  }

  if (merged.length === 0) return "";
  return `${merged.join(newline)}${newline}`;
}

async function existingSource(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function updateWorkerDevelopmentVariables(path, updates) {
  const source = await existingSource(path);
  const merged = mergeWorkerDevelopmentVariables(source, updates);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, merged, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    path,
    updated: Object.keys(updates).sort(),
    preserved: [...readWorkerDevelopmentVariables(source).keys()]
      .filter((name) => !(name in updates))
      .sort(),
    mode: "0600",
  };
}
