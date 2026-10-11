import { pathToFileURL } from "node:url";

const [path, route] = process.argv.slice(2);
const { default: entry } = await import(pathToFileURL(path).href);
const request = () => new Request(`https://fixture.example/api/v1/${route}`);
const disabled = await entry.fetch(request());
if (disabled.status !== 503 || (await disabled.json()).errorCode !== "NODE_EXECUTION_DISABLED")
  throw new Error("NODE_DISABLED_BOUNDARY_FAILED");

// Only synthetic values are used; unsigned requests must fail before any network access.
const material = Buffer.from("fixture-key-material-not-a-secret-0001").toString("base64");
Object.assign(process.env, {
  COLLECTOR_NODE_ENABLED: "true",
  COLLECTOR_ENVIRONMENT: "staging",
  COLLECTOR_EXECUTOR_VERSION: "1",
  COLLECTOR_CONFIG_VERSION: "1",
  COLLECTOR_PROMPT_VERSION: "1",
  COLLECTOR_SCHEMA_VERSION: "1",
  COLLECTOR_COUNT_VERSION: "1",
  COLLECTOR_CHUNKER_VERSION: "1",
  GEMINI_MODEL_PRIMARY: "fixture-primary",
  GEMINI_MODEL_FALLBACK: "fixture-fallback",
  GEMINI_API_KEY: "fixture-api-key",
  COLLECTOR_NODE_AUTH_KEYS: JSON.stringify({ fixture: material }),
  COLLECTOR_CURSOR_KEY: material,
  COLLECTOR_GATE_ORIGIN: "https://control.fixture.example",
  COLLECTOR_GATE_KEY_ID: "fixture",
  COLLECTOR_GATE_KEY: material,
  DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/upto_collector_test",
});
const unsigned = await entry.fetch(request());
if (unsigned.status !== 401 || (await unsigned.json()).errorCode !== "AUTH_HEADERS_INVALID")
  throw new Error("NODE_AUTH_BOUNDARY_FAILED");
