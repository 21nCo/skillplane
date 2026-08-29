import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserLaunchCommand,
  deleteDynamicRegistration,
  registrationManagement,
  waitForOAuthCallback,
} from "./test-local-oauth.mjs";

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

describe("dynamic registration cleanup", () => {
  it("accepts McpFn registrations without a management endpoint", () => {
    assert.equal(
      registrationManagement(
        { client_id: "dynamic-client" },
        "https://app-dev.skillplane.dev",
      ),
      undefined,
    );
  });

  it("requires management credentials to be returned as a valid pair", () => {
    assert.throws(
      () =>
        registrationManagement(
          { registration_access_token: "a".repeat(32) },
          "https://app-dev.skillplane.dev",
        ),
      /incomplete management credentials/u,
    );
    assert.deepEqual(
      registrationManagement(
        {
          registration_access_token: "a".repeat(32),
          registration_client_uri:
            "https://app-dev.skillplane.dev/oauth/register/dynamic-client",
        },
        "https://app-dev.skillplane.dev",
      ),
      {
        accessToken: "a".repeat(32),
        clientUri: "https://app-dev.skillplane.dev/oauth/register/dynamic-client",
      },
    );
  });

  it("deletes only the verifier's dynamic client and closes the pool", async () => {
    const calls = [];
    class FakePool {
      constructor(options) {
        calls.push(["construct", options]);
      }

      async query(statement, parameters) {
        calls.push(["query", statement, parameters]);
        return { rowCount: 1 };
      }

      async end() {
        calls.push(["end"]);
      }
    }

    await deleteDynamicRegistration(
      "postgresql://skillplane@database.example/skillplane",
      "dynamic-client",
      { Pool: FakePool },
    );

    assert.deepEqual(calls[0], [
      "construct",
      {
        connectionString: "postgresql://skillplane@database.example/skillplane",
        max: 1,
      },
    ]);
    assert.match(calls[1][1], /source = 'dynamic'/u);
    assert.deepEqual(calls[1][2], ["dynamic-client"]);
    assert.deepEqual(calls[2], ["end"]);
  });

  it("fails when the dynamic client was not deleted", async () => {
    let ended = false;
    class FakePool {
      async query() {
        return { rowCount: 0 };
      }

      async end() {
        ended = true;
      }
    }

    await assert.rejects(
      deleteDynamicRegistration("postgresql://database.example/skillplane", "missing", {
        Pool: FakePool,
      }),
      /OAuth client cleanup failed/u,
    );
    assert.equal(ended, true);
  });
});
