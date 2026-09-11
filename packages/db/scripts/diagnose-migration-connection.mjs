import pg from "pg";

const { Client } = pg;
const connectionString = process.env.DIRECT_DATABASE_URL;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function logError(message) {
  process.stderr.write(`${message}\n`);
}

function printError(error) {
  const details = [
    ["name", error?.name],
    ["message", error?.message],
    ["code", error?.code],
    ["errno", error?.errno],
    ["syscall", error?.syscall],
  ]
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");

  logError(`::error title=Supabase migration connection check failed::${details}`);
}

if (!connectionString) {
  logError(
    "::error title=Supabase migration configuration failed::DIRECT_DATABASE_URL is not configured in the production-release environment.",
  );
  process.exit(1);
}

let target;

try {
  target = new URL(connectionString);
} catch {
  logError(
    "::error title=Supabase migration configuration failed::DIRECT_DATABASE_URL is not a valid PostgreSQL connection URL.",
  );
  process.exit(1);
}

if (!["postgres:", "postgresql:"].includes(target.protocol)) {
  logError(
    "::error title=Supabase migration configuration failed::DIRECT_DATABASE_URL must use the postgres or postgresql protocol.",
  );
  process.exit(1);
}

log(
  `Migration target accepted (host=${target.hostname}, port=${target.port || "5432"}, sslmode=${target.searchParams.get("sslmode") || "not set"}).`,
);

const client = new Client({
  connectionString,
  connectionTimeoutMillis: 15_000,
});

try {
  await client.connect();
  await client.query("select 1");
  log("Migration database connectivity check passed.");
} catch (error) {
  printError(error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
