import { describe, expect, it } from "vitest";

import { localTestDatabaseUrl } from "./local-database.js";

describe("local test database allowlist", () => {
  it("uses only a dedicated loopback DB by default", () => {
    const url = localTestDatabaseUrl(undefined);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/upto_collector_test");
    expect(url.port).toBe("55439");
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])("allows loopback %s", (host) => {
    expect(
      localTestDatabaseUrl(
        `postgresql://dummy:dummy@${host}:55439/upto_collector_test?sslmode=disable`,
      ).hostname,
    ).toBe(host);
  });
  it.each([
    "postgres://dummy:dummy@db.example/upto_collector_test",
    "postgres://dummy:dummy@localhost/production",
    "postgres://dummy:dummy@localhost/upto_collector_test?host=db.example",
    "postgres://dummy:dummy@localhost/upto_collector_test?options=-csearch_path=public",
    "postgres://dummy:dummy@localhost/upto_collector_test?sslmode=require",
    "postgres://dummy:dummy@localhost/upto_collector_test?sslmode=disable&sslmode=require",
    "postgres://dummy:dummy@127.0.0.2/upto_collector_test",
    "https://localhost/upto_collector_test",
    "invalid-secret-value",
  ])("rejects unsafe configuration without echoing it: %s", (input) => {
    expect(() => localTestDatabaseUrl(input)).toThrow(/^(UNSAFE|INVALID)_TEST_DATABASE_URL$/);
  });
});
