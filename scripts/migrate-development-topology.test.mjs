import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { migrateDevelopmentTopology } from "./migrate-development-topology.mjs";
import {
  developmentTopologyDatabases,
  schemaHeadStatus,
} from "./lib/development-topology-deployment.mjs";
import { root } from "./lib/production-deployment.mjs";
import {
  accountListing,
  developmentAccountId,
  developmentCloudflareVariables,
} from "./lib/cloudflare-accounts-fixture.mjs";

// `.invalid` hosts never resolve: a refusal message, rather than ENOTFOUND,
// proves the command stopped before opening a connection.
const developmentUrls = {
  SKILLPLANE_DEV_CONTROL_DATABASE_URL:
    "postgresql://dev:secret@control.dev.invalid:5432/skillplane_control",
  SKILLPLANE_DEV_DATABASE_URL:
    "postgresql://dev:secret@insouth.dev.invalid:5432/skillplane",
  SKILLPLANE_DEV_USEAST_DATABASE_URL:
    "postgresql://dev:secret@useast.dev.invalid:5432/skillplane",
  SKILLPLANE_DEV_EUWEST_DATABASE_URL:
    "postgresql://dev:secret@euwest.dev.invalid:5432/skillplane",
};

// Production identities that match none of the development URLs, so the
// production URL variable comparison is the check under test.
const unrelatedProductionIdentities =
  "control.prod.invalid/skillplane_control insouth.prod.invalid/skillplane";

// Every run passes the development Cloudflare token preflight against a
// stubbed account listing, so the database checks are the ones under test.
async function withEnvironment(values, operation) {
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = accountListing([developmentAccountId]);
  for (const name of Object.keys(process.env)) {
    if (
      /^(SKILLPLANE_|RAILWAY_DATABASE_URL$|GITHUB_ACTIONS$|PGHOST$|PGPORT$)/u.test(name)
    )
      Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, developmentCloudflareVariables, values);
  try {
    return await operation();
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of Object.keys(process.env))
      Reflect.deleteProperty(process.env, name);
    Object.assign(process.env, saved);
  }
}

describe("development topology migration safety", () => {
  for (const [productionVariable, developmentVariable] of [
    ["SKILLPLANE_CONTROL_DATABASE_URL", "SKILLPLANE_DEV_CONTROL_DATABASE_URL"],
    ["SKILLPLANE_CELL_IN_SOUTH_DATABASE_URL", "SKILLPLANE_DEV_DATABASE_URL"],
    ["SKILLPLANE_CELL_US_EAST_DATABASE_URL", "SKILLPLANE_DEV_USEAST_DATABASE_URL"],
    ["SKILLPLANE_PRODUCTION_DATABASE_URL", "SKILLPLANE_DEV_EUWEST_DATABASE_URL"],
  ]) {
    it(`refuses a development URL equal to ${productionVariable} before connecting`, async () => {
      let migrations = 0;
      await withEnvironment(
        {
          ...developmentUrls,
          SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: unrelatedProductionIdentities,
          // The same database with a different password and SSL mode.
          [productionVariable]: developmentUrls[developmentVariable]
            .replace(":secret@", ":production@")
            .concat("?sslmode=verify-full"),
        },
        () =>
          assert.rejects(
            migrateDevelopmentTopology({
              migrate: async () => {
                migrations += 1;
              },
            }),
            new RegExp(`must differ from ${productionVariable}$`, "u"),
          ),
      );
      assert.equal(migrations, 0);
    });
  }

  it("connects to the configured databases when no production URL matches", async () => {
    let migrations = 0;
    await withEnvironment(
      {
        ...developmentUrls,
        SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: unrelatedProductionIdentities,
        SKILLPLANE_CELL_US_EAST_DATABASE_URL:
          "postgresql://prod:secret@useast.prod.invalid:5432/skillplane",
      },
      () =>
        assert.rejects(
          migrateDevelopmentTopology({
            migrate: async () => {
              migrations += 1;
            },
          }),
          /ENOTFOUND|EAI_AGAIN|getaddrinfo/u,
        ),
    );
    assert.equal(migrations, 0);
  });
});

