import { afterEach, describe, expect, it } from "vitest";

import { closeDefaultDb, createPoolConfig, getDb } from "./client";

describe("database client", () => {
  afterEach(async () => {
    await closeDefaultDb();
  });

  it("uses a bounded pool and TLS for a remote database", () => {
    const config = createPoolConfig("postgres://user:password@db.example.com:5432/postgres", {
      max: 3,
    });

    expect(config).toMatchObject({
      allowExitOnIdle: true,
      connectionString: "postgres://user:password@db.example.com:5432/postgres",
      max: 3,
      ssl: { rejectUnauthorized: true },
    });
  });

  it("does not require TLS for local development databases", () => {
    const config = createPoolConfig("postgres://upto:upto@localhost:5432/upto");

    expect(config.ssl).toBeUndefined();
  });

  it("preserves SSL configuration supplied in the connection string", () => {
    const config = createPoolConfig(
      "postgres://user:password@db.example.com:5432/postgres?sslmode=require",
    );

    expect(config.ssl).toBeUndefined();
  });

  it("uses an explicitly trusted CA for a remote database", () => {
    const config = createPoolConfig(
      "postgres://user:password@db.example.com:5432/postgres?sslmode=verify-full&sslrootcert=/unavailable/ca.crt",
      { sslCa: "-----BEGIN CERTIFICATE-----\\ncertificate\\n-----END CERTIFICATE-----" },
    );

    expect(config).toMatchObject({
      connectionString: "postgres://user:password@db.example.com:5432/postgres",
      ssl: {
        ca: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
        rejectUnauthorized: true,
      },
    });
  });

  it("reuses the default database client within one process", () => {
    const databaseUrl = "postgres://upto:upto@localhost:5432/upto";

    expect(getDb(databaseUrl)).toBe(getDb(databaseUrl));
  });
});
