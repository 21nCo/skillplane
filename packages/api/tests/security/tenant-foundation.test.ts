import { WorkspaceAccessError } from "@skillplane/domain";
import { describe, expect, it } from "vitest";

describe("tenant-foundation", () => {
  it("uses the same nonleaking error for absent and unauthorized workspaces", () => {
    const absent = new WorkspaceAccessError();
    const unauthorized = new WorkspaceAccessError();
    expect({
      code: absent.code,
      status: absent.status,
      message: absent.message,
    }).toEqual({
      code: unauthorized.code,
      status: unauthorized.status,
      message: unauthorized.message,
    });
    expect(absent.message).not.toMatch(/permission|membership|denied/i);
  });
});