// The development deploy job's environment: the four development URLs, the
// production identities variable (empty when unset), and no production URLs.
function workflowEnvironment(identities) {
  return {
    ...developmentUrls,
    GITHUB_ACTIONS: "true",
    SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: identities,
  };
}

async function rejectsBeforeMigrating(environment, expected) {
  let migrations = 0;
  await withEnvironment(environment, () =>
    assert.rejects(
      migrateDevelopmentTopology({
        migrate: async () => {
          migrations += 1;
        },
      }),
      expected,
    ),
  );
  assert.equal(migrations, 0);
}

const isolationUnconfigured =
  /^Error: PRODUCTION_ISOLATION_UNCONFIGURED: SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES /u;

// An operator's machine: `.env.development.local` supplies the four development
// URLs, GITHUB_ACTIONS is unset, and production URLs live elsewhere if at all.
describe("development topology migration production isolation on a local host", () => {
  it("refuses before connecting when no production identities are configured", () =>
    rejectsBeforeMigrating({ ...developmentUrls }, isolationUnconfigured));

  it("refuses without identities even when a production URL variable is set", async () => {
    // Neither a matching nor an unrelated production URL substitutes for the
    // identities: the refusal comes before any URL comparison.
    for (const productionUrl of [
      developmentUrls.SKILLPLANE_DEV_CONTROL_DATABASE_URL,
      "postgresql://prod:secret@control.prod.invalid:5432/skillplane_control",
    ]) {
      await rejectsBeforeMigrating(
        { ...developmentUrls, SKILLPLANE_CONTROL_DATABASE_URL: productionUrl },
        isolationUnconfigured,
      );
    }
  });

  it("refuses with GITHUB_ACTIONS set to anything but true", () =>
    rejectsBeforeMigrating(
      { ...developmentUrls, GITHUB_ACTIONS: "false" },
      isolationUnconfigured,
    ));

  it("refuses before validating the development URLs", () =>
    rejectsBeforeMigrating(
      { ...developmentUrls, SKILLPLANE_DEV_CONTROL_DATABASE_URL: "not a url" },
      isolationUnconfigured,
    ));

  it("connects when the identities are configured and none matches", () =>
    rejectsBeforeMigrating(
      {
        ...developmentUrls,
        SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: unrelatedProductionIdentities,
      },
      /ENOTFOUND|EAI_AGAIN|getaddrinfo/u,
    ));
});

describe("development topology migration production isolation in GitHub Actions", () => {
  for (const [label, identities] of [
    ["unset", ""],
    ["blank", " , \n"],
  ]) {
    it(`refuses before connecting when the production identities are ${label}`, () =>
      rejectsBeforeMigrating(workflowEnvironment(identities), isolationUnconfigured));
  }

  it("refuses a development URL that matches a production identity before connecting", () =>
    rejectsBeforeMigrating(
      workflowEnvironment(
        "control.prod.invalid/skillplane_control,\nUsEast.Dev.Invalid:5432/skillplane",
      ),
      /^Error: The us-east development database must differ from SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES$/u,
    ));

  it("matches a production identity that omits the default port", () =>
    rejectsBeforeMigrating(
      workflowEnvironment("control.dev.invalid/skillplane_control"),
      /must differ from SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES$/u,
    ));

  it("refuses identities that carry credentials or a URL", async () => {
    for (const identities of [
      "postgresql://prod:secret@control.prod.invalid/skillplane",
      "prod:secret@control.prod.invalid/skillplane",
      "control.prod.invalid",
    ]) {
      await rejectsBeforeMigrating(
        workflowEnvironment(identities),
        /^Error: SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES entries must be host\[:port\]\/database without credentials$/u,
      );
    }
  });

  it("connects when the identities are configured and none matches", () =>
    rejectsBeforeMigrating(
      workflowEnvironment(
        "control.prod.invalid:5432/skillplane_control insouth.prod.invalid/skillplane",
      ),
      /ENOTFOUND|EAI_AGAIN|getaddrinfo/u,
    ));
});

