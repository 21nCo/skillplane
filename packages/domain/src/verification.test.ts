import { describe, it, expect } from "vitest";
import { evaluateVerification, type ClaimResult } from "./verification.js";
import type { ResolvedClaim } from "./composition.js";
const claims: [ResolvedClaim] = [
  {
    id: "datafn.read-surfaces",
    namespacedId: "v:datafn/datafn.read-surfaces",
    originatingVersionId: "v:datafn",
    statement: "Every read uses DataFn",
    severity: "blocking",
    scope: "All application reads",
    requiredEvidence: [
      "read-inventory",
      "static-call-paths",
      "runtime-traces",
      "integration-tests",
    ],
    prohibitedBypasses: ["direct-database"],
    rules: {
      pass: "Every surface accounted for",
      fail: "A bypass",
      unknown: "Unaccounted surface",
    },
  },
];
const evidence = (type: string) => ({
  type,
  uri: "urn:sha256:abc",
  sha256: "a".repeat(64),
  description: type,
  redacted: true as const,
});
const pass: ClaimResult = {
  claimId: claims[0].namespacedId,
  status: "pass",
  explanation: "Every read traced and independently verified",
  evidence: claims[0].requiredEvidence.map(evidence),
};
describe("DataFn attestation gate", () => {
  it("rejects scaffold-only evidence and unaccounted surfaces", () => {
    expect(
      evaluateVerification(claims, [
        { ...pass, evidence: [evidence("package-installation")] },
      ]),
    ).toBe("unknown");
    expect(evaluateVerification(claims, [])).toBe("unknown");
  });
  it("fails bypasses even if other claims pass", () => {
    expect(evaluateVerification(claims, [{ ...pass, status: "fail" }])).toBe("fail");
  });
  it("requires every declared kind of evidence", () => {
    for (const type of claims[0].requiredEvidence)
      expect(
        evaluateVerification(claims, [
          { ...pass, evidence: pass.evidence.filter((e) => e.type !== type) },
        ]),
      ).toBe("unknown");
    expect(evaluateVerification(claims, [pass])).toBe("pass");
  });
  it("keeps advisory unknowns visible without blocking", () => {
    expect(evaluateVerification([{ ...claims[0], severity: "advisory" }], [])).toBe(
      "pass",
    );
  });
});
