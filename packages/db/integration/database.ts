import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { closeDb, createDb } from "../src/client.js";
import { localTestDatabaseUrl } from "../src/testing/local-database.js";

export async function createIntegrationDatabase() {
  const url = localTestDatabaseUrl(process.env.COLLECTOR_TEST_DATABASE_URL);
  const name = `upto_collector_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), { max: 4 });
  let created = false;
  async function close() {
    await closeDb(db);
    try {
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    } finally {
      await admin.end();
    }
  }
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "drizzle",
    });
    return { db, pool: db.$client, url: url.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
