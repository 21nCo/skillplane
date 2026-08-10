import { encodeSessionId, type PostHog } from "@posthog/mcp";
import { describe, expect, it, vi } from "vitest";
import {
  createPostHogResolver,
  flushPostHog,
  isPostHogSessionId,
} from "./analytics.js";

describe("PostHog MCP analytics", () => {
  it("distinguishes analytics tokens from stateful session identifiers", () => {
    const token = encodeSessionId({
      sessionId: "ses_fixture",
      clientName: "fixture-client",
      clientVersion: "1.0.0",
      protocolVersion: "2025-11-25",
    });

    expect(isPostHogSessionId(token)).toBe(true);
    expect(isPostHogSessionId("stale-attacker-controlled-session")).toBe(false);
  });

  it("keeps analytics disabled until both runtime bindings are present", () => {
    const resolvePostHog = createPostHogResolver(undefined);

    expect(resolvePostHog({})).toBeNull();
    expect(
      resolvePostHog({ POSTHOG_PROJECT_TOKEN: "phc_fixture_project_token" }),
    ).toBeNull();
    expect(resolvePostHog({ POSTHOG_HOST: "https://us.i.posthog.com" })).toBeNull();
  });

  it("flushes outside the response lifetime when waitUntil is available", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn();

    await flushPostHog({ flush } as unknown as PostHog, waitUntil);

    expect(flush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });
});
