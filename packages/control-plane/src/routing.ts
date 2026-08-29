import {
  createDatafnGatewayRouter,
  createMemoryDatafnRoutingReplayStore,
  validateDatafnPlacement,
  type DatafnGatewayRouter,
  type DatafnRoutingAssertionVerifier,
  type DatafnRoutingEvent,
  type DatafnRoutingReplayStore,
} from "@datafn/server";
import type {
  WorkspacePlacement,
  WorkspacePlacementDirectory,
  WorkspaceRoutingAssertionSigner,
} from "./placement.js";

export interface RegionalCellTarget {
  readonly regionId: string;
  readonly fetch: (request: Request) => Promise<Response>;
}

export interface RegionalCellRegistry {
  resolve(input: {
    readonly regionId: string;
    readonly destinationRef?: string;
    readonly placement: WorkspacePlacement;
  }): Promise<RegionalCellTarget> | RegionalCellTarget;
}

export interface WorkspaceGateway {
  handle(request: Request): Promise<Response>;
  invalidate(workspaceId: string): void;
  clear(): void;
}

/** Emits only the framework's pre-redacted routing dimensions. */
export function logWorkspaceRoutingEvent(
  component: "app" | "mcp" | "datafn" | "migration",
  event: DatafnRoutingEvent,
): void {
  console.info(
    JSON.stringify({
      component,
      event: `workspace.routing.${event.type}`,
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.namespaceHash ? { namespaceHash: event.namespaceHash } : {}),
      ...(event.sourceRegion ? { sourceRegion: event.sourceRegion } : {}),
      ...(event.targetRegion ? { targetRegion: event.targetRegion } : {}),
      ...(event.epoch === undefined ? {} : { epoch: event.epoch }),
      ...(event.state ? { state: event.state } : {}),
      ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
      ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.outcome ? { outcome: event.outcome } : {}),
    }),
  );
}

/**
 * Routes only after a trusted resolver has authenticated the caller and mapped
 * the request to a workspace. Raw workspace headers never decide placement.
 */
export function createWorkspaceGateway(input: {
  readonly directory: WorkspacePlacementDirectory;
  readonly resolveAuthorizedWorkspace: (request: Request) => Promise<string>;
  readonly cells: RegionalCellRegistry;
  readonly signer: WorkspaceRoutingAssertionSigner;
  readonly assertionAudience: string;
  readonly assertionTtlMs?: number;
  readonly maxBodyBytes?: number;
  readonly onEvent?: (event: DatafnRoutingEvent) => void | Promise<void>;
}): WorkspaceGateway {
  const router: DatafnGatewayRouter = createDatafnGatewayRouter({
    directory: input.directory,
    deriveNamespace: input.resolveAuthorizedWorkspace,
    cellRegistry: {
      resolve: (target) => input.cells.resolve(target),
    },
    dispatcher: {
      dispatch: ({ target, request, assertion, placement }) => {
        const headers = new Headers(request.headers);
        headers.set("x-datafn-routing-assertion", assertion);
        headers.set("x-skillplane-routed-workspace-id", placement.namespace);
        return target.fetch(
          new Request(request, {
            headers,
          }),
        );
      },
    },
    assertionSigner: input.signer,
    assertionAudience: input.assertionAudience,
    ...(input.assertionTtlMs === undefined
      ? {}
      : { assertionTtlMs: input.assertionTtlMs }),
    ...(input.maxBodyBytes === undefined ? {} : { maxBodyBytes: input.maxBodyBytes }),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  });
  return router;
}

export interface RegionalWorkspaceGuard {
  authorize(
    request: Request,
    workspaceId: string,
  ): Promise<{
    readonly request: Request;
    readonly placement: WorkspacePlacement;
    readonly epoch: number;
  }>;
}

export function createRegionalWorkspaceGuard(input: {
  readonly regionId: string;
  readonly directory: WorkspacePlacementDirectory;
  readonly verifier: DatafnRoutingAssertionVerifier;
  readonly assertionAudience: string;
  readonly replayStore?: DatafnRoutingReplayStore;
  readonly now?: () => number;
  readonly onEvent?: (event: DatafnRoutingEvent) => void | Promise<void>;
}): RegionalWorkspaceGuard {
  const replayStore =
    input.replayStore ??
    createMemoryDatafnRoutingReplayStore({
      ...(input.now ? { now: input.now } : {}),
    });
  return {
    async authorize(request, workspaceId) {
      const validated = await validateDatafnPlacement({
        namespace: workspaceId,
        regionId: input.regionId,
        request,
        runtime: {
          directory: input.directory,
          requireRoutingAssertion: true,
          assertionVerifier: input.verifier,
          replayStore,
          assertionAudience: input.assertionAudience,
          ...(input.now ? { now: input.now } : {}),
          ...(input.onEvent ? { onEvent: input.onEvent } : {}),
        },
      });
      const headers = new Headers(request.headers);
      headers.delete("x-skillplane-workspace-id");
      headers.set("x-skillplane-routed-workspace-id", workspaceId);
      headers.set("x-skillplane-routing-region", input.regionId);
      headers.set("x-skillplane-routing-epoch", String(validated.placement.epoch));
      return {
        request: new Request(request, { headers }),
        placement: validated.placement,
        epoch: validated.placement.epoch,
      };
    },
  };
}
