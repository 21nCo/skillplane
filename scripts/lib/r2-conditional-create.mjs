import { AwsClient } from "aws4fetch";

/** S3 conditional writes are atomic at R2; Wrangler's get/put sequence is not. */
export function createR2ConditionalWriter(
  environment = process.env,
  transport = fetch,
) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = environment.SKILLPLANE_R2_ACCESS_KEY_ID;
  const secretAccessKey = environment.SKILLPLANE_R2_SECRET_ACCESS_KEY;
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_CONDITIONAL_CREATE_CREDENTIALS_REQUIRED");
  }
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region: "auto",
    service: "s3",
  });
  return async (bucket, key, bytes) => {
    const url = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const request = await client.sign(url, {
      method: "PUT",
      headers: { "If-None-Match": "*", "Content-Type": "application/zip" },
      body: bytes,
    });
    const response = await transport(request);
    await response.body?.cancel();
    if (response.status === 412) return "exists";
    if (!response.ok)
      throw new Error(`R2_CONDITIONAL_CREATE_FAILED:${response.status}`);
    return "created";
  };
}
