import { describe, expect, it } from "vitest";
import { CredentialIssuance } from "../../src/lib/workspaces/credential-issuance.svelte.js";

describe("CredentialIssuance", () => {
  it("rejects a second create or rotate while the first request is in flight", () => {
    const issuance = new CredentialIssuance();
    expect(issuance.begin()).toBe(1);
    expect(issuance.blocked).toBe(true);
    expect(issuance.blockedReason).toBe("A credential is already being issued");
    expect(issuance.begin()).toBe(false);
  });

  it("keeps issuance blocked after a secret is shown until it is acknowledged", () => {
    const issuance = new CredentialIssuance();
    expect(issuance.begin()).toBe(1);
    issuance.succeed(1, "spk_test", "Review bot");
    expect(issuance.credential).toBe("spk_test");
    expect(issuance.credentialFor).toBe("Review bot");
    expect(issuance.issuing).toBe(false);
    expect(issuance.blocked).toBe(true);
    expect(issuance.begin()).toBe(false);
    issuance.acknowledge();
    expect(issuance.credential).toBeNull();
    expect(issuance.blocked).toBe(false);
    expect(issuance.begin()).toBe(2);
  });

  it("allows another issue after a failed attempt", () => {
    const issuance = new CredentialIssuance();
    expect(issuance.begin()).toBe(1);
    issuance.fail(1);
    expect(issuance.blocked).toBe(false);
    expect(issuance.begin()).toBe(2);
  });

  it("does not let a stale fail clear a newer in-flight issue", () => {
    const issuance = new CredentialIssuance();
    const first = issuance.begin();
    expect(first).toBe(1);
    issuance.succeed(1, "spk_old", "Old bot");
    issuance.acknowledge();
    expect(issuance.begin()).toBe(2);
    issuance.fail(1);
    expect(issuance.issuing).toBe(true);
    expect(issuance.begin()).toBe(false);
  });
});
