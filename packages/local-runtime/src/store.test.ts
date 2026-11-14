import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local store", () => {
  it("waits for another process's database lock when it opens", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-store-")));
    roots.push(root);
    new LocalStore(root).close();
    // Another Skillplane process holds the database lock briefly, as one does
    // while it writes or checkpoints the WAL on close.
    const holder = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; DELETE FROM kv WHERE key='absent';");
         process.stdout.write("held");
         setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
        join(root, "runtime.sqlite"),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise((done) => holder.on("close", done));
    await new Promise((held) => holder.stdout.once("data", held));
    const store = new LocalStore(root);
    expect(store.get("installation")).toEqual(expect.any(String));
    store.close();
    expect(await exited).toBe(0);
  });
});
