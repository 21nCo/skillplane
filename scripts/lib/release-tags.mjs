import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import semver from "semver";

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
  const version = match.groups.version;
  if (semver.parse(version)?.raw !== version) {
    throw new Error(
      `Unsupported Cloudflare version: ${version}. Expected exact SemVer within the supported numeric range.`,
    );
  }
  return { tag: normalizedTag, version };
}

/** Compare two exact SemVer strings. */
export function compareReleaseVersions(left, right) {
  if (semver.parse(left)?.raw !== left || semver.parse(right)?.raw !== right) {
    throw new Error("Release versions must be exact SemVer values");
  }
  return semver.compare(left, right);
}

/** Compare two validated Cloudflare release tags using SemVer precedence. */
export function compareCloudflareReleaseTags(leftTag, rightTag) {
  const left = resolveCloudflareRelease(leftTag).version;
  const right = resolveCloudflareRelease(rightTag).version;
  return compareReleaseVersions(left, right);
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

/** Return the highest release tag recorded in the durable deployment ledger. */
export function highestCloudflareReleaseTag(tags) {
  if (!Array.isArray(tags)) {
    throw new Error("Cloudflare release ledger must be an array");
  }
  return tags.reduce((highest, tag) => {
    resolveCloudflareRelease(tag);
    return highest === null || compareCloudflareReleaseTags(tag, highest) > 0
      ? tag
      : highest;
  }, null);
}

/** Verify the requested release against active and partially applied releases. */
export function assertCloudflareProductionOrder({
  requestedTag,
  deployedTag,
  ledgerTags,
  allowLegacyBootstrap = false,
}) {
  resolveCloudflareRelease(requestedTag);
  const ledgerTag = highestCloudflareReleaseTag(ledgerTags);
  if (ledgerTag) assertCloudflareReleaseOrder(ledgerTag, requestedTag);
  if (deployedTag !== null) {
    let recognizedRelease = false;
    try {
      resolveCloudflareRelease(deployedTag);
      recognizedRelease = true;
    } catch {
      if (!allowLegacyBootstrap || ledgerTag !== null) {
        throw new Error(
          "The active production Worker has no recognized release tag; the protected legacy bootstrap override is allowed only before the first recorded tagged release",
        );
      }
    }
    if (recognizedRelease) {
      assertCloudflareReleaseOrder(deployedTag, requestedTag);
    }
  }
  return { deployedTag, ledgerTag, requestedTag };
}

/** Resolve the sole active version from Wrangler's latest deployment. */
export function activeCloudflareVersionId(deployments) {
  if (!Array.isArray(deployments)) {
    throw new Error("Wrangler deployments output must be an array");
  }
  if (deployments.length === 0) return null;
  const versions = deployments.at(-1)?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("Wrangler's active deployment omitted its versions");
  }
  const activeVersions = versions.filter(
    (version) => Number(version?.percentage) === 100,
  );
  if (activeVersions.length !== 1) {
    throw new Error("The active Worker uses split traffic; release order is ambiguous");
  }
  const [active] = activeVersions;
  if (typeof active.version_id !== "string" || active.version_id.trim().length === 0) {
    throw new Error("The active Worker returned an invalid version id");
  }
  return active.version_id;
}

/** Decide whether a package channel can advance to the requested version. */
export function packagePublishDecision(publishedVersion, requestedVersion) {
  if (publishedVersion === undefined) {
    compareReleaseVersions(requestedVersion, requestedVersion);
    return { publish: true, publishedVersion, requestedVersion };
  }
  const comparison = compareReleaseVersions(requestedVersion, publishedVersion);
  if (comparison < 0) {
    throw new Error(
      `${requestedVersion} is older than published channel version ${publishedVersion}`,
    );
  }
  if (comparison === 0 && requestedVersion !== publishedVersion) {
    throw new Error(
      `${requestedVersion} does not advance published channel version ${publishedVersion}`,
    );
  }
  return {
    publish: comparison > 0,
    publishedVersion,
    requestedVersion,
  };
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
