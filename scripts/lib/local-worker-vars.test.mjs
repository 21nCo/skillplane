import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  mergeWorkerDevelopmentVariables,
  readWorkerDevelopmentVariables,
  updateWorkerDevelopmentVariables,
} from "./local-worker-vars.mjs";

describe("local Worker development variables", () => {
  it("updates owned database values without deleting auth or comments", () => {
    const source = [
      "# local auth",
      "AUTHFN_SECRET=stable-secret",
      "DATABASE_URL=postgresql://old",
      "CUSTOM_VALUE=preserved",
      "",
    ].join("\n");

    const merged = mergeWorkerDevelopmentVariables(source, {
      RUNTIME_ENV: "local",
      DATABASE_ADAPTER: "postgres",
      DATABASE_URL: "postgresql://new",
    });

    assert.match(merged, /^# local auth$/mu);
    assert.match(merged, /^AUTHFN_SECRET=stable-secret$/mu);
    assert.match(merged, /^CUSTOM_VALUE=preserved$/mu);
    assert.match(merged, /^DATABASE_URL=postgresql:\/\/new$/mu);
    assert.doesNotMatch(merged, /postgresql:\/\/old/u);
  });

  it("rejects duplicate managed assignments instead of choosing one", () => {
    assert.throws(
      () =>
        mergeWorkerDevelopmentVariables(
          "DATABASE_URL=postgresql://one\nDATABASE_URL=postgresql://two\n",
          { DATABASE_URL: "postgresql://new" },
        ),
      /DATABASE_URL is assigned more than once/u,
    );
  });

  it("reads assignments without interpreting comments as values", () => {
    const values = readWorkerDevelopmentVariables(
      "# AUTHFN_SECRET=commented\nexport AUTHFN_SECRET=real\n",
    );
    assert.deepEqual([...values], [["AUTHFN_SECRET", "real"]]);
  });

  it("writes atomically with private permissions and rejects symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skillplane-vars-"));
    const path = join(directory, ".dev.vars");
    await updateWorkerDevelopmentVariables(path, { RUNTIME_ENV: "local" });
    await chmod(path, 0o644);
    await updateWorkerDevelopmentVariables(path, {
      DATABASE_URL: "postgresql://skillplane:test@127.0.0.1:5703/skillplane",
    });

    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /^RUNTIME_ENV=local$/mu);

    const link = join(directory, ".dev.vars.link");
    await symlink(path, link);
    await assert.rejects(
      updateWorkerDevelopmentVariables(link, { RUNTIME_ENV: "local" }),
      /must be a regular file/u,
    );
  });
});