// The production database every destination-changing form below reaches.
// The driver (pg-connection-string) lets query `host` and `port` override the
// URL authority and decodes a percent-encoded host, so an authority-only
// comparison would see a development host while the driver connects here.
const productionTarget = "prod.invalid:5432/skillplane";
const destinationChangingForms = [
  [
    "a query host",
    (url) => url.replace(/@[^/]+\//u, "@dev.invalid:5432/") + "?host=prod.invalid",
  ],
  [
    "a query port",
    (url) => url.replace(/@[^/]+\//u, "@prod.invalid:15432/") + "?port=5432",
  ],
  [
    "a percent-encoded host",
    (url) => url.replace(/@[^/]+\//u, "@%70rod.invalid:5432/"),
  ],
];
const destinationAmbiguous = /^Error: DEVELOPMENT_DATABASE_DESTINATION_AMBIGUOUS: /u;

describe("development topology migration compares the driver's destination", () => {
  for (const variable of Object.keys(developmentUrls)) {
    for (const [form, rewrite] of destinationChangingForms) {
      it(`refuses ${form} in ${variable} before connecting`, async () => {
        const environment = {
          ...developmentUrls,
          SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: `control.prod.invalid/skillplane_control ${productionTarget}`,
          [variable]: rewrite(developmentUrls[variable]).replace(
            /\/skillplane(?:_control)?(?=\?|$)/u,
            "/skillplane",
          ),
        };
        await rejectsBeforeMigrating(environment, destinationAmbiguous);
        await withEnvironment(environment, () =>
          assert.throws(() => developmentTopologyDatabases(), destinationAmbiguous),
        );
      });
    }
  }

  it("refuses a numeric or trailing-dot host before connecting", async () => {
    for (const host of ["2130706433", "0x7f.1", "control.dev.invalid."]) {
      await rejectsBeforeMigrating(
        {
          ...developmentUrls,
          SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: unrelatedProductionIdentities,
          SKILLPLANE_DEV_CONTROL_DATABASE_URL: `postgresql://dev:secret@${host}:5432/skillplane_control`,
        },
        destinationAmbiguous,
      );
    }
  });

  it("refuses a URL without a port when PGPORT moves the driver elsewhere", () =>
    rejectsBeforeMigrating(
      {
        ...developmentUrls,
        SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: unrelatedProductionIdentities,
        SKILLPLANE_DEV_USEAST_DATABASE_URL:
          "postgresql://dev:secret@useast.dev.invalid/skillplane",
        PGPORT: "6543",
      },
      destinationAmbiguous,
    ));

  it("compares a production URL variable by the driver's destination too", () =>
    rejectsBeforeMigrating(
      {
        ...developmentUrls,
        SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: unrelatedProductionIdentities,
        SKILLPLANE_CONTROL_DATABASE_URL:
          "postgresql://prod:secret@elsewhere.invalid:5432/skillplane?host=euwest.dev.invalid",
      },
      /^Error: The eu-west development database must differ from SKILLPLANE_CONTROL_DATABASE_URL$/u,
    ));

  it("matches a production identity written with a trailing dot", () =>
    rejectsBeforeMigrating(
      workflowEnvironment("control.dev.invalid.:5432/skillplane_control"),
      /must differ from SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES$/u,
    ));

  it("still connects to plain development URLs that match no production target", () =>
    rejectsBeforeMigrating(
      {
        ...developmentUrls,
        SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: `control.prod.invalid/skillplane_control ${productionTarget}`,
      },
      /ENOTFOUND|EAI_AGAIN|getaddrinfo/u,
    ));
});

// Both sides of the production comparison reduce to one canonical destination.
// A production target spelled any other way could never equal an accepted
// development URL, so it is refused instead of silently counting as isolation.
describe("development topology migration requires canonical production targets", () => {
  const nonCanonicalHosts = ["2130706433", "0x7f.1", "0177.0.0.1", "127.1"];

  for (const identity of [
    "2130706433:5432/skillplane",
    "0x7f.1/skillplane",
    "0177.0.0.1/skillplane",
    "127.1/skillplane",
  ]) {
    it(`refuses the production identity ${identity} before connecting`, () =>
      rejectsBeforeMigrating(
        workflowEnvironment(`control.prod.invalid/skillplane_control ${identity}`),
        new RegExp(
          `^Error: SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES entries must name their host in canonical form: ${identity.replaceAll(".", "\\.")}$`,
          "u",
        ),
      ));
  }

  it("refuses a production URL variable with a non-canonical host before connecting", async () => {
    for (const host of nonCanonicalHosts) {
      await rejectsBeforeMigrating(
        {
          ...workflowEnvironment(unrelatedProductionIdentities),
          SKILLPLANE_CONTROL_DATABASE_URL: `postgresql://prod:secret@${host}:5432/skillplane`,
        },
        /^Error: PRODUCTION_DATABASE_DESTINATION_AMBIGUOUS: SKILLPLANE_CONTROL_DATABASE_URL must name its host in canonical form$/u,
      );
    }
  });

  it("refuses a production URL variable whose driver destination is non-canonical", () =>
    rejectsBeforeMigrating(
      {
        ...workflowEnvironment(unrelatedProductionIdentities),
        SKILLPLANE_CELL_EU_WEST_DATABASE_URL:
          "postgresql://prod:secret@euwest.prod.invalid:5432/skillplane?host=2130706433",
      },
      /^Error: PRODUCTION_DATABASE_DESTINATION_AMBIGUOUS: SKILLPLANE_CELL_EU_WEST_DATABASE_URL must name its host in canonical form$/u,
    ));

  it("refuses a dotted-quad development URL equal to a dotted-quad production identity", () =>
    rejectsBeforeMigrating(
      {
        ...workflowEnvironment("127.0.0.1:5432/skillplane"),
        SKILLPLANE_DEV_USEAST_DATABASE_URL:
          "postgresql://dev:secret@127.0.0.1:5432/skillplane",
      },
      /^Error: The us-east development database must differ from SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES$/u,
    ));

  it("still connects when canonical production targets match no development URL", () =>
    rejectsBeforeMigrating(
      {
        ...workflowEnvironment(
          "10.0.0.1:5432/skillplane control.prod.invalid./skillplane_control",
        ),
        SKILLPLANE_CONTROL_DATABASE_URL:
          "postgresql://prod:secret@Control.Prod.Invalid.:5432/skillplane_control",
      },
      /ENOTFOUND|EAI_AGAIN|getaddrinfo/u,
    ));
});

// pg sends startup parameters as NUL-terminated strings, so an encoded control
// character in any URL component can add a second `database` key that the
// server uses. Each form names a database other than the production target
// while sending the production target's name on the wire.
const controlCharacterForms = [
  [
    "the database path",
    "postgresql://dev:secret@prod.invalid:5432/skillplane%00application_name%00x",
  ],
  [
    "application_name",
    "postgresql://dev:secret@prod.invalid:5432/dev_only?application_name=x%00database%00skillplane",
  ],
  [
    "fallback_application_name",
    "postgresql://dev:secret@prod.invalid:5432/dev_only?fallback_application_name=x%00database%00skillplane",
  ],
  [
    "options",
    "postgresql://dev:secret@prod.invalid:5432/dev_only?options=x%00database%00skillplane",
  ],
  [
    "an encoded query key",
    "postgresql://dev:secret@prod.invalid:5432/dev_only?application%5Fname=x%00database%00skillplane",
  ],
  [
    "a query key",
    "postgresql://dev:secret@prod.invalid:5432/dev_only?x%00database%00skillplane=1",
  ],
  [
    "the user",
    "postgresql://dev%00database%00skillplane:secret@prod.invalid:5432/dev_only",
  ],
  ["the password", "postgresql://dev:se%00cret@prod.invalid:5432/dev_only"],
  [
    "a newline",
    "postgresql://dev:secret@prod.invalid:5432/dev_only?application_name=x%0Ay",
  ],
  ["a DEL", "postgresql://dev:secret@prod.invalid:5432/dev_only%7F"],
];
const controlCharacterRefused =
  /^Error: DEVELOPMENT_DATABASE_DESTINATION_AMBIGUOUS: .+ must not contain a control character in its [a-z_ ]+$/u;

describe("development topology migration refuses control characters in database URLs", () => {
  for (const variable of Object.keys(developmentUrls)) {
    it(`refuses every control-character form in ${variable} before connecting`, async () => {
      for (const [form, url] of controlCharacterForms) {
        const environment = {
          ...workflowEnvironment(
            `control.prod.invalid/skillplane_control ${productionTarget}`,
          ),
          [variable]: url,
        };
        await rejectsBeforeMigrating(environment, controlCharacterRefused).catch(
          (error) => {
            throw new Error(`${form}: ${error.message}`);
          },
        );
        await withEnvironment(environment, () =>
          assert.throws(
            () => developmentTopologyDatabases(),
            controlCharacterRefused,
            form,
          ),
        );
      }
    });
  }

  it("never echoes the refused value", async () => {
    await withEnvironment(
      {
        ...workflowEnvironment(unrelatedProductionIdentities),
        SKILLPLANE_DEV_CONTROL_DATABASE_URL:
          "postgresql://dev:hunter2%00x@control.dev.invalid:5432/skillplane_control",
      },
      () =>
        assert.throws(
          () => developmentTopologyDatabases(),
          (error) =>
            /in its password$/u.test(error.message) &&
            !error.message.includes("hunter2"),
        ),
    );
  });

  it("refuses a URL with an undecodable component before connecting", () =>
    rejectsBeforeMigrating(
      {
        ...workflowEnvironment(
          `control.prod.invalid/skillplane_control ${productionTarget}`,
        ),
        SKILLPLANE_DEV_CONTROL_DATABASE_URL:
          "postgresql://dev:se%zzcret@prod.invalid:5432/dev_only?application_name=x%00database%00skillplane",
      },
      /^URIError: URI malformed$|^Error: DEVELOPMENT_DATABASE_DESTINATION_AMBIGUOUS: The development control database must not contain /u,
    ));

  it("refuses a production identity with a control character before connecting", () =>
    rejectsBeforeMigrating(
      workflowEnvironment(
        "control.prod.invalid/skillplane_control prod.invalid/skillplane%00x",
      ),
      /^Error: SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES entries must not contain a control character in its database$/u,
    ));

  it("refuses a production URL variable with a control character before connecting", async () => {
    for (const url of [
      "postgresql://prod:secret@control.prod.invalid:5432/skillplane%00x",
      "postgresql://prod:secret@control.prod.invalid:5432/skillplane?application_name=x%00database%00y",
    ]) {
      await rejectsBeforeMigrating(
        {
          ...workflowEnvironment(unrelatedProductionIdentities),
          SKILLPLANE_CONTROL_DATABASE_URL: url,
        },
        /^Error: PRODUCTION_DATABASE_DESTINATION_AMBIGUOUS: SKILLPLANE_CONTROL_DATABASE_URL must not contain a control character in its [a-z_ ]+$/u,
      );
    }
  });

  it("still connects to plain URLs with printable startup parameters", () =>
    rejectsBeforeMigrating(
      {
        ...workflowEnvironment(
          `control.prod.invalid/skillplane_control ${productionTarget}`,
        ),
        SKILLPLANE_DEV_USEAST_DATABASE_URL:
          "postgresql://dev:secret@useast.dev.invalid:5432/skillplane?application_name=dev%20migrate&options=-c%20statement_timeout%3D0",
      },
      /ENOTFOUND|EAI_AGAIN|getaddrinfo/u,
    ));
});

describe("development topology schema head status", () => {
  const migrations = [
    { id: "0001_core.sql", roles: ["combined", "control", "regional"] },
    { id: "0002_control_a.sql", roles: ["combined", "control"] },
    { id: "0003_regional_a.sql", roles: ["combined", "regional"] },
    { id: "0004_control_b.sql", roles: ["combined", "control"] },
    { id: "0005_regional_b.sql", roles: ["combined", "regional"] },
  ];

  it("reports the latest applied migration of the role and its head", () => {
    // A cell converted from the combined database still lists control migrations.
    assert.deepEqual(
      schemaHeadStatus("in-south", "regional", migrations, [
        "0001_core.sql",
        "0002_control_a.sql",
        "0003_regional_a.sql",
        "0004_control_b.sql",
      ]),
      {
        database: "in-south",
        role: "regional",
        applied: "0003_regional_a",
        head: "0005_regional_b",
        pending: ["0005_regional_b"],
      },
    );
    assert.deepEqual(
      schemaHeadStatus("control", "control", migrations, [
        "0001_core.sql",
        "0002_control_a.sql",
        "0004_control_b.sql",
      ]).pending,
      [],
    );
    assert.equal(
      schemaHeadStatus("us-east", "regional", migrations, []).applied,
      "none",
    );
  });
});

function workflowJob(text, name) {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `job ${name} is missing`);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-z][\w-]*:$/u.test(line),
  );
  return lines.slice(start, end < 0 ? undefined : end);
}

