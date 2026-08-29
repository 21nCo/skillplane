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

  it("deletes the verifier request and dynamic client in one transaction", async () => {
    const calls = [];
    class FakePool {
      constructor(options) {
        calls.push(["construct", options]);
      }

      async connect() {
        calls.push(["connect"]);
        return {
          async query(statement, parameters) {
            calls.push(["query", statement, parameters]);
            return { rowCount: 1 };
          },
          release() {
            calls.push(["release"]);
          },
        };
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
    assert.deepEqual(calls[1], ["connect"]);
    assert.deepEqual(calls[2], ["query", "BEGIN", undefined]);
    assert.match(calls[3][1], /authfn_oauth_authorization_requests/u);
    assert.match(calls[3][1], /payload->>'clientId' = \$1/u);
    assert.deepEqual(calls[3][2], ["dynamic-client"]);
    assert.match(calls[4][1], /authfn_oauth_clients/u);
    assert.match(calls[4][1], /source = 'dynamic'/u);
    assert.deepEqual(calls[4][2], ["dynamic-client"]);
    assert.deepEqual(calls[5], ["query", "COMMIT", undefined]);
    assert.deepEqual(calls[6], ["release"]);
    assert.deepEqual(calls[7], ["end"]);
  });

  it("rolls back when the dynamic client was not deleted", async () => {
    let ended = false;
    let released = false;
    const statements = [];
    class FakePool {
      async connect() {
        return {
          async query(statement) {
            statements.push(statement);
            return {
              rowCount: statement.includes("authfn_oauth_clients") ? 0 : 1,
            };
          },
          release() {
            released = true;
          },
        };
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
    assert.deepEqual(statements.slice(-1), ["ROLLBACK"]);
    assert.equal(released, true);
    assert.equal(ended, true);
  });
});
