import { encodeSessionId, PostHog } from "@posthog/mcp";
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

    expect(resolvePostHog(undefined)).toBeNull();
    expect(resolvePostHog({})).toBeNull();
    expect(
      resolvePostHog({ POSTHOG_PROJECT_TOKEN: "phc_fixture_project_token" }),
    ).toBeNull();
    expect(resolvePostHog({ POSTHOG_HOST: "https://us.i.posthog.com" })).toBeNull();
  });

  it("creates and reuses an analytics client when both bindings are present", () => {
    const resolvePostHog = createPostHogResolver(undefined);
    const bindings = {
      POSTHOG_PROJECT_TOKEN: "phc_fixture_project_token_123456789",
      POSTHOG_HOST: "https://us.i.posthog.com",
    };

    const client = resolvePostHog(bindings);

    expect(client).toBeInstanceOf(PostHog);
    expect(resolvePostHog(bindings)).toBe(client);
  });

  it("flushes outside the response lifetime when waitUntil is available", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn();

    await flushPostHog({ flush } as unknown as PostHog, waitUntil);

    expect(flush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it("awaits the flush when waitUntil rejects the promise", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const waitUntil = vi.fn(() => {
      throw new Error("waitUntil unavailable");
    });

    await expect(
      flushPostHog({ flush } as unknown as PostHog, waitUntil),
    ).resolves.toBeUndefined();

    expect(flush).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("logs and swallows an asynchronous flush failure", async () => {
    const failure = new Error("flush rejected");
    const flush = vi.fn().mockRejectedValue(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      flushPostHog({ flush } as unknown as PostHog),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ component: "mcp", event: "mcp.posthog.flush.failed" }),
    );
    consoleError.mockRestore();
  });

  it("logs and swallows a synchronous flush failure", async () => {
    const flush = vi.fn(() => {
      throw new Error("flush threw");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      flushPostHog({ flush } as unknown as PostHog),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ component: "mcp", event: "mcp.posthog.flush.failed" }),
    );
    consoleError.mockRestore();
  });
});
