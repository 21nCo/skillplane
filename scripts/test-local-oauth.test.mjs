import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserLaunchCommand, waitForOAuthCallback } from "./test-local-oauth.mjs";

describe("local OAuth browser launch", () => {
  it("selects the platform browser launcher", () => {
    const url = "https://app-local.skillplane.dev/oauth/authorize";
    assert.deepEqual(browserLaunchCommand(url, "darwin"), {
      command: "open",
      args: [url],
    });
    assert.deepEqual(browserLaunchCommand(url, "linux"), {
      command: "xdg-open",
      args: [url],
    });
    assert.deepEqual(browserLaunchCommand(url, "win32"), {
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });
});

describe("local OAuth callback timeout", () => {
  it("clears the long-lived timeout when the callback succeeds", async () => {
    const timeoutHandle = Symbol("timeout");
    let scheduledFor;
    let clearedHandle;
    const timers = {
      setTimeout(_callback, milliseconds) {
        scheduledFor = milliseconds;
        return timeoutHandle;
      },
      clearTimeout(handle) {
        clearedHandle = handle;
      },
    };

    assert.equal(
      await waitForOAuthCallback(Promise.resolve("authorization-code"), 60_000, timers),
      "authorization-code",
    );
    assert.equal(scheduledFor, 60_000);
    assert.equal(clearedHandle, timeoutHandle);
  });

  it("rejects when the callback does not arrive", async () => {
    await assert.rejects(
      waitForOAuthCallback(new Promise(() => undefined), 1),
      /timed out after 1 ms/u,
    );
  });
});
