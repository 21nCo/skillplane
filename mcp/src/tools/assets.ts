import type {
  SkillAssetRetrieveInput,
  SkillAssetRetrieveOutput,
} from "@skillplane/mcp-schema";
import { McpToolError } from "@skillplane/mcp-schema";
import { normalizeBundlePath } from "@skillplane/storage";
import { signDownloadGrant } from "../downloads.js";
import { loadExactCanonicalBundle } from "./retrieve.js";
import { resolveSkill, resolveVersion } from "./resolve.js";
import { executeReadTool, type McpToolRuntime } from "./shared.js";

const TEXT_INLINE_LIMIT = 128 * 1024;
const BINARY_INLINE_LIMIT = 256 * 1024;
const DOWNLOAD_TTL_MS = 5 * 60 * 1_000;

function isTextMediaType(mediaType: string): boolean {
  const base = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base.startsWith("text/") ||
    [
      "application/json",
      "application/yaml",
      "application/xml",
      "application/toml",
    ].includes(base)
  );
}

function base64(bytes: Uint8Array): string {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(value);
}

export function skillAssetRetrieve(
  runtime: McpToolRuntime,
  input: SkillAssetRetrieveInput,
) {
  return executeReadTool(
    runtime,
    "skill_asset_retrieve",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: true,
      });
      const version = await resolveVersion(runtime, execution, skill, input.version);
      const path = normalizeBundlePath(input.path);
      const bundle = await loadExactCanonicalBundle(runtime, version);
      const bytes = bundle.files.get(path);
      const descriptor = bundle.manifest.files.find((file) => file.path === path);
      if (!bytes || !descriptor) {
        throw new McpToolError(
          "SKILL_FILE_NOT_FOUND",
          "The requested skill asset was not found",
          { status: 404 },
        );
      }
      const common = {
        requestId: execution.requestId,
        skillId: skill.id,
        versionId: version.id,
        path,
        mediaType: descriptor.mediaType,
        byteSize: descriptor.byteSize,
        sha256: descriptor.sha256,
        bundleDigest: version.digest,
      } as const;
      const text = isTextMediaType(descriptor.mediaType);
      const inlineLimit = text ? TEXT_INLINE_LIMIT : BINARY_INLINE_LIMIT;
      const shouldDownload =
        input.responseMode === "download" ||
        (input.responseMode === "auto" && bytes.byteLength > inlineLimit);
      let output: SkillAssetRetrieveOutput;
      if (shouldDownload) {
        const expiresAt = new Date(runtime.now().getTime() + DOWNLOAD_TTL_MS);
        const token = await signDownloadGrant(
          {
            version: 1,
            workspaceId: skill.workspaceId,
            skillId: skill.id,
            versionId: version.id,
            path,
            fileSha256: descriptor.sha256,
            bundleDigest: version.digest,
            credentialId: runtime.identity.credentialId,
            requestId: execution.requestId,
            caller: input.caller,
            expiresAt: expiresAt.getTime(),
          },
          runtime.downloadSecret,
        );
        output = {
          ...common,
          delivery: "authenticated_download",
          url: `${runtime.origin}/downloads/${token}`,
          expiresAt: expiresAt.toISOString(),
        };
      } else {
        if (bytes.byteLength > inlineLimit) {
          throw new McpToolError(
            "ASSET_TOO_LARGE",
            "The asset is too large for inline MCP delivery",
          );
        }
        if (text) {
          let decoded: string;
          try {
            decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new McpToolError(
              "R2_OBJECT_MISMATCH",
              "The text asset is not valid UTF-8",
              { status: 503, retryable: true },
            );
          }
          output = { ...common, delivery: "text", text: decoded };
        } else {
          output = { ...common, delivery: "base64", base64: base64(bytes) };
        }
      }
      return { output };
    },
  );
}
