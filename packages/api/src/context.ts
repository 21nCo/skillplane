import type { AuthFnSession } from "authfn";
import type { SkillplaneAuthServer } from "@skillplane/auth";
import type { RuntimeBindings } from "@skillplane/config";
import type { DatabaseClient } from "@skillplane/db";
import type { Principal } from "@skillplane/domain";
import type {
  ContextKnowledgeService,
  ContextNoteService,
  ContextService,
  AmendmentPolicyService,
  AmendmentReviewService,
  AmendmentService,
  PublicationService,
  SkillSearchService,
  SkillService,
  SkillVersionService,
} from "@skillplane/domain";
import type { DatafnServer } from "@datafn/server";
import type { SkillplaneDatafnContext } from "@skillplane/datafn";
import type { SkillplaneSendFn } from "@skillplane/email";
import type { R2BundleRepository } from "@skillplane/storage";
import type { PublicSkillProjectionService } from "./public-projections.js";
import type { WorkspaceRegionCandidate } from "@skillplane/control-plane";

export interface ApiServices {
  /** Regional workspace database, or the combined database in compatibility mode. */
  readonly database: DatabaseClient;
  /** Global identity, membership, OAuth, placement, and projection authority. */
  readonly controlDatabase: DatabaseClient;
  readonly workspaceRegions: readonly string[];
  readonly workspaceRegionCandidates: readonly WorkspaceRegionCandidate[];
  readonly deploymentRole: "single" | "gateway" | "control" | "cell";
  readonly auth: SkillplaneAuthServer;
  readonly email: SkillplaneSendFn | null;
  readonly datafn: DatafnServer<SkillplaneDatafnContext>;
  readonly tenancySecret: string;
  readonly bundleStorage: R2BundleRepository;
  readonly publicProjectionService: PublicSkillProjectionService | null;
  readonly skillService: SkillService;
  readonly amendmentService: AmendmentService;
  readonly amendmentPolicyService: AmendmentPolicyService;
  readonly amendmentReviewService: AmendmentReviewService;
  readonly skillVersionService: SkillVersionService;
  readonly publicationService: PublicationService;
  readonly skillSearchService: SkillSearchService;
  readonly contextService: ContextService;
  readonly contextKnowledgeService: ContextKnowledgeService;
  readonly contextNoteService: ContextNoteService;
}

export interface ApiVariables {
  requestId: string;
  startedAt: number;
  services: ApiServices | null;
  session: AuthFnSession | null;
  servicePrincipal: Principal | null;
  principal: Principal | null;
}

export interface ApiEnvironment {
  Bindings: RuntimeBindings;
  Variables: ApiVariables;
}

export interface ApiServiceProvider {
  (bindings: RuntimeBindings): Promise<ApiServices>;
  readonly release?: (services: ApiServices) => Promise<void>;
}
