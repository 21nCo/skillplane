import { createPrivateKey, createPublicKey } from "node:crypto";

/** Fail before deployment if the gateway signer does not match the regional keyring. */
export function validateDatafnTicketKeys(input) {
  const { activeKeyId, privateKey, publicKeysJson } = input;
  if (typeof activeKeyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(activeKeyId)) {
    throw new Error("The DataFn ticket key ID is invalid");
  }
  let ring;
  try {
    ring = JSON.parse(publicKeysJson);
    if (
      !ring ||
      typeof ring !== "object" ||
      Array.isArray(ring) ||
      Object.keys(ring).length < 1 ||
      Object.keys(ring).length > 3 ||
      typeof ring[activeKeyId] !== "string"
    )
      throw new Error();
    const parsedPrivateKey = createPrivateKey(privateKey);
    if (parsedPrivateKey.asymmetricKeyType !== "ed25519") throw new Error();
    const derivedPublicKey = createPublicKey(parsedPrivateKey);
    if (derivedPublicKey.asymmetricKeyType !== "ed25519") throw new Error();
    const derived = derivedPublicKey.export({
      type: "spki",
      format: "der",
    });
    const configuredPublicKey = createPublicKey(ring[activeKeyId]);
    if (configuredPublicKey.asymmetricKeyType !== "ed25519") throw new Error();
    const configured = configuredPublicKey.export({
      type: "spki",
      format: "der",
    });
    if (!derived.equals(configured)) throw new Error();
    for (const publicKey of Object.values(ring)) {
      if (createPublicKey(publicKey).asymmetricKeyType !== "ed25519") throw new Error();
    }
  } catch {
    throw new Error(
      "The DataFn gateway private key does not match the regional public keyring",
    );
  }
  return { activeKeyId, privateKey, publicKeysJson };
}