function workflowSteps(job) {
  const steps = [];
  for (const line of job) {
    const name = /^ {6}- name: (.+)$/u.exec(line)?.[1];
    if (name) steps.push({ name, lines: [] });
    else if (steps.length > 0) steps.at(-1).lines.push(line);
  }
  return steps;
}

describe("development deploy workflow", () => {
  it("migrates the topology after the dev-only guard and before deploying, only on refs/heads/dev", async () => {
    const text = await readFile(
      resolve(root, ".github", "workflows", "deploy-cloudflare-dev.yml"),
      "utf8",
    );
    const deploy = workflowJob(text, "deploy");
    assert.ok(
      deploy.includes(
        "    if: ${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/dev' }}",
      ),
    );
    // The production database identities reach every step from the job env.
    const identities = deploy.indexOf(
      "      SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES: ${{ vars.SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES }}",
    );
    assert.ok(identities > 0 && identities < deploy.indexOf("    steps:"));
    const steps = workflowSteps(deploy);
    const index = (name) => steps.findIndex((step) => step.name === name);
    const guard = index("Verify development ref and account");
    const migrate = index("Migrate development topology databases");
    const deployStep = index("Deploy development topology");
    assert.ok(guard === 0 && guard < migrate && migrate === deployStep - 1);
    assert.ok(
      steps[guard].lines.some((line) =>
        line.includes('if [[ "${GITHUB_REF}" != "refs/heads/dev" ]]; then'),
      ),
    );
    assert.ok(
      steps[migrate].lines.includes("        run: pnpm db:migrate:dev:topology"),
    );
    assert.deepEqual(
      steps[migrate].lines
        .map((line) => /^ {10}([A-Z_]+): /u.exec(line)?.[1])
        .filter(Boolean),
      [
        "SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN",
        "SKILLPLANE_DEV_CONTROL_DATABASE_URL",
        "SKILLPLANE_DEV_DATABASE_URL",
        "SKILLPLANE_DEV_USEAST_DATABASE_URL",
        "SKILLPLANE_DEV_EUWEST_DATABASE_URL",
      ],
    );
    // The token preflight refuses the release and production accounts, which
    // reach every step from the job env.
    for (const line of [
      "      SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_PROD_ACCOUNT_ID }}",
      "      SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    ]) {
      const position = deploy.indexOf(line);
      assert.ok(position > 0 && position < deploy.indexOf("    steps:"), line);
    }
    assert.ok(
      steps[deployStep].lines.includes(
        "          SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DEV_API_TOKEN }}",
      ),
    );
    assert.equal(text.split("db:migrate:dev:topology").length - 1, 1);
    assert.ok(!workflowJob(text, "build").join("\n").includes("db:migrate"));
  });
});
