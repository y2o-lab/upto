import { expect, it } from "vitest";

import { readNodeEnvironment, nodeExecutionEnabled } from "./environment.js";
const material = Buffer.from("fixture-key-material-not-a-secret-0001").toString("base64");
function environment(): NodeJS.ProcessEnv {
  return {
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
    COLLECTOR_NODE_AUTH_KEYS: JSON.stringify({ old: material, new: material }),
    COLLECTOR_CURSOR_KEY: material,
    COLLECTOR_GATE_ORIGIN: "https://control.fixture.example",
    COLLECTOR_GATE_KEY_ID: "fixture",
    COLLECTOR_GATE_KEY: material,
    DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:55439/upto_collector_test",
  };
}
it("requires explicit versions and secrets and supports two key IDs during rotation", () => {
  const value = readNodeEnvironment(environment());
  expect(value.config.environment).toBe("staging");
  expect(value.config.keys.size).toBe(2);
  expect(value.databasePoolMax).toBe(2);
  expect(value.config.chunkChars).toBe(12000);
});
it("fails with a static message without exposing bad values", () => {
  for (const changed of [
    { DATABASE_URL: "fixture-private-token" },
    { COLLECTOR_GATE_ORIGIN: "http://remote.fixture.example?token=fixture" },
    { COLLECTOR_NODE_AUTH_KEYS: "fixture-private-token" },
    { COLLECTOR_GATE_KEY: "not-base64" },
    { COLLECTOR_EXECUTOR_VERSION: undefined },
    { COLLECTOR_DATABASE_POOL_MAX: "50" },
    { COLLECTOR_CURSOR_KEY: Buffer.from("short").toString("base64") },
  ])
    expect(() => readNodeEnvironment({ ...environment(), ...changed })).toThrow(
      "NODE_CONFIGURATION_INVALID",
    );
});
it("keeps Node execution disabled until explicitly enabled", () => {
  expect(nodeExecutionEnabled({})).toBe(false);
  expect(nodeExecutionEnabled({ COLLECTOR_NODE_ENABLED: "true" })).toBe(true);
  expect(() => nodeExecutionEnabled({ COLLECTOR_NODE_ENABLED: "yes" })).toThrow(
    "NODE_CONFIGURATION_INVALID",
  );
});
