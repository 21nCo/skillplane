import { describe, expect, it, vi } from "vitest";
import { writeControlPlaneAuditEvent } from "./audit.js";

describe("control-plane audit writer", () => {
  it("writes global decisions to the control authority with redacted metadata", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      void text;
      void values;
      return { rows: [], rowCount: 1 };
    });

    await expect(
      writeControlPlaneAuditEvent(
        { query },
        {
          id: "control-audit:test",
          workspaceId: "workspace:one",
          eventType: "oauth.consent.granted",
          action: "oauth.consent",
          outcome: "success",
          actorType: "user",
          actorId: "user:one",
          userId: "user:one",
          requestId: "request:one",
          resourceType: "oauth_client",
          resourceId: "client:one",
          channel: "oauth",
          metadata: { access_token: "must-not-persist", scope: "skills:read" },
        },
      ),
    ).resolves.toBe("control-audit:test");

    expect(query).toHaveBeenCalledOnce();
    const [statement, values] = query.mock.calls[0] ?? [];
    expect(statement).toContain("INSERT INTO control_plane_audit_events");
    expect(statement).not.toContain("INSERT INTO audit_events");
    expect(values).toBeDefined();
    const metadata = JSON.parse(String(values?.[11])) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("access_token");
    expect(metadata).toMatchObject({
      scope: "skills:read",
      redaction: { removedFieldCount: 1 },
    });
  });
});
