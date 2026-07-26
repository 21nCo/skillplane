import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations/generated",
  dbCredentials: databaseUrl ? { url: databaseUrl } : { url: "postgresql://invalid" },
  strict: true,
  verbose: true,
});
