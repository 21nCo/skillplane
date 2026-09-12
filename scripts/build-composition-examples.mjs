import { format } from "prettier";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeBundleFiles } from "../packages/storage/dist/src/index.js";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const examples = join(root, "examples/composition"),
  output = join(root, ".data/composition-examples");
await mkdir(output, { recursive: true });
for (const entry of await readdir(examples, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(examples, entry.name),
    files = new Map();
  async function collect(relative = "") {
    for (const item of await readdir(join(directory, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, item.name);
      if (item.isDirectory()) await collect(path);
      else if (!["authoring.json", "skill.json"].includes(path))
        files.set(path, new Uint8Array(await readFile(join(directory, path))));
    }
  }
  await collect();
  const skill = JSON.parse(await readFile(join(directory, "authoring.json"), "utf8"));
  const bundle = await canonicalizeBundleFiles({ skill, files });
  await writeFile(
    join(directory, "skill.json"),
    await format(new TextDecoder().decode(bundle.files.get("skill.json")), {
      parser: "json",
    }),
  );
  await writeFile(join(output, `${entry.name}.zip`), bundle.bytes);
  console.log(`${entry.name}: ${bundle.digest}`);
}
