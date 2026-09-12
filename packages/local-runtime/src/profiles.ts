import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { safeName, RuntimeError } from "./contracts.js";
import { type LocalStore } from "./store.js";

export interface SecretStore {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
function command(program: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", () => reject(new RuntimeError("SECRET_SERVICE_UNAVAILABLE")));
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trimEnd())
        : reject(new RuntimeError("CREDENTIAL_UNAVAILABLE")),
    );
    child.stdin.end(input);
  });
}
/** No file fallback: macOS Keychain and Linux Secret Service. Tokens travel on
 * stdin (never process arguments, logs, project files, or SQLite). */
export class OsSecretStore implements SecretStore {
  async get(key: string): Promise<string> {
    if (process.platform === "darwin")
      return command("security", [
        "find-generic-password",
        "-s",
        "dev.skillplane.client",
        "-a",
        key,
        "-w",
      ]);
    if (process.platform === "linux")
      return command("secret-tool", [
        "lookup",
        "service",
        "dev.skillplane.client",
        "account",
        key,
      ]);
    throw new RuntimeError(
      "SECRET_SERVICE_UNAVAILABLE",
      "Provide a protected SecretStore integration for this platform",
    );
  }
  async set(key: string, value: string): Promise<void> {
    if (!value || /[\r\n\0]/.test(value)) throw new RuntimeError("CREDENTIAL_INVALID");
    if (process.platform === "darwin") {
      const quote = (s: string) =>
        '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
      await command(
        "security",
        ["-i"],
        `add-generic-password -U -s dev.skillplane.client -a ${quote(key)} -w ${quote(value)}\n`,
      );
    } else if (process.platform === "linux")
      await command(
        "secret-tool",
        [
          "store",
          "--label=Skillplane",
          "service",
          "dev.skillplane.client",
          "account",
          key,
        ],
        value,
      );
    else throw new RuntimeError("SECRET_SERVICE_UNAVAILABLE");
  }
  async delete(key: string): Promise<void> {
    if (process.platform === "darwin")
      await command("security", [
        "delete-generic-password",
        "-s",
        "dev.skillplane.client",
        "-a",
        key,
      ]);
    else if (process.platform === "linux")
      await command("secret-tool", [
        "clear",
        "service",
        "dev.skillplane.client",
        "account",
        key,
      ]);
    else throw new RuntimeError("SECRET_SERVICE_UNAVAILABLE");
  }
}
export interface AccountProfile {
  alias: string;
  endpoint: string;
  accountId: string;
  credentialRef: string;
}
export class Profiles {
  constructor(
    readonly store: LocalStore,
    readonly secrets: SecretStore = new OsSecretStore(),
  ) {}
  async add(
    alias: string,
    endpoint: string,
    accountId: string,
    token: string,
  ): Promise<AccountProfile> {
    safeName.parse(alias);
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new RuntimeError("ENDPOINT_INVALID");
    if (!accountId.trim()) throw new RuntimeError("ACCOUNT_ID_REQUIRED");
    endpoint = url.href;
    const existing = this.store.get<AccountProfile>(`profile:${alias}`);
    if (
      existing &&
      (existing.endpoint !== endpoint || existing.accountId !== accountId)
    )
      throw new RuntimeError(
        "PROFILE_IDENTITY_CONFLICT",
        "Use a new alias for a different account or endpoint",
      );
    const credentialRef = createHash("sha256")
      .update(`${endpoint}\0${accountId}\0${alias}`)
      .digest("hex");
    await this.secrets.set(credentialRef, token);
    if ((await this.secrets.get(credentialRef)) !== token)
      throw new RuntimeError("CREDENTIAL_WRITE_FAILED");
    const profile = { alias, endpoint, accountId, credentialRef };
    this.store.set(`profile:${alias}`, profile);
    return profile;
  }
  get(alias: string, endpoint: string): AccountProfile {
    const profile = this.store.get<AccountProfile>(`profile:${safeName.parse(alias)}`);
    if (profile?.endpoint !== endpoint)
      throw new RuntimeError("PROFILE_IDENTITY_CONFLICT");
    return profile;
  }
  list(): AccountProfile[] {
    return this.store.entries<AccountProfile>("profile:").map(([, value]) => value);
  }
}
