import { z } from "zod";

export const PRODUCTION_APP_AUTHORITY = "https://app.skillplane.dev";
export const PRODUCTION_MCP_RESOURCE = "https://mcp.skillplane.dev/mcp";

const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/u);
const regionId = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const bindingName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u);
function secureOrLoopback(parsed: URL): boolean {
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))
  );
}

const authority = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    secureOrLoopback(parsed) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    parsed.pathname === "/"
  );
}, "must be a secure or loopback origin without credentials, path, query, or fragment");
const mcpResource = z.url().refine((value) => {
  const parsed = new URL(value);
  return (
    secureOrLoopback(parsed) &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    parsed.pathname === "/mcp"
  );
}, "must be a secure or loopback /mcp resource URL");

const cellSchema = z
  .object({
    regionId,
    placement: z
      .object({
        displayName: z.string().trim().min(1).max(80),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .strict()
      .optional(),
    databaseBinding: bindingName,
    objectStorageBinding: bindingName,
    appServiceBinding: bindingName,
    mcpServiceBinding: bindingName,
    publiclyRoutable: z.literal(false),
  })
  .strict();

const topologySchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["single-cell", "multi-cell"]),
    public: z
      .object({
        appAuthority: authority,
        mcpResource,
      })
      .strict(),
    controlPlane: z
      .object({
        regionId,
        databaseBinding: bindingName,
        publicObjectStorageBinding: bindingName,
        issuer: authority,
        oauthResource: mcpResource,
      })
      .strict(),
    cells: z.array(cellSchema).min(1),
    routing: z
      .object({
        activeKeyId: identifier,
        verificationKeyIds: z.array(identifier).min(1),
        assertionAudience: identifier,
        assertionTtlSeconds: z.number().int().min(1).max(60),
      })
      .strict(),
  })
  .strict();

export type SkillplaneTopologyManifest = z.infer<typeof topologySchema>;
export type RegionalCellManifest = SkillplaneTopologyManifest["cells"][number];

export type TopologyErrorCode =
  | "TOPOLOGY_INVALID"
  | "TOPOLOGY_DUPLICATE_REGION"
  | "TOPOLOGY_DUPLICATE_BINDING"
  | "TOPOLOGY_REGION_COUNT_INVALID"
  | "TOPOLOGY_RESERVED_REGION"
  | "TOPOLOGY_ISSUER_DRIFT"
  | "TOPOLOGY_KEY_ROTATION_INVALID";

export class TopologyError extends Error {
  readonly code: TopologyErrorCode;
  readonly fields: readonly string[];

  constructor(code: TopologyErrorCode, message: string, fields: readonly string[]) {
    super(message);
    this.name = "TopologyError";
    this.code = code;
    this.fields = fields;
  }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found].sort();
}

