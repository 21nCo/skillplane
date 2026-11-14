import { SvelteSet } from "svelte/reactivity";
import { apiRequest, SkillplaneApiError } from "../api/client.js";

export const OAUTH_CONNECTIONS_PATH = "/api/v1/me/oauth-connections";

/** One MCP client the signed-in user authorized, as listed by the API. */
export interface OAuthConnection {
  readonly consentId: string;
  readonly clientId: string;
  /** The registered client name, or the client ID when none was registered. */
  readonly clientName: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  /**
   * When the newest token for this connection was issued (the last code
   * exchange or refresh). Skillplane does not record each MCP request.
   */
  readonly lastTokenIssuedAt: string | null;
}

export type ConnectionsRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export type RevokeOutcome = "revoked" | "failed" | "ignored";

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof SkillplaneApiError ? error.message : fallback;
}

/**
 * State for Account → Connected apps. A revoke hides the row at once and only
 * drops it from the list after the API confirms. A failed revoke shows the row
 * again in its original position, because hiding never reorders the list.
 */
export class ConnectedApps {
  readonly #request: ConnectionsRequest;
  readonly #removing = new SvelteSet<string>();
  #loadSequence = 0;

  connections = $state<OAuthConnection[]>([]);
  status = $state<"loading" | "ready" | "error">("loading");
  loadError = $state<string | null>(null);
  revokeError = $state<string | null>(null);
  announcement = $state("");

  readonly visible = $derived(
    this.connections.filter((connection) => !this.#removing.has(connection.consentId)),
  );

  constructor(request: ConnectionsRequest = apiRequest) {
    this.#request = request;
  }

  isRemoving(consentId: string): boolean {
    return this.#removing.has(consentId);
  }

  async load(): Promise<void> {
    const sequence = ++this.#loadSequence;
    this.status = "loading";
    this.loadError = null;
    try {
      const data = await this.#request<{ connections: OAuthConnection[] }>(
        OAUTH_CONNECTIONS_PATH,
      );
      if (sequence !== this.#loadSequence) return;
      this.connections = data.connections;
      this.status = "ready";
    } catch (error) {
      if (sequence !== this.#loadSequence) return;
      this.loadError = failureMessage(error, "Connected apps could not be loaded.");
      this.status = "error";
    }
  }

  /**
   * Revokes one connection. The row leaves the visible list synchronously, so
   * the caller can move focus before the request settles.
   */
  async revoke(consentId: string): Promise<RevokeOutcome> {
    const connection = this.connections.find(
      (candidate) => candidate.consentId === consentId,
    );
    if (!connection || this.#removing.has(consentId)) return "ignored";
    this.#removing.add(consentId);
    this.revokeError = null;
    this.announcement = "";
    try {
      await this.#request<undefined>(
        `${OAUTH_CONNECTIONS_PATH}/${encodeURIComponent(consentId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      // 404 means this user has no such connection any more, which is the
      // state the revoke asked for.
      if (!(error instanceof SkillplaneApiError && error.status === 404)) {
        this.#removing.delete(consentId);
        this.revokeError = `${connection.clientName} is still connected. ${failureMessage(
          error,
          "The connection could not be revoked.",
        )}`;
        return "failed";
      }
    }
    this.connections = this.connections.filter(
      (candidate) => candidate.consentId !== consentId,
    );
    this.#removing.delete(consentId);
    this.announcement = `Revoked access for ${connection.clientName}.`;
    return "revoked";
  }
}
