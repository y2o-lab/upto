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

describe("database statement deadlines", () => {
  it("bounds runtime statements and connection acquisition", () => {
    expect(createPoolConfig("postgres://dummy:dummy@localhost/upto_collector_test")).toMatchObject({
      statement_timeout: 15000,
      connectionTimeoutMillis: 10000,
    });
    expect(
      createPoolConfig("postgres://dummy:dummy@localhost/upto_collector_test", {
        statementTimeoutMs: 500,
        connectionTimeoutMs: 400,
      }),
    ).toMatchObject({ statement_timeout: 500, connectionTimeoutMillis: 400 });
  });
  it.each([0, -1, NaN, Infinity, 15001, 1.5])(
    "rejects invalid statement timeout %s",
    (statementTimeoutMs) => {
      expect(() =>
        createPoolConfig("postgres://dummy:dummy@localhost/upto_collector_test", {
          statementTimeoutMs,
        }),
      ).toThrow("statementTimeoutMs");
    },
  );
});
