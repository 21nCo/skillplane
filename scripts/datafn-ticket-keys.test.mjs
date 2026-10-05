import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { validateDatafnTicketKeys } from "./lib/datafn-ticket-keys.mjs";

test("the gateway ticket signer matches the regional verification key", () => {
  const active = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const privateKey = active.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = active.publicKey.export({ type: "spki", format: "pem" });
  const previous = other.publicKey.export({ type: "spki", format: "pem" });
  const input = {
    activeKeyId: "current",
    privateKey,
    publicKeysJson: JSON.stringify({ current: publicKey, previous }),
  };
  assert.deepEqual(validateDatafnTicketKeys(input), input);
  assert.throws(
    () =>
      validateDatafnTicketKeys({
        ...input,
        publicKeysJson: JSON.stringify({ current: previous }),
      }),
    /does not match/u,
  );
  assert.throws(
    () =>
      validateDatafnTicketKeys({
        ...input,
        activeKeyId: "missing",
      }),
    /does not match/u,
  );
});

test("the gateway and every rotation key must use Ed25519", () => {
  const active = generateKeyPairSync("ed25519");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const activeInput = {
    activeKeyId: "current",
    privateKey: active.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeysJson: JSON.stringify({
      current: active.publicKey.export({ type: "spki", format: "pem" }),
      previous: rsa.publicKey.export({ type: "spki", format: "pem" }),
    }),
  };
  assert.throws(() => validateDatafnTicketKeys(activeInput), /does not match/u);
  assert.throws(
    () =>
      validateDatafnTicketKeys({
        activeKeyId: "current",
        privateKey: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
        publicKeysJson: JSON.stringify({
          current: rsa.publicKey.export({ type: "spki", format: "pem" }),
        }),
      }),
    /does not match/u,
  );
});
