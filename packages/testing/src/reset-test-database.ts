import { resetTestDatabase } from "./postgres.js";

const databaseUrl = await resetTestDatabase();
const parsed = new URL(databaseUrl);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      host: parsed.hostname,
      port: Number(parsed.port),
      database: parsed.pathname.slice(1),
      migrations: "applied",
    },
    null,
    2,
  )}\n`,
);
