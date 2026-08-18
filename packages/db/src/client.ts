import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema";

const defaultPoolMax = 2;
const defaultDbState = globalThis as typeof globalThis & {
  __uptoDefaultDb?: { db: DbClient; databaseUrl: string };
};

export type CreateDbOptions = {
  max?: number;
  sslCa?: string;
};

export function createPoolConfig(databaseUrl: string, options: CreateDbOptions = {}): PoolConfig {
  const url = parseDatabaseUrl(databaseUrl);
  const max = options.max ?? readPoolMax(process.env.DATABASE_POOL_MAX);
  const sslMode = url.searchParams.get("sslmode");
  const sslCa = readSslCa(options.sslCa);

  if (sslMode === "disable" && !isLocalDatabase(url.hostname)) {
    throw new Error("SSL cannot be disabled for a remote database connection.");
  }

  const remoteDatabase = !isLocalDatabase(url.hostname);
  const ssl = sslCa
    ? { ca: sslCa, rejectUnauthorized: true }
    : remoteDatabase && sslMode === null
      ? { rejectUnauthorized: true }
      : undefined;

  return {
    allowExitOnIdle: true,
    connectionString: sslCa ? withoutSslConnectionParameters(url) : databaseUrl,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    max,
    maxLifetimeSeconds: 300,
    ...(ssl ? { ssl } : {}),
  };
}

export function createDb(databaseUrl = process.env.DATABASE_URL, options: CreateDbOptions = {}) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create a database client.");
  }

  const sslCa = options.sslCa ?? process.env.DATABASE_SSL_CA;
  const pool = new Pool(
    createPoolConfig(databaseUrl, {
      ...options,
      ...(sslCa === undefined ? {} : { sslCa }),
    }),
  );
  return drizzle({ client: pool, schema });
}

export type DbClient = ReturnType<typeof createDb>;

export function getDb(databaseUrl = process.env.DATABASE_URL): DbClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create a database client.");
  }

  const current = defaultDbState.__uptoDefaultDb;
  if (current) {
    if (current.databaseUrl !== databaseUrl) {
      throw new Error("DATABASE_URL changed after the default database client was created.");
    }
    return current.db;
  }

  const db = createDb(databaseUrl);
  defaultDbState.__uptoDefaultDb = { databaseUrl, db };
  return db;
}

export async function closeDb(db: DbClient): Promise<void> {
  await db.$client.end();
}

export async function closeDefaultDb(): Promise<void> {
  const current = defaultDbState.__uptoDefaultDb;
  if (!current) {
    return;
  }

  delete defaultDbState.__uptoDefaultDb;
  await closeDb(current.db);
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }
  return url;
}

function readPoolMax(value: string | undefined): number {
  if (value === undefined || value === "") {
    return defaultPoolMax;
  }

  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error("DATABASE_POOL_MAX must be a positive integer.");
  }
  return max;
}

function isLocalDatabase(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function readSslCa(value: string | undefined): string | undefined {
  const certificate = value?.trim();
  return certificate ? certificate.replaceAll("\\n", "\n") : undefined;
}

function withoutSslConnectionParameters(url: URL): string {
  const connectionUrl = new URL(url);
  for (const name of ["ssl", "sslcert", "sslkey", "sslmode", "sslrootcert"]) {
    connectionUrl.searchParams.delete(name);
  }
  return connectionUrl.toString();
}
