const environmentName = "skillplane-cloudflare-release-ledger";

function configuration(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GH_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !token) {
    throw new Error("GitHub release ledger credentials are required");
  }
  return { repository, token };
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** List every release tag persisted before a production migration begins. */
export async function listCloudflareReleaseLedger(
  environment = process.env,
  transport = fetch,
) {
  const { repository, token } = configuration(environment);
  const releases = [];
  for (let page = 1; page <= 1_000; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/deployments`);
    url.searchParams.set("environment", environmentName);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await transport(url, { headers: headers(token) });
    if (!response.ok) {
      throw new Error(`GitHub release ledger read failed: ${response.status}`);
    }
    const deployments = await response.json();
    if (!Array.isArray(deployments)) {
      throw new Error("GitHub release ledger response must be an array");
    }
    for (const deployment of deployments) {
      if (
        deployment?.environment !== environmentName ||
        typeof deployment.ref !== "string"
      ) {
        throw new Error("GitHub release ledger contains an invalid deployment");
      }
      releases.push(deployment.ref);
    }
    if (deployments.length < 100) return releases;
  }
  throw new Error("GitHub release ledger exceeded its pagination limit");
}

/** Persist an accepted release before the workflow begins production mutation. */
export async function recordCloudflareRelease(
  releaseTag,
  environment = process.env,
  transport = fetch,
) {
  const { repository, token } = configuration(environment);
  const response = await transport(
    `https://api.github.com/repos/${repository}/deployments`,
    {
      method: "POST",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: releaseTag,
        task: "skillplane-cloudflare-release",
        environment: environmentName,
        description: "Skillplane Cloudflare release high-water mark",
        auto_merge: false,
        required_contexts: [],
        transient_environment: false,
        production_environment: false,
      }),
    },
  );
  if (response.status !== 201) {
    throw new Error(`GitHub release ledger write failed: ${response.status}`);
  }
  const deployment = await response.json();
  if (!Number.isInteger(deployment?.id)) {
    throw new Error("GitHub release ledger write returned an invalid deployment");
  }
  return deployment.id;
}
