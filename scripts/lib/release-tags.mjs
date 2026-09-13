import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const numericIdentifier = "(?:0|[1-9]\\d*)";
const prereleaseIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const buildIdentifier = "[0-9A-Za-z-]+";
const prereleasePattern = `${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*`;
const buildPattern = `${buildIdentifier}(?:\\.${buildIdentifier})*`;

export const VERSION_PATTERN = `${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleasePattern})?(?:\\+${buildPattern})?`;

const packageTagPattern = new RegExp(
  `^(?<slug>[a-z0-9][a-z0-9-]*)-v(?<version>${VERSION_PATTERN})$`,
  "u",
);
const cloudflareTagPattern = new RegExp(
  `^skillplane-cloudflare-v(?<version>${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-${prereleasePattern})?)$`,
  "u",
);

/** Require a non-empty release tag string. */
function requireTag(tag) {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("Expected a release tag argument or GITHUB_REF_NAME");
  }
  return tag;
}

/** Load and validate every public package declared in the release manifest. */
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

/** Resolve a package tag to its exact manifest entry and npm distribution tag. */
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
  return {
    tag: normalizedTag,
    ...target,
    npmTag: match.groups.version.split("+", 1)[0].includes("-") ? "next" : "latest",
  };
}

/** Resolve and validate a Cloudflare production release tag. */
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

function comparePrerelease(left, right) {
  if (left === undefined || right === undefined) {
    if (left === right) return 0;
    return left === undefined ? 1 : -1;
  }
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/** Compare two validated Cloudflare release tags using SemVer precedence. */
export function compareCloudflareReleaseTags(leftTag, rightTag) {
  const left = resolveCloudflareRelease(leftTag).version;
  const right = resolveCloudflareRelease(rightTag).version;
  const leftPrereleaseIndex = left.indexOf("-");
  const rightPrereleaseIndex = right.indexOf("-");
  const leftCore =
    leftPrereleaseIndex === -1 ? left : left.slice(0, leftPrereleaseIndex);
  const rightCore =
    rightPrereleaseIndex === -1 ? right : right.slice(0, rightPrereleaseIndex);
  const leftPrerelease =
    leftPrereleaseIndex === -1 ? undefined : left.slice(leftPrereleaseIndex + 1);
  const rightPrerelease =
    rightPrereleaseIndex === -1 ? undefined : right.slice(rightPrereleaseIndex + 1);
  const leftParts = leftCore.split(".").map(BigInt);
  const rightParts = rightCore.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return comparePrerelease(leftPrerelease, rightPrerelease);
}

/** Reject a tagged deployment that would move production backwards. */
export function assertCloudflareReleaseOrder(deployedTag, requestedTag) {
  if (compareCloudflareReleaseTags(requestedTag, deployedTag) < 0) {
    throw new Error(
      `${requestedTag} is older than deployed release ${deployedTag}; use the production rollback procedure instead`,
    );
  }
  return { deployedTag, requestedTag };
}

/** Append single-line values to a GitHub Actions output file. */
export async function writeGithubOutputs(
  outputs,
  outputPath = process.env.GITHUB_OUTPUT,
) {
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid GitHub output name: ${key}`);
    }
    const normalizedValue = String(value);
    if (/[\r\n]/u.test(normalizedValue)) {
      throw new Error(`GitHub output ${key} must be a single-line value`);
    }
    return `${key}=${normalizedValue}`;
  });
  await appendFile(outputPath, `${lines.join("\n")}\n`);
}
