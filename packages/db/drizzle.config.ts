import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DIRECT_DATABASE_URL ??
      process.env.DATABASE_URL ??
      "postgres://upto:upto@localhost:5432/upto",
  },
  out: "./drizzle",
  schema: "./src/schema.ts",
  strict: true,
  verbose: true,
});
