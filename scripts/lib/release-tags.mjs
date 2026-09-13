import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const VERSION_PATTERN =
  "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";

const packageTagPattern = new RegExp(
  `^(?<slug>[a-z0-9][a-z0-9-]*)-v(?<version>${VERSION_PATTERN})$`,
  "u",
);
const cloudflareTagPattern = new RegExp(
  "^skillplane-cloudflare-v(?<version>\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$",
  "u",
);

function requireTag(tag) {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("Expected a release tag argument or GITHUB_REF_NAME");
  }
  return tag;
}

export async function loadReleasePackages(repoRoot) {
  const manifestPath = resolve(repoRoot, "release-packages.json");
  const entries = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("release-packages.json must contain at least one target");
  }

  const slugs = new Set();
  const names = new Set();
  const targets = [];
  for (const entry of entries) {
    if (!entry?.slug || !entry?.path || !entry?.name) {
      throw new Error(`Invalid release target: ${JSON.stringify(entry)}`);
    }
    if (slugs.has(entry.slug) || names.has(entry.name)) {
      throw new Error(`Duplicate release target: ${entry.slug}`);
    }
    slugs.add(entry.slug);
    names.add(entry.name);

    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, entry.path, "package.json"), "utf8"),
    );
    if (packageJson.name !== entry.name) {
      throw new Error(
        `Release target ${entry.slug} expected ${entry.name}, found ${packageJson.name ?? "undefined"}`,
      );
    }
    if (packageJson.private === true) {
      throw new Error(`Release target ${entry.name} is private`);
    }
    targets.push({
      slug: entry.slug,
      name: entry.name,
      version: packageJson.version,
      path: entry.path,
    });
  }
  return targets;
}

export async function resolvePackageRelease(tag, repoRoot) {
  const normalizedTag = requireTag(tag);
  const match = normalizedTag.match(packageTagPattern);
  if (!match?.groups) {
    throw new Error(
      `Unsupported tag format: ${normalizedTag}. Expected <package-slug>-v<version>.`,
    );
  }
  const targets = await loadReleasePackages(repoRoot);
  const target = targets.find((candidate) => candidate.slug === match.groups.slug);
  if (!target) {
    throw new Error(
      `No publishable workspace found for slug "${match.groups.slug}". Supported slugs: ${targets.map(({ slug }) => slug).join(", ")}`,
    );
  }
  if (target.version !== match.groups.version) {
    throw new Error(
      `Tag version ${match.groups.version} does not match ${target.name}@${target.version}`,
    );
  }
  return { tag: normalizedTag, ...target };
}

export function resolveCloudflareRelease(tag) {
  const normalizedTag = requireTag(tag);
  if (normalizedTag.length > 54) {
    throw new Error("Cloudflare release tags must not exceed 54 characters");
  }
  const match = normalizedTag.match(cloudflareTagPattern);
  if (!match?.groups) {
    throw new Error(
      `Unsupported Cloudflare tag: ${normalizedTag}. Expected skillplane-cloudflare-v<version>.`,
    );
  }
  return { tag: normalizedTag, version: match.groups.version };
}

export async function writeGithubOutputs(
  outputs,
  outputPath = process.env.GITHUB_OUTPUT,
) {
  if (!outputPath) return;
  await appendFile(
    outputPath,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}
