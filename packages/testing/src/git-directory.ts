import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Blob {
  readonly path: string;
  readonly sha: string;
  readonly bytes: Buffer;
}

function gitSha(type: string, bytes: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * Serves a local directory through the GitHub REST endpoints the public Git
 * source provider reads (ref, commit, recursive tree and blobs), so a test can
 * import an exported tree with the production discovery and validation rules.
 * The commit and tree identities are derived from the directory contents.
 */
export function directoryGitHubFetcher(root: string): typeof fetch {
  const blobs: Blob[] = [];
  const directories: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => (left.name < right.name ? -1 : 1),
    )) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        directories.push(path);
        walk(join(directory, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        const bytes = readFileSync(join(directory, entry.name));
        blobs.push({ path, sha: gitSha("blob", bytes), bytes });
      } else throw new Error(`Unsupported directory entry ${path}`);
    }
  };
  walk(root, "");
  const listing = blobs.map((blob) => `${blob.path}\0${blob.sha}\n`).join("");
  const treeSha = gitSha("tree", Buffer.from(listing));
  const commitSha = gitSha("commit", Buffer.from(`tree ${treeSha}\n`));
  const tree = [
    ...directories.map((path) => ({
      path,
      mode: "040000",
      type: "tree",
      sha: gitSha("tree", Buffer.from(path)),
    })),
    ...blobs.map((blob) => ({
      path: blob.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
      size: blob.bytes.length,
    })),
  ];
  const json = (value: unknown) => new Response(JSON.stringify(value));
  return (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const route = url.pathname.split("/").slice(4).join("/");
    if (route.startsWith("commits/")) return Promise.resolve(new Response(commitSha));
    if (route === `git/commits/${commitSha}`)
      return Promise.resolve(json({ sha: commitSha, tree: { sha: treeSha } }));
    if (route === `git/trees/${treeSha}`)
      return Promise.resolve(json({ sha: treeSha, truncated: false, tree }));
    const blob = blobs.find((b) => route === `git/blobs/${b.sha}`);
    if (blob)
      return Promise.resolve(
        json({
          sha: blob.sha,
          encoding: "base64",
          content: blob.bytes.toString("base64"),
        }),
      );
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
}
