// Kept separate from production clients: never fall back to DATABASE_URL.
export function localTestDatabaseUrl(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "postgres://upto_test:upto_test@127.0.0.1:55439/upto_collector_test");
  } catch {
    throw new Error("INVALID_TEST_DATABASE_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.pathname !== "/upto_collector_test" ||
    url.hash !== "" ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    url.searchParams.getAll("sslmode").length > 1 ||
    (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "disable")
  ) {
    throw new Error("UNSAFE_TEST_DATABASE_URL");
  }
  return url;
}
