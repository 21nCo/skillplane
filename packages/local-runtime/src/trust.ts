import { stableJson, type CanonicalBundle } from "@skillplane/storage";
import { hash } from "./files.js";

/** Conservative envelope: all frontmatter, script bytes, and declared network
 * destinations are permission-bearing. Unknown metadata is never discarded. */
export interface TrustEnvelope {
  frontmatterDigest: string;
  scripts: Record<string, string>;
  network: string[];
  executionDeclarations: string[];
}
export function trustEnvelope(bundle: CanonicalBundle): TrustEnvelope {
  const body = new TextDecoder().decode(bundle.files.get("SKILL.md"));
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? "";
  const scripts: Record<string, string> = {};
  const network = new Set<string>();
  const executionDeclarations = new Set<string>();
  for (const [path, bytes] of bundle.files) {
    if (
      path.startsWith("scripts/") ||
      /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|wasm)$/i.test(
        path,
      ) ||
      new TextDecoder().decode(bytes.subarray(0, 2)) === "#!"
    )
      scripts[path] = hash(bytes);
    if (path === "skill.json") continue;
    const text = new TextDecoder().decode(bytes);
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\])}]+/g)) {
      try {
        network.add(new URL(match[0]).origin);
      } catch {
        network.add(match[0]);
      }
    }
    // Natural-language permissions cannot be fully inferred. Changes to lines
    // that declare tools, commands, network, or execution are reviewable too.
    for (const line of text.split(/\r?\n/)) {
      if (
        /\b(?:allowed.tools|permissions?|network|execute|execution|shell|bash|sudo|curl|wget|fetch|powershell|python|node|npm|npx|pnpm|agent|context|hooks?)\b/i.test(
          line,
        )
      )
        executionDeclarations.add(line.trim());
    }
  }
  return {
    frontmatterDigest: hash(frontmatter),
    scripts,
    network: [...network].sort(),
    executionDeclarations: [...executionDeclarations].sort(),
  };
}
export function trustExpands(previous: TrustEnvelope, next: TrustEnvelope): boolean {
  return (
    previous.frontmatterDigest !== next.frontmatterDigest ||
    Object.entries(next.scripts).some(
      ([path, digest]) => previous.scripts[path] !== digest,
    ) ||
    next.network.some((value) => !previous.network.includes(value)) ||
    next.executionDeclarations.some(
      (value) => !previous.executionDeclarations.includes(value),
    )
  );
}
export const trustDigest = (envelope: TrustEnvelope): string =>
  hash(stableJson(envelope));
