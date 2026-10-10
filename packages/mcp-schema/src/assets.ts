import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  digestSchema,
  fileDigestSchema,
  skillSelectorSchema,
  stableIdSchema,
  timestampSchema,
  versionSelectorSchema,
} from "./common.js";

export const skillAssetRetrieveInputSchema = z
  .object({
    skill: skillSelectorSchema,
    version: versionSelectorSchema,
    path: z.string().min(1).max(240),
    responseMode: z.enum(["auto", "inline", "download"]).default("auto"),
    caller: callerDeclarationSchema,
  })
  .strict();

const assetBaseShape = {
  requestId: z.string().min(1).max(200),
  skillId: stableIdSchema,
  versionId: stableIdSchema,
  path: z.string().min(1).max(240),
  mediaType: z.string().min(1).max(160),
  byteSize: z.number().int().nonnegative(),
  sha256: fileDigestSchema,
  bundleDigest: digestSchema,
} as const;

interface AssetBaseOutput {
  readonly requestId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly bundleDigest: `sha256:${string}`;
}

export type SkillAssetRetrieveOutput =
  | (AssetBaseOutput & {
      readonly delivery: "text";
      readonly text: string;
    })
  | (AssetBaseOutput & {
      readonly delivery: "base64";
      readonly base64: string;
    })
  | (AssetBaseOutput & {
      readonly delivery: "authenticated_download";
      readonly url: string;
      readonly expiresAt: string;
    });

// MCP tool output schemas must be rooted at an object for the stable SDK to
// advertise and validate them. The refinement preserves the discriminated
// delivery contract while still producing a root object JSON Schema.
export const skillAssetRetrieveOutputSchema = z
  .object({
    ...assetBaseShape,
    delivery: z.enum(["text", "base64", "authenticated_download"]),
    text: z.string().optional(),
    base64: z.string().optional(),
    url: z.url().max(4_096).optional(),
    expiresAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.delivery === "text"
        ? ["text"]
        : value.delivery === "base64"
          ? ["base64"]
          : ["url", "expiresAt"];
    const fields = ["text", "base64", "url", "expiresAt"] as const;
    for (const field of fields) {
      const present = value[field] !== undefined;
      if (expected.includes(field) !== present) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Field ${field} does not match ${value.delivery} delivery`,
        });
      }
    }
  }) as z.ZodType<SkillAssetRetrieveOutput>;

export type SkillAssetRetrieveInput = z.infer<typeof skillAssetRetrieveInputSchema>;
