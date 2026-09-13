#!/usr/bin/env node
import { requireValue } from "./contracts.js";
import type { UsageEvent } from "./analytics.js";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Runtime,
  LocalStore,
  Profiles,
  CloudWorkspaceProvider,
  RuntimeError,
  targetSchema,
  projectSchema,
  workspaceKey,
  type CreateRequest,
  type AmendRequest,
} from "./index.js";
import { readSafe } from "./files.js";
const help = `Skillplane local and cloud workspaces (Node >=22.13)
Global flags: --home DIR (private runtime state), --project DIR
  init [NAME] [--target claude|codex]    Create an offline local workspace/project
  configure FILE                       Validate and save project context
  profile add ALIAS ENDPOINT ACCOUNT   Read a credential from stdin into OS secret store
  profile list                         List named account profiles (no credentials)
  list                                 Show ordered visible catalog
  create FILE                          Create an initial published version in the primary workspace
  amend FILE                           Propose digest-checked exact-base amendment
  candidates SKILL_ID                  Inspect drafts/amendments in primary workspace
  decide FILE                          Approve/reject exact review; JSON parameters
  retrieve SKILL_ID [VERSION_ID]        Read primary workspace version
  export SKILL_ID FILE [VERSION_ID]     Export an immutable bundle
  import FILE KEY                       Import a bundle as a new local/cloud skill
  sync                                 Atomically install/update configured projections
  resolve PROJECTION_ID [--live-only|--cache-only] [--agent PRODUCT]
  approve-trust ID DIGEST               Approve exactly the reviewed pending digest
  rollback ID                          Restore and pin the previous verified version
  uninstall ID                         Remove only a verified owned projection link
  doctor [--online]                     Check ownership, divergence, pending trust, freshness
  usage                                Observed counts and coverage disclosure
  usage-upload                         Upload queued primary cloud events after consent
  usage-record FILE                    Record a local action or completion report
  usage-consent on|off                  Explicitly enable/disable local event upload
All writes route only to skillplane.json primary. Mounted sources are read-only.
`;
export async function main(args = process.argv.slice(2)): Promise<void> {
  const value = (flag: string, fallback?: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const found = args[index + 1];
    if (!found || found.startsWith("--"))
      throw new RuntimeError("ARGUMENT_REQUIRED", flag);
    args.splice(index, 2);
    return found;
  };
  const root = resolve(
    requireValue(
      value("--home", process.env.SKILLPLANE_HOME ?? join(homedir(), ".skillplane")),
    ),
  );
  const project = resolve(requireValue(value("--project", process.cwd())));
  const agent = requireValue(value("--agent", "unknown"));
  const target = value("--target");
  const [command, ...rest] = args;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log(help);
    return;
  }
  const required = (index: number): string => {
    const v = rest[index];
    if (!v) throw new RuntimeError("ARGUMENT_REQUIRED");
    return v;
  };
  const json = (path: string): unknown =>
    JSON.parse(readSafe(resolve(path), 10 * 1024 * 1024).toString());
  const store = new LocalStore(root);
  const runtime = new Runtime(store);
  let result: unknown;
  try {
    switch (command) {
      case "init":
        result = runtime.setup(
          project,
          rest[0] ?? "Personal",
          target ? [targetSchema.parse({ adapter: target })] : [],
        );
        break;
      case "configure":
        result = runtime.configure(project, json(required(0)));
        break;
      case "profile": {
        const profiles = new Profiles(store);
        if (rest[0] === "list") result = profiles.list();
        else if (rest[0] === "add") {
          if (process.stdin.isTTY)
            throw new RuntimeError(
              "CREDENTIAL_STDIN_REQUIRED",
              "Pipe the token from your credential manager; it is never a command argument",
            );
          let token = "";
          for await (const chunk of process.stdin) {
            token += String(chunk);
            if (token.length > 16384) throw new RuntimeError("CREDENTIAL_INVALID");
          }
          result = await profiles.add(
            required(1),
            required(2),
            required(3),
            token.trim(),
          );
        } else throw new RuntimeError("UNKNOWN_COMMAND");
        break;
      }
      case "list":
        result = (await runtime.catalog(runtime.project(project))).map((i) => ({
          name: i.name,
          workspace: workspaceKey(i.provider.workspace),
          skillId: i.skillId,
        }));
        break;
      case "create":
        result = await runtime.create(
          runtime.project(project),
          json(required(0)) as CreateRequest,
        );
        break;
      case "amend":
        result = await runtime.amend(
          runtime.project(project),
          json(required(0)) as AmendRequest,
        );
        break;
      case "candidates":
        result = await runtime
          .provider(runtime.project(project).primary)
          .candidates(required(0));
        break;
      case "decide": {
        const input = json(required(0)) as {
          skillId: string;
          reviewId: string;
          expectedUpdatedAt: string;
          approve: boolean;
          reason: string;
          idempotencyKey: string;
        };
        if (typeof input.approve !== "boolean")
          throw new RuntimeError("DECISION_INVALID");
        result = await runtime
          .provider(runtime.project(project).primary)
          .decide(
            input.skillId,
            input.reviewId,
            input.expectedUpdatedAt,
            input.approve,
            input.reason,
            input.idempotencyKey,
          );
        break;
      }
      case "retrieve": {
        const snapshot = await runtime
          .provider(runtime.project(project).primary)
          .retrieve(required(0), rest[1]);
        runtime.observeRead(snapshot, agent);
        result = {
          workspace: snapshot.workspace,
          skill: snapshot.skill,
          version: snapshot.version,
          instructions: new TextDecoder().decode(snapshot.bundle.files.get("SKILL.md")),
          manifest: snapshot.bundle.manifest,
        };
        break;
      }
      case "export":
        runtime.exportBundle(
          await runtime
            .provider(runtime.project(project).primary)
            .retrieve(required(0), rest[2]),
          resolve(required(1)),
        );
        result = { exported: true };
        break;
      case "import":
        result = await runtime.importBundle(
          runtime.project(project),
          readSafe(resolve(required(0))),
          required(1),
        );
        break;
      case "sync":
        result = await runtime.sync(project);
        break;
      case "resolve":
        result = await runtime.resolve(required(0), {
          liveOnly: rest.includes("--live-only"),
          cacheOnly: rest.includes("--cache-only"),
          agent,
        });
        break;
      case "approve-trust":
        runtime.projections.approve(required(0), required(1));
        result = {
          approved: required(1),
          next: "Run sync to install reviewed metadata before invoking",
        };
        break;
      case "rollback":
        result = await runtime.projections.rollback(required(0));
        break;
      case "uninstall":
        runtime.projections.uninstall(required(0));
        result = { uninstalled: required(0) };
        break;
      case "doctor":
        result = await runtime.doctor(rest.includes("--online"), project);
        break;
      case "usage":
        result = runtime.usage.report();
        break;
      case "usage-upload": {
        const workspace = runtime.project(project).primary;
        const provider = runtime.provider(workspace);
        if (!(provider instanceof CloudWorkspaceProvider))
          throw new RuntimeError(
            "CLOUD_WORKSPACE_REQUIRED",
            "Local workspace events remain local; select an explicit cloud primary to upload its events",
          );
        result = {
          uploaded: await runtime.usage.upload(async (events) => {
            const ids: string[] = [];
            for (const event of events) ids.push(await provider.reportUsage(event));
            return ids;
          }, workspaceKey(workspace)),
        };
        break;
      }
      case "usage-record": {
        const event = json(required(0)) as UsageEvent;
        if (!["skill_action_called", "skill_completion_reported"].includes(event.type))
          throw new RuntimeError("EVENT_TYPE_INVALID");
        runtime.usage.record({
          ...event,
          installationId: requireValue(store.get<string>("installation")),
          modelTrust: "caller-declared",
          confidence:
            event.type === "skill_completion_reported" ? "reported" : "observed",
        });
        result = { recorded: event.id };
        break;
      }
      case "usage-consent":
        if (!["on", "off"].includes(required(0)))
          throw new RuntimeError("CONSENT_INVALID");
        store.set("analytics:consent", rest[0] === "on");
        result = runtime.usage.report();
        break;
      default: {
        const catalog = await runtime.catalog(
          projectSchema.parse(runtime.project(project)),
        );
        const match = catalog.find((i) => i.name === command);
        if (!match) throw new RuntimeError("UNKNOWN_COMMAND");
        const snapshot = await match.provider.retrieve(match.skillId);
        runtime.observeRead(snapshot, agent, true);
        result = {
          source: "live-cli",
          version: snapshot.version,
          instructions: new TextDecoder().decode(snapshot.bundle.files.get("SKILL.md")),
        };
        break;
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    // Transport errors can contain request credentials; emit only our safe codes.
    console.error(
      JSON.stringify({
        error:
          error instanceof RuntimeError ? error.code.toLowerCase() : "request_failed",
        message:
          error instanceof RuntimeError && error.code !== "CLOUD_REQUEST_REJECTED"
            ? error.message
            : "Request failed validation or authorization; inspect inputs and run doctor",
      }),
    );
    process.exitCode = 1;
  });
}
