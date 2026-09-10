import assert from "node:assert/strict";
import { it } from "node:test";
import { createR2ConditionalWriter } from "./lib/r2-conditional-create.mjs";
import { WranglerR2MigrationStore } from "./lib/wrangler-r2-migration-store.mjs";

const credentials = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  SKILLPLANE_R2_ACCESS_KEY_ID: "test-only-access-key",
  SKILLPLANE_R2_SECRET_ACCESS_KEY: "test-only-signing-material",
};

it("signs conditional writes and preserves the winner of competing publications", async () => {
  const objects = new Map();
  const writer = createR2ConditionalWriter(credentials, async (request) => {
    assert.equal(request.headers.get("if-none-match"), "*");
    assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 /u);
    const key = decodeURIComponent(new URL(request.url).pathname);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (objects.has(key)) return new Response(null, { status: 412 });
    objects.set(key, bytes);
    return new Response(null, { status: 200 });
  });
  const store = new WranglerR2MigrationStore("test-bucket", {
    conditionalWriter: writer,
  });
  store.read = async (key) => objects.get(`/test-bucket/${key}`);
  store.put = async () => assert.fail("Must never fall back to unconditional PUT");
  const key = "public/workspace:one/bundle.zip";
  const bytes = new Uint8Array([1, 2, 3]);
  const results = await Promise.all([
    store.putIfAbsent({ key, bytes }),
    store.putIfAbsent({ key, bytes }),
  ]);
  assert.deepEqual(results.sort(), ["created", "exists"]);
  await assert.rejects(
    store.putIfAbsent({ key, bytes: new Uint8Array([9]) }),
    /R2_MIGRATION_OBJECT_CONFLICT/u,
  );
  assert.deepEqual(await store.read(key), bytes);
});

it("fails closed on missing credentials and provider errors", async () => {
  assert.throws(() => createR2ConditionalWriter({}), /CREDENTIALS_REQUIRED/u);
  const writer = createR2ConditionalWriter(
    credentials,
    async () => new Response(null, { status: 403 }),
  );
  await assert.rejects(
    writer("test-bucket", "public/key", new Uint8Array([1])),
    /FAILED:403/u,
  );
});
