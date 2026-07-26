import { describe, expect, it } from "vitest";
import {
  authFnApiKeyPlugin,
  authFnEmailOtpPlugin,
  createCoreTables,
} from "@authfn/core";
import {
  assertAuthfnCoreSchemaContract,
  assertAuthfnPluginSchemaContract,
} from "./authfn.js";

describe("AuthFn schema integration", () => {
  it("tracks the released AuthFn core schema exactly once", () => {
    expect(() => assertAuthfnCoreSchemaContract()).not.toThrow();
    expect(createCoreTables().map((table) => table.modelName)).toEqual([
      "users",
      "sessions",
    ]);
  });

  it("tracks the released AuthFn OTP and API-key plugin tables", () => {
    expect(() => assertAuthfnPluginSchemaContract()).not.toThrow();
    expect(
      [authFnEmailOtpPlugin(), authFnApiKeyPlugin()]
        .flatMap(
          (plugin) =>
            plugin.schema?.({
              database: {} as never,
              namespace: "authfn",
              plugins: [],
            }) ?? [],
        )
        .map((table) => table.modelName),
    ).toEqual(["otp_challenges", "api_keys"]);
  });
});
