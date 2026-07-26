import {
  BracketsCurlyIcon as BracketsCurly,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  FolderOpenIcon as FolderOpen,
  IdentificationCardIcon as IdentificationCard,
  PathIcon as Path,
  ShieldCheckIcon as ShieldCheck,
} from "phosphor-svelte";

export const SITE_ORIGIN = "https://skillplane.dev";
export const APP_ORIGIN = "https://app.skillplane.dev";

export const PRIMARY_NAVIGATION = [
  { label: "How it works", href: "/#workflow" },
  { label: "Capabilities", href: "/#capabilities" },
  { label: "Security", href: "/#security" },
  { label: "Explore skills", href: "/skills" },
] as const;

export const WORKFLOW_STEPS = [
  {
    number: "01",
    title: "Create",
    description:
      "Package instructions and supporting files into a validated skill bundle.",
  },
  {
    number: "02",
    title: "Contextualize",
    description:
      "Keep project-specific knowledge beside the core skill without forking it.",
  },
  {
    number: "03",
    title: "Retrieve",
    description: "Agents request the published skill and relevant context through MCP.",
  },
  {
    number: "04",
    title: "Amend",
    description:
      "Agents propose evidence-backed improvements with declared caller details.",
  },
  {
    number: "05",
    title: "Review",
    description: "Humans inspect the diff, learning metadata, and policy decision.",
  },
  {
    number: "06",
    title: "Publish",
    description: "An approved amendment becomes a new immutable semantic version.",
  },
] as const;

export const PRODUCT_CAPABILITIES = [
  {
    icon: ClockCounterClockwise,
    title: "Versioned by design",
    description:
      "Published versions are immutable. Every candidate retains its source, diff, and review decision.",
  },
  {
    icon: FolderOpen,
    title: "Context without copies",
    description:
      "Maintain project or customer knowledge under one reusable skill, with agent notes per context.",
  },
  {
    icon: BracketsCurly,
    title: "MCP-native access",
    description:
      "Retrieve, search, amend, and maintain context through tools designed for authenticated AI agents.",
  },
  {
    icon: IdentificationCard,
    title: "Caller provenance",
    description:
      "Retrievals and amendments require agent, model, client, run, and represented-user declarations.",
  },
  {
    icon: Path,
    title: "Controlled learning",
    description:
      "Amendments carry observations, evidence, confidence, validation results, and the context that informed them.",
  },
  {
    icon: ShieldCheck,
    title: "Auditable operations",
    description:
      "Authorization decisions, reads, writes, reviews, and publication events are recorded for investigation and analytics.",
  },
] as const;

export const SECURITY_PRACTICES = [
  "OAuth-protected MCP with workspace-scoped permissions",
  "Explicit private, workspace, and public visibility",
  "Immutable published versions and reviewable candidates",
  "Tenant filters applied before search ranking",
  "Private responses marked no-store",
  "Postgres through Cloudflare Hyperdrive and skill bundles in R2",
] as const;

export const TRUTHFUL_PRODUCT_CLAIMS = [
  "Skillplane stores validated, versioned AI skill bundles.",
  "Agents retrieve published skills and propose amendments through MCP.",
  "Context knowledge and notes remain scoped to their skill and workspace.",
  "Public pages expose published skill content, never candidates or context notes.",
] as const;
