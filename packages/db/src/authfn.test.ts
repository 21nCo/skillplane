import { describe, expect, it } from "vitest";
import { authFnApiKeyPlugin } from "@authfn/api-keys";
import { authFnEmailOtpPlugin } from "@authfn/email-otp";
import { authFnMultiRegionPlugin } from "@authfn/multi-region";
import { createCoreTables } from "authfn";
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

  it("tracks the released AuthFn OTP, API-key, and multi-region plugin tables", () => {
    expect(() => assertAuthfnPluginSchemaContract()).not.toThrow();
    expect(
      [authFnEmailOtpPlugin(), authFnApiKeyPlugin(), authFnMultiRegionPlugin()]
        .flatMap(
          (plugin) =>
            plugin.schema?.({
              namespace: "authfn",
              plugins: [],
            }) ?? [],
        )
        .map((table) => table.modelName),
    ).toEqual(["otp_challenges", "api_keys", "region_profiles"]);
  });
});
