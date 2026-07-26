import { describe, expect, it } from "vitest";
import { skillFileResponse, type DownloadedSkillFile } from "./downloads.js";

function file(mediaType: string): DownloadedSkillFile {
  return {
    path: "assets/example.svg",
    bytes: new TextEncoder().encode("<svg></svg>"),
    sha256: "a".repeat(64),
    mediaType,
    bundleDigest: `sha256:${"b".repeat(64)}`,
  };
}

describe("skill file responses", () => {
  it("keeps private files out of caches and sandboxes active content", () => {
    const response = skillFileResponse(file("image/svg+xml"), {
      publicImmutable: false,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns a bodyless conditional response with the same digest ETag", () => {
    const expectedEtag = `"sha256-${"a".repeat(64)}"`;
    const response = skillFileResponse(file("text/markdown; charset=utf-8"), {
      publicImmutable: true,
      ifNoneMatch: expectedEtag,
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(expectedEtag);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });
});
