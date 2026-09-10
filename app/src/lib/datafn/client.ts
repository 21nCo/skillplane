import {
  createSkillplaneDatafnClient,
  type SkillplaneDatafnClient,
} from "@skillplane/datafn/client";

export class SkillplaneDatafnReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillplaneDatafnReadError";
    this.code = code;
  }
}

function datafnError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  if (cause && typeof cause === "object") {
    const record = cause as { readonly code?: unknown; readonly message?: unknown };
    if (typeof record.message === "string") {
      return new SkillplaneDatafnReadError(
        typeof record.code === "string" ? record.code : "DATAFN_QUERY_FAILED",
        record.message,
      );
    }
  }
  return new SkillplaneDatafnReadError(
    "DATAFN_QUERY_FAILED",
    "Skillplane could not load workspace data",
  );
}

/**
 * Canonical first-party DataFn boundary. The workspace header selects the
 * requested namespace, while AuthFn and the server-side membership directory
 * remain authoritative and reject any workspace the session cannot access.
 */
export async function withWorkspaceDatafnClient<T>(
  workspaceId: string,
  operation: (client: SkillplaneDatafnClient) => Promise<T>,
): Promise<T> {
  const client = createSkillplaneDatafnClient({
    clientId: `skillplane-app:${workspaceId}`,
    namespace: workspaceId,
    remote: "/datafn",
    http: {
      credentials: "include",
      headers: { "x-skillplane-workspace-id": workspaceId },
    },
  });
  try {
    return await operation(client);
  } catch (cause) {
    throw datafnError(cause);
  } finally {
    await client.destroy();
  }
}