function parseTopologyManifestInternal(
  input: unknown,
  options: {
    readonly production?: boolean;
    readonly compatibilityMode?: boolean;
  } = {},
): SkillplaneTopologyManifest {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new TopologyError(
        "TOPOLOGY_INVALID",
        "The topology manifest is not valid JSON",
        ["SKILLPLANE_TOPOLOGY"],
      );
    }
  }
  const parsed = topologySchema.safeParse(raw);
  if (!parsed.success) {
    throw new TopologyError(
      "TOPOLOGY_INVALID",
      "The topology manifest violates its schema",
      parsed.error.issues.map((issue) => issue.path.join(".") || "manifest"),
    );
  }
  const manifest = parsed.data;
  if (
    !options.compatibilityMode &&
    (manifest.controlPlane.regionId === "legacy" ||
      manifest.cells.some((cell) => cell.regionId === "legacy"))
  ) {
    throw new TopologyError(
      "TOPOLOGY_RESERVED_REGION",
      "The legacy compatibility region ID is reserved",
      ["controlPlane.regionId", "cells.regionId"],
    );
  }
  const duplicateRegions = duplicates(manifest.cells.map((cell) => cell.regionId));
  if (
    duplicateRegions.length > 0 ||
    manifest.cells.some((cell) => cell.regionId === manifest.controlPlane.regionId)
  ) {
    throw new TopologyError(
      "TOPOLOGY_DUPLICATE_REGION",
      "Control-plane and regional cell IDs must be unique",
      ["controlPlane.regionId", "cells.regionId"],
    );
  }
  if (
    (manifest.mode === "multi-cell" && manifest.cells.length < 2) ||
    (manifest.mode === "single-cell" && manifest.cells.length !== 1)
  ) {
    throw new TopologyError(
      "TOPOLOGY_REGION_COUNT_INVALID",
      "The topology mode does not match its regional cell count",
      ["mode", "cells"],
    );
  }
  const allBindings = [
    manifest.controlPlane.databaseBinding,
    manifest.controlPlane.publicObjectStorageBinding,
    ...manifest.cells.flatMap((cell) => [
      cell.databaseBinding,
      cell.objectStorageBinding,
      cell.appServiceBinding,
      cell.mcpServiceBinding,
    ]),
  ];
  if (duplicates(allBindings).length > 0) {
    throw new TopologyError(
      "TOPOLOGY_DUPLICATE_BINDING",
      "Every database, storage, and service binding must have one owner",
      ["controlPlane", "cells"],
    );
  }
  if (
    manifest.public.appAuthority !== manifest.controlPlane.issuer ||
    manifest.public.mcpResource !== manifest.controlPlane.oauthResource ||
    (options.production &&
      (manifest.public.appAuthority !== PRODUCTION_APP_AUTHORITY ||
        manifest.public.mcpResource !== PRODUCTION_MCP_RESOURCE))
  ) {
    throw new TopologyError(
      "TOPOLOGY_ISSUER_DRIFT",
      "Public authorities and the control-plane OAuth identity must be canonical",
      ["public", "controlPlane.issuer", "controlPlane.oauthResource"],
    );
  }
  const keyIds = new Set(manifest.routing.verificationKeyIds);
  if (!keyIds.has(manifest.routing.activeKeyId) || keyIds.size > 3) {
    throw new TopologyError(
      "TOPOLOGY_KEY_ROTATION_INVALID",
      "The active routing key must be in the bounded verification keyring",
      ["routing.activeKeyId", "routing.verificationKeyIds"],
    );
  }
  return manifest;
}

export function parseTopologyManifest(
  input: unknown,
  options: { readonly production?: boolean } = {},
): SkillplaneTopologyManifest {
  return parseTopologyManifestInternal(input, options);
}

export function createSingleCellTopology(input: {
  readonly appAuthority: string;
  readonly mcpResource: string;
  readonly controlDatabaseBinding?: string;
  readonly publicObjectStorageBinding?: string;
  readonly regionId?: string;
  readonly regionalDatabaseBinding?: string;
  readonly regionalObjectStorageBinding?: string;
}): SkillplaneTopologyManifest {
  return parseTopologyManifestInternal(
    {
      version: 1,
      mode: "single-cell",
      public: {
        appAuthority: input.appAuthority,
        mcpResource: input.mcpResource,
      },
      controlPlane: {
        regionId: "global",
        databaseBinding: input.controlDatabaseBinding ?? "CONTROL_HYPERDRIVE",
        publicObjectStorageBinding:
          input.publicObjectStorageBinding ?? "PUBLIC_SKILL_BUNDLES",
        issuer: input.appAuthority,
        oauthResource: input.mcpResource,
      },
      cells: [
        {
          regionId: input.regionId ?? "local",
          placement: {
            displayName: "Local",
            latitude: 0,
            longitude: 0,
          },
          databaseBinding: input.regionalDatabaseBinding ?? "CELL_HYPERDRIVE",
          objectStorageBinding:
            input.regionalObjectStorageBinding ?? "CELL_SKILL_BUNDLES",
          appServiceBinding: "CELL_APP",
          mcpServiceBinding: "CELL_MCP",
          publiclyRoutable: false,
        },
      ],
      routing: {
        activeKeyId: "current",
        verificationKeyIds: ["current"],
        assertionAudience: "skillplane-cell",
        assertionTtlSeconds: 20,
      },
    },
    { compatibilityMode: true },
  );
}
