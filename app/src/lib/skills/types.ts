export type SkillVisibility = "private" | "workspace" | "public";
export type SkillArchiveFilter = "active" | "archived" | "all";
export type SkillVersionStatus = "draft" | "pending_review" | "published" | "rejected";
export type SemanticBump = "patch" | "minor" | "major";
export type LearningConfidence = "low" | "medium" | "high";

export interface LearningMetadata {
  readonly summary: string;
  readonly observation: string;
  readonly rationale: string;
  readonly confidence: LearningConfidence;
  readonly evidence: readonly {
    readonly kind: string;
    readonly reference: string;
    readonly description: string;
  }[];
  readonly evidenceUnavailableReason: string | null;
  readonly validation: readonly {
    readonly kind: string;
    readonly status: "passed" | "failed" | "not_run";
    readonly description: string;
  }[];
  readonly validationNotRunReason: string | null;
  readonly sourceContextId: string | null;
  readonly sourceContextRevisionId: string | null;
  readonly sourceContextDigest: string | null;
  readonly tags: readonly string[];
  readonly externalReferences: readonly {
    readonly label: string;
    readonly url: string;
  }[];
  readonly extra: Readonly<Record<string, unknown>>;
}

export interface CallerDeclaration {
  readonly agent: string;
  readonly model: string;
  readonly client: string;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
  readonly forUserId: string | null;
}

export interface AmendmentPolicyDecision {
  readonly outcome: "review_required" | "auto_publish";
  readonly reason: string;
  readonly matchedRule: number | null;
}

export interface TrustedAutoPublishRule {
  readonly credentialId: string;
  readonly requiredScopes: readonly string[];
  readonly maxBump: SemanticBump;
  readonly allowedContextIds: readonly string[];
  readonly dailyLimit: number | null;
}

export type AmendmentPolicy =
  | { readonly mode: "review_required" }
  | {
      readonly mode: "trusted_auto_publish";
      readonly rules: readonly TrustedAutoPublishRule[];
    };

export interface SkillManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
}

export interface SkillBundleManifest {
  readonly formatVersion: 1;
  readonly digest: `sha256:${string}`;
  readonly byteSize: number;
  readonly expandedByteSize: number;
  readonly fileCount: number;
  readonly files: readonly SkillManifestFile[];
}

export interface Skill {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: SkillVisibility;
  readonly currentPublishedVersionId: string | null;
  readonly currentSemanticVersion: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly revision: number;
  readonly semanticVersion: string | null;
  readonly status: SkillVersionStatus;
  readonly baseVersionId: string | null;
  readonly proposedBump: SemanticBump | null;
  readonly source: "human" | "agent_amendment" | "import";
  readonly digest: `sha256:${string}`;
  readonly byteSize: number;
  readonly manifest: SkillBundleManifest;
  readonly learningMetadata: LearningMetadata | Readonly<Record<string, never>>;
  readonly amendmentOperations: readonly {
    readonly operation: "add" | "replace" | "delete";
    readonly path: string;
    readonly expectedSha256: string | null;
    readonly resultSha256?: string | null;
  }[];
  readonly callerDeclaration: CallerDeclaration | Readonly<Record<string, never>>;
  readonly policyDecision: AmendmentPolicyDecision | Readonly<Record<string, never>>;
  readonly changeSummary: string;
  readonly createdByActorType: "user" | "service_principal" | "system";
  readonly createdByActorId: string;
  readonly createdByAgent: string | null;
  readonly createdByModel: string | null;
  readonly createdForUserId: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface SkillFileChange {
  readonly kind: "added" | "removed" | "unchanged";
  readonly value: string;
  readonly lineCount: number;
}

export interface SkillFileDiff {
  readonly path: string;
  readonly status: "added" | "removed" | "modified" | "unchanged";
  readonly fromSha256: string | null;
  readonly toSha256: string | null;
  readonly mediaType: string;
  readonly textChanges?: readonly SkillFileChange[];
  readonly truncated?: boolean;
}

export interface SkillVersionDiff {
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly files: readonly SkillFileDiff[];
}

export interface SkillPage {
  readonly skills: readonly Skill[];
  readonly nextCursor: string | null;
}

export interface PublicSkill {
  readonly skill: Skill;
  readonly version: Pick<
    SkillVersion,
    | "id"
    | "workspaceId"
    | "skillId"
    | "revision"
    | "semanticVersion"
    | "status"
    | "baseVersionId"
    | "proposedBump"
    | "source"
    | "digest"
    | "byteSize"
    | "manifest"
    | "changeSummary"
    | "publishedAt"
    | "createdAt"
  >;
}

export type AmendmentReviewStatus = "pending" | "approved" | "rejected" | "superseded";

export interface AmendmentReview {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly proposedVersionId: string;
  readonly status: AmendmentReviewStatus;
  readonly decisionReason: string | null;
  readonly policyDecision: AmendmentPolicyDecision;
  readonly requestedByActorType: "user" | "service_principal" | "system";
  readonly requestedByActorId: string;
  readonly requestedByAgent: string | null;
  readonly requestedByModel: string | null;
  readonly requestedForUserId: string | null;
  readonly reviewedByActorType: "user" | "service_principal" | "system" | null;
  readonly reviewedByActorId: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AmendmentReviewDetail {
  readonly review: AmendmentReview;
  readonly candidate: SkillVersion;
}
